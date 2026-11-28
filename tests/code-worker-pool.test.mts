import assert from "node:assert/strict";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import type { Readable, Writable } from "node:stream";
import test from "node:test";
import type { BusinessEvent, Checkpoint } from "../src/audit/activity-store.mts";
import { codeEditFileBytes, legacyCodeEditFileBytes, readCodeWorkerConfig } from "../src/config/runtime.mts";
import { createCodeWorkerPool, type WorkerAttempt } from "../src/execution/code-worker-pool.mts";
import { probeCodeDeviceLogin } from "../src/execution/code-device-login.mts";
import { contentDigest, readCodeOffer, readCodeReceipt, readWorkerCapacity, workerProtocolVersion, type CodeOffer, type CodeWork } from "../src/execution/code-worker-protocol.mts";
import { createRemoteHandoff, type RemoteDevice, type RemoteJob } from "../src/execution/remote-handoff.mts";
import { handleCodeWorkerRequest } from "../src/workbench/code-worker-http.mts";

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

test("AC-3 设备自检只核对已许可的凭据，保留新设备与现有设备的正常实例", async t => {
  const devices = new Map<string, RemoteDevice>();
  const handoff = createRemoteHandoff({ load: () => [...devices.values()], save(id, device) { devices.set(id, device); return true; } },
    { load: (): RemoteJob[] => [], save: () => true }, 1000);
  const enrolled = handoff.addDevice("已许可设备", "owner");
  assert.equal(enrolled.status, 201);
  if (enrolled.status !== 201) return;
  const { id, key } = enrolled.bundle;
  const allowed = new Set<string>();
  const config = readCodeWorkerConfig({ SOULFLOW_CODE_WORKER_WAIT_MS: "100" });
  const pool = createCodeWorkerPool(database().checkpoint, allowed, config);
  t.after(pool.close);
  const server = createServer((req, res) => { void handleCodeWorkerRequest(req, res, pool, handoff); });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const endpoint = `http://127.0.0.1:${address.port}/v1/code-workers/${id}`;
  const auth = { Authorization: `Bearer ${key}` };
  assert.equal((await fetch(`${endpoint}/check`, { headers: auth })).status, 403);
  allowed.add(id);
  assert.equal((await fetch(`${endpoint}/check`)).status, 401);
  assert.equal((await fetch(`${endpoint}/check`, { headers: { ...auth, Origin: endpoint } })).status, 415);
  assert.equal((await fetch(`${endpoint}/check`, { headers: auth })).status, 200);
  assert.equal(devices.get(id)?.instance, undefined);

  const instance = randomUUID();
  const wait = () => fetch(`${endpoint}/wait`, { method: "POST", headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({ version: workerProtocolVersion, instance, repo, slots: 1, ready: false }) });
  assert.equal((await wait()).status, 200);
  assert.equal(devices.get(id)?.instance, instance);
  assert.equal((await fetch(`${endpoint}/check`, { headers: auth })).status, 200);
  assert.equal(devices.get(id)?.instance, instance);
  assert.equal((await wait()).status, 200);
});

test("AC-3 连续探测超时各自回收进程，登录恢复后才返回就绪", async () => {
  const hungProbe = "process.on('SIGTERM', () => {}); process.stdin.resume();";
  const loginProbe = (type: string) => `require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
    const msg = JSON.parse(line);
    if (msg.id === 1) console.log(JSON.stringify({ id: 1, result: {} }));
    if (msg.id === 2) console.log(JSON.stringify({ id: 2, result: { account: { type: ${JSON.stringify(type)} } } }));
  });`;
  const children: ChildProcessByStdio<Writable, Readable, null>[] = [];
  const probe = (code: string, ms: number) => probeCodeDeviceLogin(AbortSignal.timeout(ms), () => {
    const child = spawn(process.execPath, ["-e", code], { stdio: ["pipe", "pipe", "ignore"] });
    children.push(child);
    return child;
  });
  for (let index = 0; index < 2; index++) {
    assert.equal(await probe(hungProbe, 100), false);
    assert.equal(children[index]?.signalCode, "SIGKILL");
  }
  assert.equal(await probe(loginProbe("apiKey"), 2000), false);
  assert.equal(await probe(loginProbe("chatgpt"), 2000), true);
  assert.ok(children.every(child => child.exitCode !== null || child.signalCode !== null));
});

