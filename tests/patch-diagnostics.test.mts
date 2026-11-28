import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openActivityStore, type BusinessEvent } from "../src/audit/activity-store.mts";
import { createCodeWorkerPool, type WorkerAttempt } from "../src/execution/code-worker-pool.mts";
import { compactCodeFailure, contentDigest, readCodeReceipt, type CodeWork } from "../src/execution/code-worker-protocol.mts";
import { applyCheckedCodeChanges, maxCodeProposalBytes, prepareCodeProposal } from "../src/execution/local-code-changes.mts";
import { describePatchDiagnostics, patchFailureDiagnostic, readPatchDiagnostics, type PatchDiagnostic } from "../src/execution/patch-diagnostics.mts";
import { createIssueDispatch, type Claim } from "../src/workbench/issue-dispatch.mts";

const path = "src/example.mts";
const sources = new Map([[path, { content: "original\nrepeat\nrepeat\n", mode: 0o644 }]]);
const reply = (edit: object) => JSON.stringify({ report: "fixture", edits: [edit] });
const valid = { path, before: "original", after: "updated" };

test("#137 用实际补丁区分首次与自动修正拒因，且不携带源码或凭据", async t => {
  const target = await mkdtemp(join(tmpdir(), "souflow-diagnostics-"));
  t.after(() => rm(target, { recursive: true, force: true }));
  for (const [output, code] of [["{ invalid", "json"],
    [reply({ ...valid, before: "missing" }), "anchor-missing"],
    [reply({ ...valid, path: "src/not-approved.mts" }), "unauthorized-file"],
    [reply({ ...valid, after: "x".repeat(70_000) }), "file-size"],
    ["x".repeat(maxCodeProposalBytes + 1), "output-too-large"]] as const) {
    const diagnostics: PatchDiagnostic[] = [];
    let attempt: 1 | 2 = 1;
    try {
      await prepareCodeProposal(target, sources, async issue => {
        attempt = issue ? 2 : 1;
        return issue ? reply({ ...valid, before: "repeat" }) : output;
      }, issue => diagnostics.push({ ...issue, attempt: 1 }));
      assert.fail("应拒绝无效补丁");
    } catch (error) { diagnostics.push(patchFailureDiagnostic(error, attempt, false)); }
    assert.equal(diagnostics[0]?.code, code);
    const scope = code === "unauthorized-file";
    assert.deepEqual(diagnostics.map(item => item.attempt), scope ? [1] : [1, 2]);
    if (!scope) assert.deepEqual(diagnostics[1], { code: "anchor-ambiguous", edit: 1, attempt: 2 });
    assert.deepEqual(readPatchDiagnostics(diagnostics), diagnostics);
    assert.doesNotMatch(JSON.stringify(diagnostics), /original|repeat|not-approved/);
  }
  const secret = "Authorization: Bearer ghp_12345678901234567890 original source";
  assert.deepEqual(patchFailureDiagnostic(Error(secret), 1, false), { code: "prepare-failed", attempt: 1 });
  assert.deepEqual(patchFailureDiagnostic(Error(secret), 1, true), { code: "apply-failed", attempt: 1 });
  const checked = await prepareCodeProposal(target, sources, async () => reply(valid));
  const workspace = join(target, "source");
  await mkdir(join(workspace, "src"), { recursive: true });
  await writeFile(join(workspace, path), secret);
  try {
    await applyCheckedCodeChanges(target, workspace, sources, checked);
    assert.fail("工作区变化必须停止应用");
  } catch (error) {
    assert.deepEqual(patchFailureDiagnostic(error, 1, true), { code: "workspace-changed", attempt: 1 });
  }
  await writeFile(join(workspace, path), sources.get(path)?.content ?? "");
  await mkdir(join(target, "changes.patch"));
  await assert.rejects(applyCheckedCodeChanges(target, workspace, sources, checked), (error: unknown) => {
    assert.deepEqual(patchFailureDiagnostic(error, 1, true), { code: "apply-failed", attempt: 1 });
    return true;
  });
});

