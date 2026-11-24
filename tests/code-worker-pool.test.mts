import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { BusinessEvent, Checkpoint } from "../src/audit/activity-store.mts";
import { readCodeWorkerConfig } from "../src/config/runtime.mts";
import { createCodeWorkerPool, type WorkerAttempt } from "../src/execution/code-worker-pool.mts";
import { contentDigest, readCodeOffer, readWorkerCapacity, type CodeOffer, type CodeWork } from "../src/execution/code-worker-protocol.mts";

const repo = "owner/repository";
const first = { id: "00000000-0000-0000-0000-000000000001", name: "第一台 Mac", instance: randomUUID(), repo, slots: 1, ready: true };
const second = { ...first, id: "00000000-0000-0000-0000-000000000002", name: "第二台 Mac", instance: randomUUID() };
const digest = contentDigest("approval");
const revalidate = async () => {};
const work: CodeWork = {
  repo, issue: 10, issueRevision: digest, revision: "b".repeat(40), upstream: ["a".repeat(40)],
  plan: { flowId: randomUUID(), version: 2, flowDigest: digest, batchDigest: digest },
  files: [{ path: "src/worker.mts", sha256: digest }],
  instructions: "修复已批准的问题。", context: JSON.stringify({ editableFiles: [] }),
};

function database() {
  const stored = new Map<string, WorkerAttempt>();
  const audit: BusinessEvent[] = [];
  const checkpoint: Checkpoint<WorkerAttempt> = {
    load: () => [...stored.values()],
    save(id, row, event) {
      stored.set(id, row);
      if (event) audit.push(event);
      return true;
    },
  };
  return { checkpoint, audit };
}

test("主机将两张同时可做的工单推给不同设备，拒绝跨设备回执并记录开工与测试", async t => {
  const { checkpoint, audit } = database();
  const pool = createCodeWorkerPool(checkpoint, new Set([first.id, second.id]));
  t.after(pool.close);
  const signal = new AbortController().signal;
  const waitFirst = pool.poll(first, signal);
  const waitSecond = pool.poll(second, signal);
  const threads: string[] = [];
  const executeFirst = pool.execute(work, signal, 1000, thread => threads.push(thread), revalidate);
  const executeSecond = pool.execute({ ...work, issue: 11 }, signal, 1000, thread => threads.push(thread), revalidate);
  const pair = await Promise.all([waitFirst, waitSecond]);
  const offers: CodeOffer[] = pair.flatMap(item => item.status === 200 && item.offer ? [item.offer] : []);
  assert.deepEqual(offers.map(offer => offer.work.issue), [10, 11]);
  const [offerA, offerB] = offers;
  assert.ok(offerA && offerB);
  assert.equal(readCodeOffer({ ...offerA, work: { ...work, revision: "c".repeat(40) } }), undefined);
  for (const [index, offer] of offers.entries()) {
    const [device, other] = index === 0 ? [first, second] : [second, first];
    const receipt = { id: offer.id, digest: offer.digest, at: 100 };
    assert.equal(pool.receipt(other, { ...receipt, phase: "accepted" }), 409);
    assert.equal(pool.receipt(device, { ...receipt, phase: "started", thread: "early" }), 409);
    assert.equal(pool.receipt(device, { ...receipt, phase: "accepted" }), 200);
    assert.equal(pool.receipt(device, { ...receipt, phase: "accepted" }), 200);
    assert.equal(pool.receipt(device, { ...receipt, phase: "started", thread: `thread-${index}` }), 200);
    assert.equal(pool.receipt(device, { ...receipt, phase: "tested", output: "{}", patch: digest }), 200);
  }
  assert.deepEqual((await Promise.all([executeFirst, executeSecond])).map(result => result.phase), ["tested", "tested"]);
  assert.deepEqual(threads, ["thread-0", "thread-1"]);
  assert.deepEqual(pool.snapshot().devices.map(device => [device.id, device.count]), [[first.id, 0], [second.id, 0]]);
  assert.deepEqual(audit.map(event => (event.details as { action: string }).action),
    ["offered", "offered", "accepted", "started", "tested", "accepted", "started", "tested"]);
  assert.ok(!JSON.stringify(audit).includes('"output"'));
});