test("AC-3 同一设备未就绪或满载时无新任务，恢复空位后继续接单", async t => {
  const config = readCodeWorkerConfig({ SOULFLOW_CODE_WORKER_WAIT_MS: "100" });
  const { checkpoint, audit } = database();
  const pool = createCodeWorkerPool(checkpoint, new Set([first.id]), config);
  const stop = new AbortController();
  t.after(() => { stop.abort(); pool.close(); });
  const waiting = pool.execute(work, stop.signal, 2000, () => {}, revalidate);
  assert.deepEqual(await pool.poll({ ...first, ready: false }, stop.signal), { status: 200, offer: null });
  assert.equal(checkpoint.load().length, 0);
  const offered = await pool.poll(first, stop.signal);
  assert.ok(offered.status === 200 && offered.offer);

  const next = pool.execute({ ...work, issue: 11 }, stop.signal, 2000, () => {}, revalidate);
  const complete = (offer: CodeOffer) => {
    const base = { id: offer.id, digest: offer.digest, at: 100 };
    assert.equal(pool.receipt(first, { ...base, phase: "accepted" }), 200);
    assert.equal(pool.receipt(first, { ...base, phase: "started", thread: `thread-${offer.work.issue}` }), 200);
    assert.equal(pool.receipt(first, { ...base, phase: "tested", output: "完成", patch: contentDigest("完成") }), 200);
  };
  assert.deepEqual(await pool.poll({ ...first, ready: false }, stop.signal), { status: 200, offer: null });
  assert.equal(checkpoint.load().length, 1);
  complete(offered.offer);
  await waiting;
  const resumed = await pool.poll(first, stop.signal);
  assert.ok(resumed.status === 200 && resumed.offer);
  assert.equal(resumed.offer.work.issue, 11);
  complete(resumed.offer);
  await next;
  assert.equal(audit.filter(event => (event.details as { action?: string })?.action === "offered").length, 2);
});

test("设备恢复次数只在派发记录落库后确认", async t => {
  const { checkpoint } = database();
  const pool = createCodeWorkerPool(checkpoint, new Set([first.id]));
  const stop = new AbortController();
  t.after(() => { stop.abort(); pool.close(); });
  let recorded = false;
  const waiting = pool.poll(first, stop.signal);
  const execution = pool.execute(work, stop.signal, 2000, () => {}, revalidate, undefined, attemptId => {
    recorded = true;
    assert.equal(checkpoint.load()[0]?.id, attemptId);
    assert.equal(checkpoint.load()[0]?.state, "offered");
  });
  const result = await waiting;
  assert.ok(result.status === 200 && result.offer);
  assert.equal(recorded, true);
  assert.equal(pool.receipt(first, { id: result.offer.id, digest: result.offer.digest, at: Date.now(), phase: "accepted" }), 200);
  assert.equal(pool.receipt(first, { id: result.offer.id, digest: result.offer.digest, at: Date.now(), phase: "started", thread: "thread" }), 200);
  assert.equal(pool.receipt(first, { id: result.offer.id, digest: result.offer.digest, at: Date.now(), phase: "tested", output: "ok", patch: contentDigest("patch") }), 200);
  await execution;
});