test("#137 协议拒绝自由文本、额外字段和越界序号，兼容没有诊断的历史回执", () => {
  const fields = { id: randomUUID(), digest: contentDigest("work"), at: 1, phase: "failed", failureStage: "patch" };
  const diagnostic = { code: "anchor-missing", edit: 2, attempt: 1 };
  assert.ok(readCodeReceipt(fields));
  assert.ok(readCodeReceipt({ ...fields, patchDiagnostics: [diagnostic] }));
  for (const patchDiagnostics of [[], [diagnostic, diagnostic], [{ ...diagnostic, attempt: 3 }],
    [{ ...diagnostic, edit: -1 }], [{ ...diagnostic, edit: 1.5 }], [{ ...diagnostic, edit: maxCodeProposalBytes + 1 }],
    [{ ...diagnostic, code: "Authorization: Bearer secret" }], [{ ...diagnostic, message: "source text" }],
    [{ ...diagnostic, path: "src/example.mts" }], [diagnostic, { ...diagnostic, attempt: 2 }, { ...diagnostic, attempt: 3 }]]) {
    assert.equal(readCodeReceipt({ ...fields, patchDiagnostics }), undefined);
  }
  assert.equal(readCodeReceipt({ ...fields, failureStage: undefined, patchDiagnostics: [diagnostic] }), undefined);
  assert.equal(readCodeReceipt({ ...fields, phase: "accepted", patchDiagnostics: [diagnostic] }), undefined);
  const tested = readCodeReceipt({ ...fields, phase: "tested", output: "source output", patch: contentDigest("patch"), patchDiagnostics: [diagnostic] });
  assert.ok(tested);
  const compact = compactCodeFailure(tested);
  assert.deepEqual(readCodeReceipt(compact), compact);
  assert.doesNotMatch(JSON.stringify(compact), /source output/);
  assert.match(describePatchDiagnostics([diagnostic as PatchDiagnostic]), /首次补丁.*anchor-missing.*第 2 项替换/);
});

