import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import { openActivityStore } from "../src/audit/activity-store.mts";
import { issueRevision, type DeliveryTracker, type IssueDetail } from "../src/connections/issue-tracker.mts";
import { createCodeWorkerPool, type WorkerAttempt } from "../src/execution/code-worker-pool.mts";
import { createIssueDeveloper } from "../src/execution/issue-delivery.mts";
import { createDispatchMonitor } from "../src/execution/dispatch-monitor.mts";
import { createIssueDispatch, type Claim, type IssueDeliveryOptions } from "../src/workbench/issue-dispatch.mts";
import { deviceWaitBinding, legacyDeviceWaitDigest, readLegacyDeviceWait, restoreDeviceWait } from "../src/workbench/device-wait.mts";

const repo = "owner/repo", hash = "a".repeat(64), base = "b".repeat(40);
const approval = { flowId: randomUUID(), planId: "plan", version: 1, quality: { policy: 1, flowDigest: hash, batchDigest: hash } };
const spec = { files: ["tests/example.test.mts"], instructions: "验证原行为", dependsOn: [], baseRevision: base, sourcePaths: ["src/example.mts"] };
const issue: IssueDetail = { number: 7, title: "实际工单", body: "原验收条件", state: "OPEN", assignees: ["member"], pulls: [], url: "https://github.com/owner/repo/issues/7" };
const makeClaim = (): Claim => ({ ...issue, phase: "developing", requestId: randomUUID(), account: "member", claimedBy: "member", syncedAt: 0,
  approval: { ...approval, issueRevision: issueRevision(issue) }, delivery: structuredClone(spec) });
const options = (): IssueDeliveryOptions => ({ specs: new Map(), prepare: async () => assert.fail(), pollMs: 60_000, conversation: true,
  executionMode: "device", hasAnyWorkerAttempt: () => false, hasIssueExecutionHistory: () => false, reviewScopeCurrent: () => true });

test("旧零开工恢复绑定完整原记录与明确设备模式，历史执行和模式不明均拒绝", async t => {
  for (const scenario of ["valid", "unknown-mode", "local-mode", "unknown-history", "offer", "local-history", "changed-record", "session", "account",
    "target", "prepared", "retry", "source-refresh", "approval", "unknown-original"] as const) await t.test(scenario, () => {
    const claim = makeClaim(), config = options();
    assert.ok(claim.approval);
    config.recoverDeviceWait = { issue: claim.number, claimDigest: legacyDeviceWaitDigest(claim), originalMode: "device" };
    if (scenario === "unknown-mode") delete config.executionMode;
    if (scenario === "local-mode") config.executionMode = "local";
    if (scenario === "unknown-history") delete config.hasAnyWorkerAttempt;
    if (scenario === "offer") config.hasAnyWorkerAttempt = () => true;
    if (scenario === "local-history") config.hasIssueExecutionHistory = () => true;
    if (scenario === "changed-record") claim.delivery = { ...spec, instructions: "changed" };
    if (scenario === "session") claim.sessionId = "old-session";
    if (scenario === "account") claim.accountAssignment = { label: "Account", active: 1, capacity: 1, reason: "selected" };
    if (scenario === "target") claim.target = { branch: "feat/7-old", head: base };
    if (scenario === "prepared") claim.prepared = { branch: "feat/7-old", head: base, base: "main", workspace: "old" };
    if (scenario === "retry") claim.retryCount = 1;
    if (scenario === "source-refresh") claim.sourceRefresh = { revision: base, state: "passed" };
    if (scenario === "approval") claim.approval = { ...claim.approval, version: 2 };
    if (scenario === "unknown-original") assert.throws(() => readLegacyDeviceWait(JSON.stringify({ ...config.recoverDeviceWait, originalMode: "unknown" })));
    else assert.equal(restoreDeviceWait(repo, claim, config)?.phase, scenario === "valid" ? "waitingDevice" : undefined);
  });
  assert.throws(() => readLegacyDeviceWait(JSON.stringify({ issue: 0, originalMode: "device", claimDigest: hash })));
  const claim = makeClaim();
  claim.phase = "waitingDevice";
  claim.deviceWait = { version: 1, binding: deviceWaitBinding(repo, claim) };
  assert.equal(restoreDeviceWait(repo, claim, options())?.phase, "waitingDevice");
  assert.ok(claim.approval);
  claim.approval = { ...claim.approval, version: 2 };
  assert.equal(restoreDeviceWait(repo, claim, options()), undefined);
});