test("恢复回执落库失败会撤销未发送的 offer 并释放设备位", async t => {
  const storage = database();
  const checkpoint: Checkpoint<WorkerAttempt> = { load: storage.checkpoint.load, save(id, row, event) {
    if (row.state === "cancelled") return false;
    return storage.checkpoint.save(id, row, event);
  } };
  const previous: WorkerAttempt = { id: randomUUID(), device: first.id, name: first.name, instance: first.instance,
    repo, issue: work.issue, revision: work.revision, digest, issueRevision: work.issueRevision, flowId: work.plan.flowId,
    state: "failed", assignedAt: 1, updatedAt: 2, plan: work.plan, slots: first.slots, assignedLoad: 0, weight: 1,
    files: work.files, receipt: { digest, at: 2, failureStage: "tests" } };
  assert.equal(checkpoint.save(previous.id, previous), true);
  const pool = createCodeWorkerPool(checkpoint, new Set([first.id]));
  const stop = new AbortController();
  t.after(() => { stop.abort(); pool.close(); });
  const waiting = pool.poll(first, stop.signal);
  await assert.rejects(pool.execute(work, stop.signal, 2000, () => {}, revalidate, undefined, () => {
    throw Error("模拟工单恢复状态写库失败");
  }), /模拟工单恢复状态写库失败/);
  assert.equal(checkpoint.load().find(attempt => attempt.id !== previous.id)?.state, "offered");
  assert.equal(pool.snapshot().attempts.find(attempt => attempt.id !== previous.id)?.state, "cancelled");
  assert.equal(pool.failedAttempt(work)?.id, previous.id);

  const next = pool.execute({ ...work, issue: 11 }, stop.signal, 2000, () => {}, revalidate);
  const result = await waiting;
  assert.ok(result.status === 200 && result.offer);
  assert.equal(result.offer.work.issue, 11);
  assert.equal(pool.receipt(first, { id: result.offer.id, digest: result.offer.digest, at: Date.now(), phase: "accepted" }), 200);
  assert.equal(pool.receipt(first, { id: result.offer.id, digest: result.offer.digest, at: Date.now(), phase: "started", thread: "thread" }), 200);
  assert.equal(pool.receipt(first, { id: result.offer.id, digest: result.offer.digest, at: Date.now(), phase: "tested", output: "ok", patch: contentDigest("patch") }), 200);
  await next;
});

test("等待设备不消耗已派发任务的执行和失败回执宽限", async t => {
  const config = readCodeWorkerConfig({ SOULFLOW_CODE_WORKER_RECEIPT_GRACE_MS: "1000" });
  const pool = createCodeWorkerPool(database().checkpoint, new Set([first.id]), config);
  const stop = new AbortController();
  t.after(() => { stop.abort(); pool.close(); });
  const execution = pool.execute(work, stop.signal, 100, () => {}, revalidate);
  await new Promise(resolve => setTimeout(resolve, 50));
  const delivery = await pool.poll(first, stop.signal);
  assert.ok(delivery.status === 200 && delivery.offer);
  assert.equal(pool.receipt(first, { id: delivery.offer.id, digest: delivery.offer.digest, at: 101, phase: "accepted" }), 200);
  await new Promise(resolve => setTimeout(resolve, 75));
  assert.equal(pool.receipt(first, { id: delivery.offer.id, digest: delivery.offer.digest, at: 201, phase: "failed",
    failureStage: "tests", isolation: { step: "quality", outcome: "timeout" } }), 200);
  assert.equal((await execution).phase, "failed");
});

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