test("#137 设备拒因经真实 SQLite 恢复后仍可查，同一开工和失败回执只记录一次", async t => {
  const directory = await mkdtemp(join(tmpdir(), "souflow-receipt-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "audit.sqlite");
  const device = { id: randomUUID(), name: "验证 Mac", instance: randomUUID(), repo: "owner/repo", slots: 1, ready: true };
  const digest = contentDigest("work");
  const work: CodeWork = { repo: device.repo, issue: 137, revision: "a".repeat(40), issueRevision: digest, upstream: [],
    plan: { flowId: randomUUID(), version: 1, flowDigest: digest, batchDigest: digest },
    files: [{ path, sha256: contentDigest(sources.get(path)?.content ?? "") }], instructions: "验证原工单", context: "{}" };
  const diagnostics: PatchDiagnostic[] = [{ code: "anchor-missing", edit: 2, attempt: 1 },
    { code: "anchor-ambiguous", edit: 1, attempt: 2 }];
  const signal = new AbortController().signal;
  const store = openActivityStore(file);
  const pool = createCodeWorkerPool(store.checkpoint<WorkerAttempt>("workers"), new Set([device.id]));
  let starts = 0;
  const waiting = pool.poll(device, signal);
  const execution = pool.execute(work, signal, 2000, () => { starts++; }, async () => {});
  const delivery = await waiting;
  assert.ok(delivery.status === 200 && delivery.offer);
  const base = { id: delivery.offer.id, digest: delivery.offer.digest };
  assert.equal(pool.receipt(device, { ...base, phase: "accepted", at: 1 }), 200);
  const started = { ...base, phase: "started", at: 2, thread: "fixture-thread" } as const;
  assert.equal(pool.receipt(device, started), 200);
  assert.equal(pool.receipt(device, started), 200);
  assert.equal(starts, 1);
  const failed = readCodeReceipt({ ...base, phase: "failed", at: 3, failureStage: "patch", patchDiagnostics: diagnostics });
  assert.ok(failed);
  assert.equal(pool.receipt(device, failed), 200);
  assert.equal(pool.receipt(device, failed), 200);
  assert.equal((await execution).phase, "failed");
  assert.deepEqual(pool.failedAttempt(work)?.patchDiagnostics, diagnostics);
  store.checkpoint<Claim>("claims").save("137", { number: 137, title: "设备失败", state: "OPEN",
    url: "https://github.com/owner/repo/issues/137", assignees: ["member"], pulls: [], syncedAt: 1,
    requestId: randomUUID(), claimedBy: "implementer", account: "member", phase: "deliveryFailed",
    failure: { stage: "device", reason: "device-failed", workerStage: "patch", patchDiagnostics: diagnostics } });
  pool.close();
  store.close();

  const restoredStore = openActivityStore(file);
  const restored = createCodeWorkerPool(restoredStore.checkpoint<WorkerAttempt>("workers"), new Set([device.id]));
  t.after(() => { restored.close(); restoredStore.close(); });
  assert.deepEqual(restored.failedAttempt(work)?.patchDiagnostics, diagnostics);
  assert.equal(restored.receipt(device, failed), 200);
  const attempt = restored.snapshot().attempts[0];
  assert.equal(attempt?.id, base.id);
  assert.match(attempt?.patchDiagnosticSummary ?? "", /首次补丁.*第 2 项替换.*自动修正补丁.*第 1 项替换/);
  const audit = restoredStore.report(1).recent.filter(event => event.kind === "remote.code");
  assert.deepEqual(audit.map(event => (event.details as { action: string }).action).sort(), ["accepted", "failed", "offered", "started"]);
  const failure = audit.find(event => (event.details as { action: string }).action === "failed");
  assert.ok(failure);
  assert.deepEqual((failure.details as { patchDiagnostics: unknown }).patchDiagnostics, diagnostics);
  assert.doesNotMatch(JSON.stringify(audit), /original|repeat|Bearer|ghp_/);
  const dispatch = createIssueDispatch({ repo: device.repo, account: async () => "member", candidates: async () => [],
    read: async () => assert.fail("仅回读本地状态"), assign: async () => assert.fail("不重新派发") },
    restoredStore.checkpoint<Claim>("claims"), async () => assert.fail("不得自动开工"), () => true, 1);
  const item = dispatch.snapshot(true).items[0];
  assert.ok(item && "failureEvidence" in item);
  assert.match((item.failureEvidence as { summary: string }).summary, /首次补丁.*anchor-missing.*自动修正补丁.*anchor-ambiguous/);
  await dispatch.close();
});

test("#137 开工业务回调短时失败后可补齐，成功通知和审计各保留一次", async t => {
  const rows = new Map<string, WorkerAttempt>();
  const audit: BusinessEvent[] = [];
  const device = { id: randomUUID(), name: "回执验证 Mac", instance: randomUUID(), repo: "owner/repo", slots: 1, ready: true };
  const digest = contentDigest("work");
  const work: CodeWork = { repo: device.repo, issue: 137, revision: "a".repeat(40), issueRevision: digest, upstream: [],
    plan: { flowId: randomUUID(), version: 1, flowDigest: digest, batchDigest: digest },
    files: [{ path, sha256: digest }], instructions: "验证重放", context: "{}" };
  const pool = createCodeWorkerPool({ load: () => [...rows.values()], save(id, row, event) {
    rows.set(id, row);
    if (event) audit.push(event);
    return true;
  } }, new Set([device.id]));
  t.after(pool.close);
  const signal = new AbortController().signal;
  const waiting = pool.poll(device, signal);
  let calls = 0;
  let starts = 0;
  const execution = pool.execute(work, signal, 2000, () => {
    if (++calls === 1) throw Error("模拟业务状态保存失败");
    starts++;
  }, async () => {});
  const delivery = await waiting;
  assert.ok(delivery.status === 200 && delivery.offer);
  const base = { id: delivery.offer.id, digest: delivery.offer.digest };
  assert.equal(pool.receipt(device, { ...base, phase: "accepted", at: 1 }), 200);
  const started = { ...base, phase: "started", at: 2, thread: "fixture-thread" } as const;
  assert.throws(() => pool.receipt(device, started), /模拟业务状态保存失败/);
  assert.equal(pool.receipt(device, started), 200);
  assert.equal(pool.receipt(device, started), 200);
  assert.equal(starts, 1);
  assert.equal(calls, 2);
  assert.equal(audit.filter(event => (event.details as { action: string }).action === "started").length, 1);
  assert.equal(pool.receipt(device, { ...base, phase: "failed", at: 3, failureStage: "patch" }), 200);
  await execution;
});
