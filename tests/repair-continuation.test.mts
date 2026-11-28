import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { repairContinuationLimit } from "../src/config/runtime.mts";
import { issueRevision, type DeliveryTracker, type IssueDetail, type IssuePull } from "../src/connections/issue-tracker.mts";
import { contentDigest } from "../src/execution/code-worker-protocol.mts";
import type { CandidateSnapshot } from "../src/execution/candidate-snapshot.mts";
import { IssueDeliveryFailed } from "../src/execution/issue-delivery.mts";
import { createIssueDispatch, type Claim } from "../src/workbench/issue-dispatch.mts";
import { repairFromReceipt } from "../src/workbench/delivery-review-repair.mts";
import { createPlannedIssuePublication } from "../src/workbench/planned-issue-publication.mts";
import { createRepairContinuation } from "../src/workbench/repair-continuation.mts";

const head = "a".repeat(40), next = "b".repeat(40), hash = "c".repeat(64);
const paths = ["src/main.mts", "tests/main.test.mts", "tests/other.test.mts"];
const snapshot = (round: number): CandidateSnapshot => {
  const files = paths.map(path => ({ path, before: hash, after: contentDigest(`candidate-${round}-${path}`), mode: 0o100644 as const }));
  return { version: 1, head, artifact: `issue-7-candidate${round}`, sha256: contentDigest(`diff-${round}`), files,
    digest: contentDigest(JSON.stringify(files)) };
};

test("续修次数读取共享环境缺省值与覆盖值，非法预算不能启动", () => {
  assert.equal(repairContinuationLimit({}), 3);
  assert.equal(repairContinuationLimit({ SOULFLOW_GITHUB_REPAIR_MAX_ROUNDS: "2" }), 2);
  for (const value of ["0", "17", "2.5", "no"]) assert.throws(() => repairContinuationLimit({ SOULFLOW_GITHUB_REPAIR_MAX_ROUNDS: value }));
});