test("只有最近一条与原审批匹配的设备失败回执可用于恢复", async t => {
  const { checkpoint, audit } = database();
  const devices = new Set([first.id]);
  const pool = createCodeWorkerPool(checkpoint, devices);
  t.after(pool.close);
  const signal = new AbortController().signal;
  const waiting = pool.poll(first, signal);
  const candidatePatch = "diff --git a/src/worker.mts b/src/worker.mts\n--- a/src/worker.mts\n+++ b/src/worker.mts\n";
  const pending = pool.execute(work, signal, 1000, () => {}, revalidate, receipt => receipt.candidatePatch === candidatePatch);
  const delivery = await waiting;
  assert.ok(delivery.status === 200 && delivery.offer);
  const { id, digest } = delivery.offer;
  assert.equal(pool.receipt(first, { id, digest, at: 100, phase: "accepted" }), 200);
  const isolation = { step: "quality", outcome: "exit", exitCode: 2,
    diagnostics: ["src/example.mts:3:4 TS2322"] } as const;
  const [authorizedFile] = work.files;
  assert.ok(authorizedFile);
  const candidateFiles = [{ path: authorizedFile.path, before: authorizedFile.sha256, after: contentDigest("updated"), mode: 0o100644 as const }];
  const candidateDigest = contentDigest(JSON.stringify(candidateFiles));
  const failure = readCodeReceipt({ id, digest, at: 101, phase: "failed", failureStage: "tests",
    isolation, candidateDigest, candidateFiles, candidatePatch, candidatePatchDigest: contentDigest(candidatePatch) });
  assert.ok(failure?.phase === "failed");
  assert.doesNotMatch(JSON.stringify(failure), /ghp_12345678901234567890/);
  assert.equal(failure.isolation?.diagnostics?.length, 1);
  assert.equal(readCodeReceipt({ ...failure, failureStage: "external error" }), undefined);
  assert.equal(readCodeReceipt({ ...failure, candidateDigest: "invalid" }), undefined);
  assert.equal(readCodeReceipt({ ...failure, isolation: { ...isolation, outcome: "timeout" } }), undefined);
  assert.equal(readCodeReceipt({ ...failure, isolation: { ...isolation,
    diagnostics: ["src/secret.mts:4:5 TS2345 Authorization: Bearer ghp_12345678901234567890"] } }), undefined);
  assert.equal(readCodeReceipt({ ...failure, candidateFiles: [{ ...candidateFiles[0], path: "src/unauthorized.mts" }] }), undefined);
  assert.equal(readCodeReceipt({ ...failure, candidateFiles: [{ ...candidateFiles[0], before: "f".repeat(64) }] }), undefined);
  assert.equal(readCodeReceipt({ ...failure, candidatePatch: "raw output" }), undefined);
  assert.equal(readCodeReceipt({ ...failure, candidateFiles: [{ ...candidateFiles[0], extra: "sensitive payload" }] }), undefined);
  assert.equal(readCodeReceipt({ ...failure, failureStage: undefined }), undefined);
  assert.equal(readCodeReceipt({ ...failure, failureStage: undefined, isolation: undefined, candidateDigest: undefined,
    candidateFiles: undefined, candidatePatch: undefined, candidatePatchDigest: undefined })?.phase, "failed");
  assert.equal(pool.receipt(first, failure), 200);
  const auditCount = audit.length;
  assert.equal(pool.receipt(first, failure), 200);
  assert.equal(audit.length, auditCount);
  assert.equal((await pending).phase, "failed");
  assert.equal(checkpoint.load()[0]?.receipt?.failureStage, "tests");
  assert.equal(checkpoint.load()[0]?.receipt?.isolation?.diagnostics?.length, 1);
  assert.equal(checkpoint.load()[0]?.receipt?.candidateDigest, candidateDigest);
  assert.equal((pool.snapshot().attempts[0]?.receipt as { candidatePatch?: string } | undefined)?.candidatePatch, undefined);
  assert.equal((audit.at(-1)?.details as { failureStage?: string } | undefined)?.failureStage, "tests");
  assert.doesNotMatch(JSON.stringify(audit), /ghp_12345678901234567890/);
  assert.doesNotMatch(JSON.stringify(audit), /diff --git/);
  pool.close();

  const restarted = createCodeWorkerPool(checkpoint, devices);
  t.after(restarted.close);
  assert.equal(restarted.failedAttempt(work)?.id, id);
  assert.deepEqual(restarted.failedAttempt(work)?.candidateFiles, candidateFiles);
  assert.equal(restarted.failedAttempt(work)?.candidatePatch, candidatePatch);
  assert.equal(restarted.hasAttempt(repo, work.issue), true);
  assert.equal(restarted.snapshot().attempts[0]?.receipt?.isolation?.diagnostics?.length, 1);
  assert.equal(audit.filter(event => (event.details as { action?: string })?.action === "offered").length, 1);
  for (const scope of [{ ...work, repo: "other/repo" }, { ...work, issue: 11 }, { ...work, issueRevision: "f".repeat(64) },
    ...Object.keys(work.plan).map(key => ({ ...work, plan: { ...work.plan, [key]: key === "version" ? 3 : "changed" } }))]) {
    assert.equal(restarted.failedAttempt(scope), undefined);
  }

  const later = { ...work, plan: { ...work.plan, version: 3 } };
  const again = restarted.poll(first, signal);
  const next = assert.rejects(restarted.execute(later, signal, 1000, () => {}, revalidate), { reason: "needs-reconciliation" });
  const newer = await again;
  assert.ok(newer.status === 200 && newer.offer);
  assert.equal(restarted.failedAttempt(work), undefined);
  restarted.close();
  await next;
  assert.equal(restarted.failedAttempt(later), undefined);
});

