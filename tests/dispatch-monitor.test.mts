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
