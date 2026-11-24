import assert from "node:assert/strict";
import test from "node:test";
import { createDispatchMonitor, dispatchOverview } from "../src/execution/dispatch-monitor.mts";

test("概览按状态与时间合并本机和远端工单，保留最新完成的工单", () => {
  const local = [{ id: "old-local", status: "ready" as const, finishedAt: 1 },
    { id: "new-local", status: "ready" as const, finishedAt: 9 }];
  const remote = Array.from({ length: 8 }, (_, index) => ({ id: `remote-${index}`, status: "ready" as const, finishedAt: 10 - index }));
  const pending = { id: "waiting", status: "running" as const, queuedAt: 0 };
  assert.deepEqual(dispatchOverview(local, [pending, ...remote]).map(job => job.id),
    ["waiting", "remote-0", "new-local", "remote-1", "remote-2", "remote-3"]);
});

test("保存的调度快照不随连接和结束而变化", () => {
  const monitor = createDispatchMonitor("本机");
  const session = monitor.begin({ title: "工单", task: "核对快照" });
  const before = monitor.snapshot().hosts[0]?.active[0];
  session.connected("fixture-thread");
  const connected = monitor.snapshot().hosts[0]?.active[0];
  session.finish("completed");
  const finished = monitor.snapshot().hosts[0]?.recent[0];

  assert.equal(before?.status, "connecting");
  assert.equal(before?.threadId, undefined);
  assert.equal(connected?.status, "running");
  assert.equal(connected?.threadId, "fixture-thread");
  assert.equal(finished?.status, "completed");
});

test("修改快照内的活动和历史记录不会改写监视器状态", () => {
  const monitor = createDispatchMonitor("本机");
  const session = monitor.begin({ title: "原工单", task: "核对快照" });
  const active = monitor.snapshot().hosts[0]?.active[0];
  assert.ok(active);
  active.title = "调用方修改";
  assert.equal(monitor.snapshot().hosts[0]?.active[0]?.title, "原工单");

  session.finish("completed");
  const recent = monitor.snapshot().hosts[0]?.recent[0];
  assert.ok(recent);
  recent.status = "failed";
  assert.equal(monitor.snapshot().hosts[0]?.recent[0]?.status, "completed");
});

test("远端核验工单按目标设备展示，同一工单保留回执进度并在完成后进入近期概览", async () => {
  const { remoteJobStatus, remoteTopologyJobs } = await import(
    new URL("../src/workbench/public/remote-workers.mjs", import.meta.url).href
  );
  const target = { id: "device-a", name: "设备 A" };
  const other = { id: "device-b", name: "设备 B", status: "online" };
  const files = ["a", "b", "c"].map(name => ({ path: `docs/${name}.md`, sha256: name.repeat(64), bytes: 12 }));
  const receipts = files.map(({ sha256, bytes }) => ({ sha256, bytes, headings: 1 }));
  const job = { id: "remote-job", deviceId: target.id, deviceName: target.name, revision: "0".repeat(40), files, queuedAt: 1 };
  const queued = { ...job, status: "queued" as const, receipts: [] };
  const claimed = { ...job, status: "running" as const, receipts: [] };
  const partial = { ...claimed, receipts: receipts.slice(0, 1) };
  const finished = { ...job, status: "ready" as const, receipts, finishedAt: 2 };

  const waiting = { id: job.id, status: "queued", linkState: "idle", label: "等待领取", task: "文件核验 · 0/3" };
  const checking = { ...waiting, status: "running", linkState: "running", label: "正在核验" };
  const received = { ...checking, task: "文件核验 · 1/3" };
  const reconnecting = { ...received, status: "interrupted", linkState: "interrupted", label: "等待重连" };
  const pending = { deviceStatus: "pending", current: queued, expected: [waiting] };
  const offline = { deviceStatus: "offline", current: queued, expected: [waiting] };
  const progressing = { deviceStatus: "online", current: partial, expected: [received] };
  const disconnected = { deviceStatus: "offline", current: partial, expected: [reconnecting] };
  const snapshots = [pending, pending, offline, offline,
    { deviceStatus: "online", current: claimed, expected: [checking] },
    progressing, progressing, disconnected, disconnected, progressing,
    { deviceStatus: "online", current: finished, expected: [] },
  ];

  for (const [index, { deviceStatus, current, expected }] of snapshots.entries()) {
    const devices = [{ ...target, status: deviceStatus }, other];
    const jobs = [{ ...current, deviceStatus }];
    const topology = devices.map(device => remoteTopologyJobs(jobs, device.id, device.status === "online"));
    assert.deepEqual(topology, [expected, []], `第 ${index + 1} 份快照的设备 A 和设备 B`);
  }

  const overview = dispatchOverview([], [finished]);
  assert.deepEqual(overview.map(item => [item.id, remoteJobStatus(item)]), [[job.id, "核验通过"]]);
});