test("正常批准后等待设备可跨重启；offer、实际开工、发布分阶段且只执行一次", async t => {
  for (const scenario of ["normal", "legacy", "offered-restart", "changed-account", "changed-owner", "changed-body", "revoked", "offer-save-failed"]) await t.test(scenario, async () => {
    const legacy = scenario === "legacy";
    const audit = openActivityStore(":memory:");
    const checkpoint = audit.checkpoint<Claim>("claims");
    const attempts = audit.checkpoint<WorkerAttempt>("remote-code");
    const original = makeClaim();
    if (legacy) checkpoint.save("7", original);
    let remote = { ...issue, assignees: legacy ? ["member"] : [] };
    let prepareCalls = 0, published = 0;
    let account = "member", scopeCurrent = true;
    const device = { id: randomUUID(), instance: randomUUID(), name: "Mac", repo, slots: 1, ready: true };
    const tracker: DeliveryTracker = { repo, account: async () => account, read: async () => remote, candidates: async () => [],
      assign: async () => { remote = { ...remote, assignees: ["member"] }; }, delivery: {
        find: async () => undefined, checkout: async () => assert.fail(), publish: async input => { published++;
          return { number: 8, url: "https://github.com/owner/repo/pull/8", state: "OPEN", head: input.head, baseName: "main" }; },
      } };
    const build = () => {
      const pool = createCodeWorkerPool(attempts, new Set([device.id]));
      const dispatch = createIssueDispatch(tracker, { load: checkpoint.load, save(id, row, event) {
        if (scenario === "offer-save-failed" && (event?.details as { action?: string } | undefined)?.action === "device-offered") return false;
        return checkpoint.save(id, row, event);
      } }, async () => assert.fail(), () => true, 1, new Map(), {
        ...options(), hasAnyWorkerAttempt: pool.hasAnyAttempt, hasIssueExecutionHistory: audit.hasIssueExecutionHistory,
        reviewScopeCurrent: () => scopeCurrent,
        ...(legacy ? { recoverDeviceWait: { issue: 7, claimDigest: legacyDeviceWaitDigest(original), originalMode: "device" as const } } : {}),
        prepare: async (input, connected, signal) => {
          prepareCalls++;
          assert.equal(input.requireDevice, true);
          assert.equal(input.spec.baseRevision, base);
          assert.deepEqual(input.spec.sourcePaths, spec.sourcePaths);
          assert.ok(input.workerProof && input.revalidateWorker && spec.files[0]);
          await pool.execute({ ...input.workerProof, issue: 7, revision: base, upstream: input.upstream,
            files: [{ path: spec.files[0], sha256: hash }], instructions: spec.instructions, context: "{}" }, signal, 60_000,
          connected, input.revalidateWorker, undefined, input.workerOffered);
          await input.revalidateWorker(signal);
          return { workspace: "fixture", branch: input.branch, head: "c".repeat(40), base: "main" };
        },
      });
      return { pool, dispatch };
    };
    let { pool, dispatch } = build();
    try {
      if (!legacy) await dispatch.claimApproved(original.requestId, "member", new Map([[7, { ...spec, issueRevision: issueRevision(issue) }]]), approval);
      else await dispatch.refresh();
      await setImmediate();
      assert.equal(checkpoint.load()[0]?.phase, "waitingDevice");
      assert.equal(dispatch.snapshot(false).items[0]?.progress, "等待可用的授权设备");
      assert.equal(attempts.load().length, 0);
      await Promise.all([dispatch.refresh(), dispatch.refresh()]);
      assert.equal(prepareCalls, 1);
      await dispatch.close(); pool.close();
      assert.equal(checkpoint.load()[0]?.phase, "waitingDevice");
      ({ pool, dispatch } = build());
      await dispatch.refresh(); await setImmediate();
      if (scenario === "changed-account") account = "another";
      if (scenario === "changed-owner") remote = { ...remote, assignees: ["another"] };
      if (scenario === "changed-body") remote = { ...remote, body: "changed" };
      if (scenario === "revoked") scopeCurrent = false;
      if (scenario.startsWith("changed-") || ["revoked", "offer-save-failed"].includes(scenario)) {
        const stopPoll = new AbortController();
        const pending = pool.poll(device, stopPoll.signal);
        await setImmediate(); stopPoll.abort(); await pending;
        assert.equal(published, 0);
        assert.equal(attempts.load().length, scenario === "offer-save-failed" ? 1 : 0);
        if (scenario === "offer-save-failed") {
          assert.equal(pool.hasAttempt(repo, 7), false);
          assert.equal(pool.hasAnyAttempt(repo, 7), true);
        }
        await dispatch.close(); pool.close();
        ({ pool, dispatch } = build()); await dispatch.refresh();
        assert.equal(prepareCalls, 2);
        return;
      }
      const response = await pool.poll(device, new AbortController().signal);
      assert.equal(response.status, 200);
      assert.ok("offer" in response && response.offer);
      const { id, digest } = response.offer;
      assert.equal(checkpoint.load()[0]?.phase, "deviceOffered");
      assert.equal(dispatch.snapshot(false).items[0]?.progress, "工单已派发，等待设备开工");
      if (scenario === "offered-restart") {
        await dispatch.close(); pool.close();
        ({ pool, dispatch } = build()); await dispatch.refresh();
        assert.equal(prepareCalls, 2);
        assert.equal(attempts.load().length, 1);
        assert.equal(checkpoint.load()[0]?.phase, "uncertain");
        return;
      }
      assert.equal(pool.receipt(device, { id, digest, phase: "accepted", at: 1 }), 200);
      assert.equal(pool.receipt(device, { id, digest, phase: "started", thread: "thread", at: 2 }), 200);
      assert.equal(checkpoint.load()[0]?.phase, "developing");
      assert.equal(pool.receipt(device, { id, digest, phase: "tested", patch: hash, output: "{}", at: 3 }), 200);
      await setImmediate(); await dispatch.refresh();
      assert.equal(published, 1);
      assert.equal(attempts.load().length, 1);
      assert.equal(checkpoint.load()[0]?.phase, "submitted");
      await dispatch.close(); pool.close();
      ({ pool, dispatch } = build()); await dispatch.refresh();
      assert.equal(prepareCalls, 2);
    } finally { await dispatch.close(); pool.close(); audit.close(); }
  });
});

test("完整审计保留已清空的本机执行痕迹，设备要求不能落入本机模型", async () => {
  const audit = openActivityStore(":memory:");
  try {
    assert.equal(audit.hasIssueExecutionHistory(`${repo}#7`), false);
    audit.record({ kind: "github.issue", subject: `${repo}#7`, details: { action: "dispatched", phase: "developing" } });
    assert.equal(audit.hasIssueExecutionHistory(`${repo}#7`), false);
    audit.record({ kind: "github.issue", subject: `${repo}#7`, details: { action: "connected", session: "old" } });
    assert.equal(audit.hasIssueExecutionHistory(`${repo.toUpperCase()}#7`), true);
    const developer = createIssueDeveloper(createDispatchMonitor("fixture"), { root: "unused", image: "unused", timeoutMs: 1000,
      startTask: () => assert.fail("不能回退本机模型") });
    await assert.rejects(developer({ number: 7, spec, branch: "feat/7-fixture", upstream: [], requireDevice: true,
      publisher: { checkout: async () => assert.fail(), find: async () => undefined, publish: async () => assert.fail() } },
    () => assert.fail(), new AbortController().signal));
  } finally { audit.close(); }
});
