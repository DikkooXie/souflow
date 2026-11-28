import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { contentDigest } from "../src/execution/code-worker-protocol.mts";
import { IssueDeliveryFailed } from "../src/execution/issue-delivery.mts";
import { issueRevision, type DeliveryTracker, type IssueDetail, type IssuePull } from "../src/connections/issue-tracker.mts";
import { readApprovedReviewFix, type ApprovedReviewFix } from "../src/workbench/approved-review-fix.mts";
import { repairFromReceipt } from "../src/workbench/delivery-review-repair.mts";
import { createIssueDispatch, type Claim } from "../src/workbench/issue-dispatch.mts";
import { createPlannedIssuePublication } from "../src/workbench/planned-issue-publication.mts";

const head = "a".repeat(40), next = "b".repeat(40), hash = "c".repeat(64);
const tests = ["tests/remote-handoff.test.mts", "tests/other.test.mts"];
const files = [...[1, 2, 3, 4].map(n => `src/main${n}.mts`), ...tests];

async function fixture() {
  const quality = { policy: 1, flowDigest: hash, batchDigest: hash };
  const pull: IssuePull = { number: 145, url: "https://github.com/a/b/pull/145", state: "OPEN", head, baseName: "main" };
  const issue: IssueDetail = { number: 107, title: "交接", body: "固定验收", state: "OPEN", assignees: ["member"],
    url: "https://github.com/a/b/issues/107", pulls: [pull] };
  const revision = issueRevision(issue);
  const approval = { flowId: "flow", planId: "plan", version: 14, issueRevision: revision, quality };
  const receipt = { packetId: hash, key: { repo: "a/b", issue: 107, issueRevision: revision, pull: 145, head,
    mergeBase: head, plan: { id: "plan", version: 14, quality } }, status: "block" as const,
    implementation: { status: "block" as const, summary: "补全真实交接验证", evidence: [] }, requirements: { criteria: [] } };
  const claim: Claim = { ...issue, pull, requestId: "approved", claimedBy: "member", account: "member", phase: "submitted", syncedAt: 0,
    target: { branch: "feat/107-123456789abc", head, base: "main" }, delivery: { files, baseRevision: head, dependsOn: [], instructions: "原要求" },
    approval, observedIssueRevision: revision, observedReviewLink: true,
    deliveryReviews: [{ observed: JSON.stringify([145, head, "main", approval, revision, true, undefined]), receipt }] };
  const repair = repairFromReceipt("a/b", claim, receipt);
  assert.ok(repair && "fix" in repair);
  let linked: IssueDetail | undefined;
  const publication = createPlannedIssuePublication({ load: () => [], save: () => true });
  const setup: DeliveryTracker = { repo: "a/b", account: async () => "member", assign: async () => {}, candidates: async () => [],
    read: async () => { assert.ok(linked); return linked; }, creation: {
      create: async ({ title, body }) => { linked = { ...issue, number: 148, title, body, pulls: [] }; return 148; }, findCreated: async () => [] },
    delivery: { find: async () => pull, checkout: async () => assert.fail(), publish: async () => assert.fail() } };
  await publication(repair.batch, setup, new AbortController().signal, "member");
  assert.ok(linked);
  const candidateFiles = files.map(path => ({ path, before: "d".repeat(64), after: "e".repeat(64), mode: 0o100644 as const }));
  const patch = "diff --git a/before/src/main1.mts b/after/src/main1.mts\n";
  claim.failure = { stage: "tests", reason: "check-failed", isolation: { step: "quality", outcome: "exit", exitCode: 2,
    diagnostics: [`${tests[0]}:161:14 TS1345`] }, candidateFiles, candidateDigest: contentDigest(JSON.stringify(candidateFiles)),
    candidatePatch: patch, candidatePatchDigest: contentDigest(patch) };
  claim.reviewRepairs = [{ id: repair.id, head, decision: "approved", at: 1, issue: 148 }];
  claim.reviewFix = { from: head, repairId: repair.id, state: "failed", testCheckFailed: true, retriedTests: true };
  const fix: ApprovedReviewFix = { ...repair.fix, files: files.filter(path => path !== tests[0]), testFiles: [tests[0] as string],
    repairId: repair.id, testFailureNote: "只纠正最新 TS1345", failedDraft: { artifact: "issue-107-latest", sha256: "f".repeat(64) } };
  return { claim, issue, pull, linked, repair, fix };
}