test("失败诊断按检查阶段匹配，派发上下文可携带已校验的上一份候选补丁", () => {
  const id = randomUUID();
  const candidate = "diff --git a/src/worker.mts b/src/worker.mts\n";
  const retryWork = { ...work, previousCandidatePatch: { patch: candidate, sha256: contentDigest(candidate) } };
  const offer = { version: workerProtocolVersion, id, digest: contentDigest(JSON.stringify(retryWork)), work: retryWork };
  assert.equal(readCodeOffer(offer)?.work.previousCandidatePatch?.patch, candidate);
  const invalidWork = { ...retryWork, previousCandidatePatch: { patch: "unverified", sha256: contentDigest(candidate) } };
  assert.equal(readCodeOffer({ ...offer, work: invalidWork, digest: contentDigest(JSON.stringify(invalidWork)) }), undefined);
  assert.ok(readCodeReceipt({ id, digest, at: 101, phase: "failed", failureStage: "dependencies",
    isolation: { step: "dependencies", outcome: "exit", exitCode: 1 } })?.phase === "failed");
  assert.equal(readCodeReceipt({ id, digest, at: 101, phase: "failed", failureStage: "tests",
    isolation: { step: "dependencies", outcome: "exit", exitCode: 1 } }), undefined);
});

test("合法的恢复补丁独立计量，不挤占最大源码上下文预算", () => {
  const config = readCodeWorkerConfig();
  const largeContext = JSON.stringify({ editableFiles: [{ path: "src/large.mts", text: "x".repeat(864_500) }] });
  const patch = `diff --git a/before/src/large.mts b/after/src/large.mts\n${"x".repeat(108_900)}`;
  const largeWork: CodeWork = { ...work, files: Array.from({ length: 15 }, (_, index) => ({
    path: `src/file-${String(index).padStart(2, "0")}.mts`, sha256: digest, bytes: 52_800,
  })), context: largeContext, previousCandidatePatch: { patch, sha256: contentDigest(patch) } };
  const offer = { version: workerProtocolVersion, id: randomUUID(), digest: contentDigest(JSON.stringify(largeWork)), work: largeWork };
  assert.ok(Buffer.byteLength(largeContext) < config.maxContextBytes);
  assert.ok(Buffer.byteLength(JSON.stringify({ offer })) < config.messageBytes);
  assert.ok(readCodeOffer(offer, config));
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

test("AC-3 只选择所属成员的设备，受理前缺少授权、所有者不符或撤销均不推进尝试", async t => {
  const savedDevices = new Map<string, RemoteDevice>();
  const handoff = createRemoteHandoff({ load: () => [...savedDevices.values()], save(id, row) {
    savedDevices.set(id, row);
    return true;
  } }, { load: (): RemoteJob[] => [], save: () => true }, 1000);
  const pending = handoff.startPairing("新人 Mac", "alice");
  assert.ok(pending.status === 201);
  const enrolled = handoff.confirmPairing(pending.code, "alice");
  assert.ok(enrolled.status === 201);
  const device = { ...first, id: enrolled.bundle.id };
  const allow = new Set([device.id]);
  const { checkpoint, audit } = database();
  const config = readCodeWorkerConfig({ SOULFLOW_CODE_WORKER_WAIT_MS: "100" });
  let claimedBy: string | undefined = "bob";
  const pool = createCodeWorkerPool(checkpoint, allow, config, Date.now,
    event => { audit.push(event); return true; }, (id, repository, issue, flowId) =>
      repository === repo && [work.issue, work.issue + 1].includes(issue) && flowId === work.plan.flowId
      && claimedBy !== undefined && handoff.ownsDevice(id, claimedBy));
  const stop = new AbortController();
  t.after(() => { stop.abort(); pool.close(); });
  const started: string[] = [];
  const firstTask = pool.execute(work, stop.signal, 2000, thread => started.push(thread), revalidate);
  assert.deepEqual(await pool.poll(device, stop.signal), { status: 200, offer: null });
  assert.deepEqual(checkpoint.load(), []);
  claimedBy = "alice";
  const firstDelivery = await pool.poll(device, stop.signal);
  assert.ok(firstDelivery.status === 200 && firstDelivery.offer);
  const initial = { id: firstDelivery.offer.id, digest: firstDelivery.offer.digest, at: 100 };
  assert.equal(pool.receipt(device, { ...initial, phase: "accepted" }), 200);
  assert.equal(pool.receipt(device, { ...initial, phase: "accepted" }), 200);
  assert.equal(pool.receipt(device, { ...initial, phase: "started", thread: "owner-session" }), 200);
  assert.equal(pool.receipt(device, { ...initial, phase: "tested", output: "ok", patch: digest }), 200);
  assert.equal((await firstTask).phase, "tested");

  const secondTask = assert.rejects(pool.execute({ ...work, issue: work.issue + 1 }, stop.signal, 2000,
    thread => started.push(thread), revalidate), { reason: "needs-reconciliation" });
  const secondDelivery = await pool.poll(device, stop.signal);
  assert.ok(secondDelivery.status === 200 && secondDelivery.offer);
  const held = { id: secondDelivery.offer.id, digest: secondDelivery.offer.digest, at: 101, phase: "accepted" } as const;
  const attempt = () => checkpoint.load().find(row => row.id === held.id);
  for (const actor of [undefined, "bob"]) {
    claimedBy = actor;
    assert.equal(pool.receipt(device, held), 403);
    assert.equal(attempt()?.state, "offered");
    assert.equal(attempt()?.receipt, undefined);
  }
  claimedBy = "alice";
  assert.equal(handoff.revoke(device.id, "alice"), 200);
  assert.equal(pool.permits(device.id), true);
  assert.equal(pool.receipt(device, held), 403);
  assert.equal(pool.receipt(device, { ...held, phase: "started", thread: "unexpected" }), 409);
  assert.equal(attempt()?.state, "offered");
  assert.deepEqual(started, ["owner-session"]);
  assert.deepEqual(audit.filter(event => event.subject === held.id).map(event => (event.details as { action: string }).action),
    ["offered", "acceptance-denied", "acceptance-denied", "acceptance-denied"]);
  stop.abort();
  await secondTask;
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

test("需要较大文件的工单只派给能力足够的设备，已有连接保持兼容", async t => {
  const pool = createCodeWorkerPool(database().checkpoint, new Set([first.id, second.id]));
  t.after(pool.close);
  const signal = new AbortController();
  const older = pool.poll(first, signal.signal);
  const capacity = readWorkerCapacity({ ...second, version: 1, editFileBytes: codeEditFileBytes({}) }, pool.config.maxSlots);
  assert.ok(capacity);
  const newer = pool.poll({ ...second, ...capacity }, signal.signal);
  const delivered = pool.execute({ ...work, files: [{ path: "src/worker.mts", sha256: digest, bytes: legacyCodeEditFileBytes + 1 }] },
    signal.signal, 1000, () => {}, revalidate);
  const result = await newer;
  assert.ok(result.status === 200 && result.offer);
  assert.equal(pool.snapshot().attempts[0]?.device, second.id);
  assert.equal(readCodeOffer(result.offer)?.work.files[0]?.bytes, legacyCodeEditFileBytes + 1);
  assert.equal(readCodeOffer({ ...result.offer, work: { ...work,
    files: [{ path: "src/worker.mts", sha256: digest, bytes: legacyCodeEditFileBytes }] } }), undefined);
  const lowered = new AbortController();
  const uninterrupted = pool.poll({ ...second, editFileBytes: legacyCodeEditFileBytes }, lowered.signal);
  lowered.abort();
  assert.deepEqual(await uninterrupted, { status: 200, offer: null });
  assert.equal(pool.snapshot().attempts.length, 1);
  assert.equal(pool.receipt(second, { id: result.offer.id, digest: result.offer.digest, at: 100, phase: "declined" }), 200);
  assert.equal((await delivered).phase, "declined");
  signal.abort();
  assert.deepEqual(await older, { status: 200, offer: null });
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