test("正常派发入口从原批准修复单自动检查候选，有限修正不同诊断且不重建 Issue", async t => {
  const oldLimit = process.env.SOULFLOW_GITHUB_REPAIR_MAX_ROUNDS;
  t.after(() => { if (oldLimit === undefined) delete process.env.SOULFLOW_GITHUB_REPAIR_MAX_ROUNDS;
    else process.env.SOULFLOW_GITHUB_REPAIR_MAX_ROUNDS = oldLimit; });
  for (const scenario of ["different", "repeat", "prior-repeat", "budget", "configured-budget", "transient", "revoked", "changed-link", "changed-head", "outside", "info", "incomplete",
    "restart-started", "restart-preflight", "concurrent", "save-failed"] as const) await t.test(scenario, async () => {
    process.env.SOULFLOW_GITHUB_REPAIR_MAX_ROUNDS = scenario === "configured-budget" ? "2" : "3";
    const quality = { policy: 1, flowDigest: hash, batchDigest: hash };
    const pull: IssuePull = { number: 8, url: "https://github.com/a/b/pull/8", state: "OPEN", head, baseName: "main" };
    const issue: IssueDetail = { number: 7, title: "真实行为", body: "固定验收", state: "OPEN", assignees: ["member"],
      url: "https://github.com/a/b/issues/7", pulls: [pull] };
    const revision = issueRevision(issue);
    const approval = { flowId: "flow", planId: "plan", version: 1, issueRevision: revision, quality };
    const receipt = { packetId: hash, key: { repo: "a/b", issue: 7, issueRevision: revision, pull: 8, head, mergeBase: head,
      plan: { id: "plan", version: 1, quality } }, status: "block" as const,
      implementation: { status: "block" as const, summary: "修复断言", evidence: [] }, requirements: { criteria: [] } };
    let stored: Claim = { ...issue, pull, requestId: "approved", claimedBy: "member", account: "member", phase: "submitted", syncedAt: 0,
      target: { branch: "feat/7-123456789abc", head, base: "main" }, delivery: { files: paths, baseRevision: head, dependsOn: [], instructions: "原要求" },
      approval, observedIssueRevision: revision, observedReviewLink: true,
      deliveryReviews: [{ observed: JSON.stringify([8, head, "main", approval, revision, true, undefined]), receipt }] };
    const repair = repairFromReceipt("a/b", stored, receipt);
    assert.ok(repair && "fix" in repair);
    if (scenario === "different") {
      const previous: Claim = { ...stored, reviewFix: { from: head, repairId: "previous", state: "complete" },
        repairContinuation: { head, repairId: "previous", rounds: [] } };
      const continuation = createRepairContinuation({ current: () => previous, repair: () => repair,
        signal: new AbortController().signal, start: assert.fail, connection: assert.fail, save: assert.fail, track: assert.fail });
      assert.equal(continuation.owns(previous), false, "旧授权的续修记录不能挡住当前提交的新卡");
    }
    let linked: IssueDetail | undefined;
    let published = false;
    let remotePull = { ...pull };
    let inspections = 0, starts = 0, pushes = 0, scopeCurrent = true, rejectSave = scenario === "save-failed";
    let release = () => {};
    const held = new Promise<void>(resolve => { release = resolve; });
    const events: object[] = [];
    const tracker: DeliveryTracker = { repo: "a/b", account: async () => "member", candidates: async () => [], assign: async () => assert.fail(),
      read: async number => {
        if (number === 9) { assert.ok(linked); return { ...linked, ...(published && scenario === "changed-link" ? { body: "changed" } : {}) }; }
        assert.equal(number, 7); return { ...issue, pulls: [remotePull] };
      }, creation: { create: async ({ title, body }) => { linked = { ...issue, number: 9, title, body, pulls: [] }; return 9; }, findCreated: async () => [] },
      delivery: { find: async () => scenario === "changed-head" ? { ...remotePull, head: next } : remotePull,
        checkout: async () => assert.fail(), checkoutPublished: async () => {}, publish: async () => assert.fail(),
        updatePublished: async input => { assert.equal(input.pull, 8); assert.equal(input.from, head); pushes++;
          remotePull = { ...pull, head: next }; return remotePull; } } };
    await createPlannedIssuePublication({ load: () => [], save: () => true })(repair.batch, tracker, new AbortController().signal, "member");
    published = true;
    assert.ok(tracker.creation);
    tracker.creation.create = async () => assert.fail("不能重新建单");
    stored.reviewRepairs = [{ id: repair.id, head, decision: "approved", at: 1, issue: 9 }];
    stored.reviewFix = { from: head, repairId: repair.id, state: "failed", testCheckFailed: true, retriedTests: true,
      replayedDraft: { artifact: "issue-7-old", sha256: hash },
      ...(scenario === "prior-repeat" ? { testFailureNote: "隔离质量检查 · 命令失败 · 退出码 2 · tests/main.test.mts:1:1 TS1345" } : {}) };
    stored.failure = { stage: "tests", reason: "check-failed", candidateSnapshot: snapshot(0), candidatePatch: "PRIVATE PATCH", isolation: {
      step: "quality", outcome: "exit", exitCode: 1 } };
    for (let restart = 0; restart < 3; restart++) {
      const dispatch = createIssueDispatch(tracker, { load: () => [stored], save(_key, value, event) {
        if ((event?.details as { action?: string } | undefined)?.action === "review-fix-draft-replay-started" && rejectSave) { rejectSave = false; return false; }
        if (event) events.push(event); stored = structuredClone(value); return true;
      } }, async () => assert.fail(), () => true, 2, new Map(), { specs: new Map(), conversation: true, pollMs: 60_000,
        reviewScopeCurrent: () => scopeCurrent, publishRepair: async () => assert.fail("只能回读原修复单"),
        inspectRepairCandidate: async input => {
          inspections++;
          if (scenario === "transient" && inspections === 1) throw Error("短暂环境故障");
          if (["restart-preflight", "concurrent"].includes(scenario) && inspections === 1) await held;
          if (scenario === "revoked") scopeCurrent = false;
          const rule = ["repeat", "prior-repeat"].includes(scenario) ? "TS1345" : `BIOME:error:lint/correctness/rule${starts}`;
          const diagnostic = scenario === "outside" ? "src/main.mts:2:1 TS1345"
            : scenario === "info" ? "tests/main.test.mts:2:1 BIOME:info:lint/style/useTemplate"
              : `tests/main.test.mts:${starts + 2}:1 ${rule}`;
          assert.equal(input.head, head); assert.deepEqual(input.files, paths);
          assert.ok(input.failure.candidateSnapshot);
          return { candidate: input.failure.candidateSnapshot, isolation: { step: "quality", outcome: "exit", exitCode: 1,
            diagnostics: [diagnostic], ...(scenario === "incomplete" ? { diagnosticsIncomplete: true as const } : {}) } };
        },
        prepare: async input => {
          starts++;
          assert.deepEqual(input.failedReviewDraft?.testFiles, ["tests/main.test.mts"]);
          assert.equal(input.failedReviewDraft?.evidence?.digest, snapshot(starts - 1).digest);
          assert.equal(stored.repairContinuation?.rounds.length, starts);
          if (scenario === "restart-started") throw Error("开工后中断，没有新失败证据");
          if (["repeat", "budget", "configured-budget"].includes(scenario) || scenario === "different" && starts === 1) {
            throw new IssueDeliveryFailed({ stage: "tests", reason: "check-failed", candidateSnapshot: snapshot(starts), candidatePatch: "PRIVATE PATCH",
              isolation: { step: "quality", outcome: "exit", exitCode: 1 } });
          }
          return { workspace: "fixture", branch: input.branch, head: next, base: "main" };
        } });
      try {
        for (let poll = 0; poll < 8; poll++) {
          await dispatch.refresh(); await setImmediate();
          if (["restart-preflight", "concurrent"].includes(scenario) && restart === 0 && poll === 0) {
            await Promise.all([dispatch.refresh(), dispatch.refresh()]); await setImmediate();
            assert.equal(inspections, 1); assert.equal(starts, 0);
            if (scenario === "restart-preflight") { const stopped = dispatch.close(); release(); await stopped;
              assert.equal(stored.repairContinuation, undefined); assert.equal(starts, 0); }
            else release();
          }
        }
      } finally { await dispatch.close(); }
    }
    const expected = ["different", "configured-budget"].includes(scenario) ? 2 : scenario === "budget" ? 3
      : ["repeat", "transient", "restart-started", "restart-preflight", "concurrent", "save-failed"].includes(scenario) ? 1 : 0;
    assert.equal(starts, expected);
    assert.equal(pushes, ["different", "transient", "restart-preflight", "concurrent", "save-failed"].includes(scenario) ? 1 : 0);
    assert.equal(stored.reviewRepairs?.[0]?.issue, 9);
    assert.deepEqual(stored.approval, approval);
    assert.ok(!JSON.stringify(events).includes("PRIVATE PATCH"));
    if (["repeat", "prior-repeat", "budget", "configured-budget", "restart-started", "outside", "info", "incomplete", "changed-link", "revoked"].includes(scenario)) {
      assert.ok(stored.repairContinuation?.stopped);
    }
  });
});