test("断线后只向原设备重发未确认工单，主机重启后不把状态未明的工单交给其他设备", async t => {
  const { checkpoint, audit } = database();
  const pool = createCodeWorkerPool(checkpoint, new Set([first.id, second.id]));
  t.after(pool.close);
  const signal = new AbortController().signal;
  const waiter = pool.poll(first, signal);
  const pending = assert.rejects(pool.execute(work, signal, 1000, () => {}, revalidate), { reason: "needs-reconciliation" });
  const delivery = await waiter;
  assert.ok(delivery.status === 200 && delivery.offer);
  const { id, digest } = delivery.offer;
  const replay = await pool.poll(first, signal);
  assert.deepEqual(replay, delivery);
  assert.equal(pool.receipt(first, { id, digest, at: 100, phase: "accepted" }), 200);
  pool.close();
  await pending;
  const restarted = createCodeWorkerPool(checkpoint, new Set([first.id, second.id]));
  t.after(restarted.close);
  // 接收记录可能已落库但设备没拿到应答。租约结束后不能靠原回执继续开工。
  assert.equal(restarted.receipt(first, { id, digest, at: 100, phase: "accepted" }), 410);
  assert.equal(restarted.receipt(first, { id, digest, at: 101, phase: "started", thread: "stale" }), 410);
  assert.equal(restarted.snapshot().attempts[0]?.state, "interrupted");
  assert.equal(audit.filter(event => (event.details as { action: string }).action === "offered").length, 1);
});

test("满载设备仅上报在线，空闲设备才会收到工单", async t => {
  const pool = createCodeWorkerPool(database().checkpoint, new Set([first.id, second.id]));
  t.after(pool.close);
  const full = new AbortController();
  const waiting = pool.poll({ ...first, ready: false }, full.signal);
  const spare = pool.poll(second, new AbortController().signal);
  const result = assert.rejects(pool.execute(work, full.signal, 1000, () => {}, revalidate), { reason: "needs-reconciliation" });
  const delivery = await spare;
  assert.ok(delivery.status === 200 && delivery.offer);
  full.abort();
  assert.deepEqual(await waiting, { status: 200, offer: null });
  await result;
  assert.equal(pool.snapshot().attempts[0]?.device, second.id);
});

test("设备就绪时重新检查授权，工单改动后不会发给设备", async t => {
  const pool = createCodeWorkerPool(database().checkpoint, new Set([first.id]));
  t.after(pool.close);
  const controller = new AbortController();
  const rejected = assert.rejects(pool.execute(work, controller.signal, 1000, () => {},
    async () => { throw Error("Issue 已改派"); }), { message: "Issue 已改派" });
  const waiting = pool.poll(first, controller.signal);
  await rejected;
  assert.deepEqual(pool.snapshot().attempts, []);
  controller.abort();
  assert.deepEqual(await waiting, { status: 200, offer: null });
});

test("双机通信使用注入的离线时间、执行位和上下文限制", async t => {
  const config = readCodeWorkerConfig({
    SOULFLOW_CODE_WORKER_WAIT_MS: "100", SOULFLOW_CODE_WORKER_HTTP_TIMEOUT_MS: "180",
    SOULFLOW_CODE_WORKER_OFFLINE_MS: "250", SOULFLOW_CODE_WORKER_MAX_SLOTS: "1",
    SOULFLOW_CODE_WORKER_ACTIVITY_MS: "400", SOULFLOW_CODE_WORKER_MAX_UPSTREAM: "0",
  });
  assert.throws(() => readCodeWorkerConfig({ SOULFLOW_CODE_WORKER_WAIT_MS: "25000" }), /SOULFLOW_CODE_WORKER_HTTP_TIMEOUT_MS/);
  assert.equal(readWorkerCapacity({ ...first, version: 1, slots: 2 }, config.maxSlots), undefined);
  let now = 1000;
  const pool = createCodeWorkerPool(database().checkpoint, new Set([first.id]), config, () => now);
  t.after(pool.close);
  const signal = new AbortController().signal;
  const waiting = pool.poll(first, signal);
  await assert.rejects(pool.execute(work, signal, 1000, () => {}, revalidate), /工单上下文无效/);
  assert.deepEqual(await waiting, { status: 200, offer: null });
  assert.equal(pool.snapshot().activityMs, 400);
  assert.equal(pool.snapshot().devices[0]?.online, true);
  now += 251;
  assert.equal(pool.snapshot().devices[0]?.online, false);
});