test("普通修复卡固定候选恢复只消费一次，原修复单与原派发保持不变", async t => {
  for (const scenario of ["pass", "fails-again", "restart-running", "wrong-repair", "changed-head", "changed-issue", "changed-link",
    "closed-link", "declined", "new-test", "not-diagnostic-test", "wrong-instructions", "missing-file", "tampered-patch",
    "tampered-manifest", "not-latest-failure", "scope-revoked", "save-failed", "transient-link", "concurrent-preflight", "restart-preflight"] as const) await t.test(scenario, async () => {
    const { claim, issue, pull, linked, fix } = await fixture();
    let stored = structuredClone(claim);
    let remotePull = { ...pull };
    if (scenario === "wrong-repair") fix.repairId = "0".repeat(64);
    if (scenario === "new-test") fix.testFiles = ["tests/new.test.mts"];
    if (scenario === "not-diagnostic-test") { fix.testFiles = [tests[1] as string]; fix.files = files.filter(path => path !== tests[1]); }
    if (scenario === "wrong-instructions") fix.instructions = "未批准的新要求";
    if (scenario === "missing-file") fix.files = fix.files.slice(1);
    if (scenario === "tampered-patch" && stored.failure) stored.failure.candidatePatch += "changed";
    if (scenario === "tampered-manifest" && stored.failure?.candidateFiles?.[0]) stored.failure.candidateFiles[0].after = "0".repeat(64);
    if (scenario === "not-latest-failure") stored.failure = { stage: "dependencies", reason: "unavailable" };
    if (scenario === "declined" && stored.reviewRepairs?.[0]) stored.reviewRepairs[0].decision = "declined";
    if (scenario === "changed-head") remotePull = { ...pull, head: next };
    let prepares = 0, pushes = 0, replayWrites = 0, linkedReads = 0;
    let releasePreflight = () => {};
    const preflight = new Promise<void>(resolve => { releasePreflight = resolve; });
    const tracker: DeliveryTracker = { repo: "a/b", account: async () => "member", candidates: async () => [], assign: async () => assert.fail(),
      read: async number => {
        if (number === 148) {
          linkedReads++;
          if (scenario === "transient-link" && linkedReads === 1) throw Error("临时断网");
          if (["concurrent-preflight", "restart-preflight"].includes(scenario) && linkedReads === 1) await preflight;
          return { ...linked, ...(scenario === "changed-link" ? { body: "被改动" } : {}),
          ...(scenario === "closed-link" ? { state: "CLOSED" } : {}) }; }
        assert.equal(number, 107);
        return { ...issue, pulls: [remotePull], ...(scenario === "changed-issue" ? { body: "未批准需求" } : {}) };
      }, creation: { create: async () => assert.fail("不能新建修复单"), findCreated: async () => assert.fail("不能重新定位修复单") },
      delivery: { find: async () => remotePull, checkout: async () => assert.fail(), publish: async () => assert.fail("不能新建 PR"),
        checkoutPublished: async () => {}, updatePublished: async input => {
          assert.equal(input.from, head); assert.equal(input.pull, 145); pushes++;
          remotePull = { ...pull, head: next }; return remotePull;
        } } };
    for (let restart = 0; restart < 3; restart++) {
      const dispatch = createIssueDispatch(tracker, { load: () => [stored], save(_key, value, event) {
        const action = (event?.details as { action?: string } | undefined)?.action;
        if (action === "review-fix-draft-replay-started") {
          if (scenario === "save-failed") return false;
          replayWrites++;
        }
        stored = structuredClone(value); return true;
      } }, async () => assert.fail(), () => true, 2, new Map(), {
        specs: new Map(), conversation: true, pollMs: 60_000, reviewFix: fix,
        reviewScopeCurrent: () => scenario !== "scope-revoked",
        publishRepair: async () => assert.fail("恢复只能读取已关联 Issue"),
        prepare: async input => {
          prepares++;
          assert.deepEqual(input.spec.files, [...fix.files, ...fix.testFiles ?? []]);
          assert.equal(input.reviewTarget?.head, head);
          assert.deepEqual(input.failedReviewDraft?.testFiles, [tests[0]]);
          assert.deepEqual(input.failedReviewDraft?.evidence?.files, claim.failure?.candidateFiles);
          assert.equal(input.failedReviewDraft?.evidence?.sha256, claim.failure?.candidatePatchDigest);
          assert.notEqual(input.failedReviewDraft?.sha256, input.failedReviewDraft?.evidence?.sha256);
          assert.equal(stored.reviewFix?.replayedDraft?.sha256, fix.failedDraft?.sha256);
          assert.deepEqual(stored.reviewFix?.replayedCandidate?.files, claim.failure?.candidateFiles);
          if (!["pass", "transient-link", "concurrent-preflight", "restart-preflight"].includes(scenario)) throw new IssueDeliveryFailed({ stage: "tests", reason: "check-failed" });
          return { workspace: "fixture", branch: input.branch, head: next, base: "main", checked: { head: next, passingTests: ["AC-1 完整质量检查"] } };
        },
      });
      try {
        for (let n = 0; n < 2; n++) { await dispatch.refresh().catch(error => {
          if (scenario !== "save-failed") throw error;
        }); await setImmediate();
          if (scenario === "transient-link" && restart === 0 && n === 0) {
            assert.equal(stored.reviewFix?.replayedDraft, undefined, "首次断网不消费恢复机会");
          }
          if (scenario === "concurrent-preflight" && restart === 0 && n === 0) {
            await Promise.all([dispatch.refresh(), dispatch.refresh()]);
            await setImmediate();
            assert.equal(linkedReads, 1, "预检期间相同配置不可重复占位");
            assert.equal(replayWrites, 0);
            assert.equal(prepares, 0);
            releasePreflight();
            await setImmediate();
          }
          if (scenario === "restart-preflight" && restart === 0 && n === 0) {
            const stopped = dispatch.close();
            releasePreflight();
            await stopped;
            assert.equal(stored.reviewFix?.replayedDraft, undefined, "预检中关停不能标记为已开工");
            assert.equal(prepares, 0);
          }
        }
      } finally { await dispatch.close(); }
      if (scenario === "restart-running" && restart === 0 && stored.reviewFix) stored.reviewFix.state = "running";
    }
    const expected = ["pass", "fails-again", "restart-running", "transient-link", "concurrent-preflight", "restart-preflight"].includes(scenario) ? 1 : 0;
    assert.equal(prepares, expected);
    assert.equal(pushes, ["pass", "transient-link", "concurrent-preflight", "restart-preflight"].includes(scenario) ? 1 : 0);
    assert.ok(replayWrites <= 1);
    assert.deepEqual(stored.reviewRepairs?.map(row => [row.id, row.issue]), claim.reviewRepairs?.map(row => [row.id, row.issue]));
    assert.deepEqual(stored.approval, claim.approval);
    assert.equal(stored.retryCount, claim.retryCount, "不消耗新的业务派发");
    assert.equal(stored.recoveryDispatchAttempt, claim.recoveryDispatchAttempt);
    if (expected) { assert.ok(linkedReads); assert.equal(replayWrites, 1); }
  });
});

test("显式普通卡恢复配置绑定 repairId，不能缺少候选或混入文件", async () => {
  const { fix } = await fixture();
  assert.deepEqual(readApprovedReviewFix(JSON.stringify(fix)), fix);
  for (const changed of [{ repairId: "wrong" }, { failedDraft: undefined }, { testFiles: undefined },
    { testFiles: [fix.files[0]] }, { testFailureNote: undefined }, { unknown: true }]) {
    assert.throws(() => readApprovedReviewFix(JSON.stringify({ ...fix, ...changed })), /PR 续修/);
  }
});
