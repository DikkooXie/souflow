import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { issueRevision, type DeliveryTracker, type IssueDetail, type IssuePull } from "../src/connections/issue-tracker.mts";
import { IssueDeliveryFailed, IssueDeliverySourcesChanged } from "../src/execution/issue-delivery.mts";
import { currentDevelopmentPlan } from "../src/planning/conversation-flow.mts";
import { qualityPacket, reviewQuality, type QualityTicket } from "../src/planning/dispatch-quality.mts";
import { createConversationDelivery, type IssueProposal } from "../src/workbench/conversation-delivery.mts";
import { createIssueDispatch, type Claim, type IssueDeliveryOptions } from "../src/workbench/issue-dispatch.mts";
import { deviceWaitBinding } from "../src/workbench/device-wait.mts";
import { createPlannedIssuePublication } from "../src/workbench/planned-issue-publication.mts";
import type { Checkpoint } from "../src/audit/activity-store.mts";
import { passingQualityReview, readyQualityFlow, validation } from "./fixtures/planning-quality.mts";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const base = "a".repeat(40), mergedHead = "b".repeat(40), revision = "c".repeat(40);
const source = "src/upstream.mts", files = [1, 2, 3, 4].map(n => `src/main${n}.mts`);
const testFiles = ["tests/main.test.mts", "tests/other.test.mts"];
function memory<T extends object>(rows = new Map<string, T>()): Checkpoint<T> {
  return { load: () => structuredClone([...rows.values()]), save(key, value) { rows.set(key, structuredClone(value)); return true; } };
}

test("已修订工单的每个明确失败回执仅续派一次，保留原 4+2 文件授权", async t => {
  for (const deviceMode of [false, true]) for (const scenario of ["success", "fails-again", "no-request", "old-request", "wrong-revision", "wrong-version", "wrong-issue",
    "wrong-owner", "wrong-parent", "wrong-amendment", "scope-revoked", "review-blocked", "review-transient", "offer-save-failed",
    "consumed-receipt", "unknown-lineage", "wrong-offer"] as const) {
    if (!deviceMode && scenario === "wrong-offer") continue;
    await t.test(`${deviceMode ? "设备等待标记" : "旧记录"}/${scenario}`, async () => {
    const flow = await readyQualityFlow();
    flow.project = { repository: { revision: base, commits: [] }, plan: { status: "read" }, github: { status: "read" } };
    const plan = currentDevelopmentPlan(flow);
    assert.ok(plan);
    const drafts: QualityTicket[] = [
      { id: "T1", title: "上游", instructions: "上游", paths: [source], criteria: ["AC-1"], dependsOn: [], validation },
      { id: "T2", title: "下游", instructions: "下游", paths: files, sources: [source], criteria: ["AC-1"], dependsOn: ["T1"], validation },
    ];
    const quality = await reviewQuality(qualityPacket(flow, base, id(1), drafts),
      { id: id(1), base, items: drafts, sourceHandoff: true }, passingQualityReview, new AbortController().signal);
    const binding = { policy: quality.policy, flowDigest: quality.flowDigest, batchDigest: quality.batchDigest };
    const merged: IssuePull = { number: 10, url: "https://github.com/a/b/pull/10", state: "MERGED", head: mergedHead,
      mergeCommit: mergedHead, baseName: "main", ci: "SUCCESS" };
    const parent: IssueDetail = { number: 1, title: "上游", body: "上游", url: "https://github.com/a/b/issues/1", state: "CLOSED", assignees: ["member"], pulls: [merged] };
    const child: IssueDetail = { ...parent, number: 2, title: "下游", body: "下游", state: "OPEN", pulls: [] };
    const approval = (issue: IssueDetail) => ({ flowId: flow.id, planId: plan.id, version: plan.version, quality: binding, issueRevision: issueRevision(issue) });
    const shared = { requestId: id(1), claimedBy: "member", account: "member", syncedAt: 0 };
    const amendment = { id: id(3), flowId: flow.id, actor: "member", requestId: id(1), issue: 2, version: plan.version,
      issueRevision: issueRevision(child), attemptId: id(2), blockedRevision: "d".repeat(40), revision, testFiles, validation, approvedAt: 1 };
    const records = new Map<string, Claim>([
      ["1", { ...parent, ...shared, phase: "submitted", approval: approval(parent), target: { branch: "feat/parent", head: mergedHead },
        pull: merged, delivery: { baseRevision: base, files: [source], dependsOn: [], instructions: "上游" } }],
      ["2", { ...child, ...shared, phase: "deliveryFailed", approval: approval(child), retryCount: 1,
        retriedWorkerAttempt: id(2), recoveryDispatchAttempt: scenario === "unknown-lineage" ? id(99) : id(4),
        failure: { stage: "device", reason: "device-failed", workerStage: "patch" },
        sourceRefresh: { revision, state: "passed", amendmentId: scenario === "wrong-amendment" ? id(99) : amendment.id, woken: true },
        prePrAmendments: [amendment], ...(scenario === "consumed-receipt" ? { recoveredWorkerAttempts: [id(4)] } : {}),
        delivery: { baseRevision: base, files, dependsOn: [1], instructions: "下游", sourcePaths: [source], sourceFrom: [{ issue: 1, path: source }] } }],
    ]);
    if (deviceMode) {
      const claim = records.get("2");
      assert.ok(claim);
      claim.deviceWait = { version: 1, binding: deviceWaitBinding("a/b", claim), offered: scenario === "wrong-offer" ? id(99) : id(4) };
    }
    const original = structuredClone(records.get("2"));
    const proposals = new Map<string, IssueProposal>([[id(1), { id: id(1), flowId: flow.id, actor: "member", planId: plan.id, version: plan.version,
      base, items: [], drafts, published: [1, 2], sourceHandoff: true, quality, status: "submitted", approvedAt: 1, createdAt: 0 }]]);
    let latestAttempt = id(4), starts = 0, publications = 0, reviews = 0, reviewTransient = scenario === "review-transient";
    let refuseOfferSave = scenario === "offer-save-failed";
    const events: string[] = [];
    const childPull: IssuePull = { number: 11, url: "https://github.com/a/b/pull/11", state: "OPEN", head: "e".repeat(40), baseName: "main" };
    const tracker: DeliveryTracker = { repo: "a/b", account: async () => "member", assign: async () => assert.fail("不重新认领"), candidates: async () => [],
      read: async n => n === 1 ? parent : { ...child, ...(scenario === "wrong-issue" ? { body: "未批准需求" } : {}),
        ...(scenario === "wrong-owner" ? { assignees: ["other"] } : {}), pulls: publications ? [childPull] : [] },
      delivery: { checkout: async () => assert.fail("调度夹具"),
        find: async branch => branch === "feat/parent" ? { ...merged, ...(scenario === "wrong-parent" ? { head: base } : {}) } : publications ? childPull : undefined,
        publish: async () => { publications++; return childPull; } } };
    const requested = { issue: 2, requestId: id(1), version: scenario === "wrong-version" ? 99 : plan.version,
      issueRevision: issueRevision(child), revision: scenario === "wrong-revision" ? "f".repeat(40) : revision,
      attemptId: scenario === "old-request" ? id(2) : id(4), requireAmendment: true as const };
    const recoveryRequests = new Set(scenario === "no-request" ? [] : [requested.attemptId]);
    for (let restart = 0; restart < 3; restart++) {
      let conversation: ReturnType<typeof createConversationDelivery>;
      const options: IssueDeliveryOptions = { specs: new Map(), pollMs: 60_000, conversation: true, requireQuality: true,
        ...(deviceMode ? { executionMode: "device" as const, hasAnyWorkerAttempt: () => true } : {}),
        sourceRefresh: requested, recoverDeviceTestAttempts: recoveryRequests, hasWorkerAttempt: () => true,
        failedWorkerAttempt: () => ({ id: latestAttempt, failureStage: "patch" }),
        reviewScopeCurrent: c => scenario !== "scope-revoked" && !!conversation?.reviewScope(c, flow),
        reviewSourceHandoff: (c, proof, sources, signal) => conversation.reviewHandoff(c, flow, proof, sources, signal),
        async prepare({ spec, sourceHandoff, revalidateWorker, workerOffered, branch, previousFailure, requireDevice }, connected, signal) {
          assert.equal(requireDevice, deviceMode ? true : undefined);
          assert.ok(sourceHandoff);
          assert.equal(sourceHandoff.refreshRevision, revision);
          assert.equal(sourceHandoff.reuseApprovedRevision, true);
          assert.deepEqual(spec.files, [...files, ...testFiles]);
          assert.equal(previousFailure?.workerStage, "patch");
          const producers = await sourceHandoff.current("main", signal);
          await sourceHandoff.review({ original: base, execution: revision, producers, changedPaths: [source], blobs: [], refreshed: true },
            Object.fromEntries([...files, ...testFiles, source].map(path => [path, "已批准源码"])), signal);
          await revalidateWorker?.(signal);
          sourceHandoff.ready();
          assert.equal(records.get("2")?.phase, deviceMode ? "waitingDevice" : "developing");
          await revalidateWorker?.(signal);
          const offered = id(5 + starts);
          workerOffered?.(offered);
          if (deviceMode) {
            assert.equal(records.get("2")?.phase, "deviceOffered");
            assert.equal(records.get("2")?.deviceWait?.offered, offered);
            assert.equal(records.get("2")?.pendingWorkerAttempt, undefined);
            connected(`thread-${offered}`);
            assert.equal(records.get("2")?.phase, "developing");
          }
          latestAttempt = offered;
          starts++;
          if (scenario === "fails-again") throw new IssueDeliveryFailed({ stage: "device", reason: "device-failed", workerStage: "patch" });
          return { workspace: "fixture", branch, base: "main", head: childPull.head as string, executionRevision: revision };
        } };
      const dispatch = createIssueDispatch(tracker, { load: memory(records).load, save(key, value, event) {
        const action = (event?.details as { action?: string } | undefined)?.action;
        if (action === "worker-redispatched" && refuseOfferSave) { refuseOfferSave = false; return false; }
        if (action) events.push(action);
        return memory(records).save(key, value);
      } }, async () => assert.fail("不改走只读核验"), () => true, 2, new Map(), options);
      conversation = createConversationDelivery(dispatch, memory(proposals), async () => [], passingQualityReview, async () => ({}), {
        draft: async () => assert.fail("不改原草稿"), publish: createPlannedIssuePublication(memory()), connection: () => tracker,
        sourceReview: { concurrency: 1, reviewer: async packet => {
          reviews++;
          if (reviewTransient) { reviewTransient = false; throw new IssueDeliverySourcesChanged(); }
          assert.equal(packet.revision, revision);
          assert.deepEqual(packet.ticket.paths, [...files, ...testFiles]);
          return JSON.stringify({ status: scenario === "review-blocked" ? "block" : "pass", summary: "复核固定授权",
            evidence: [source, ...testFiles].map(path => ({ ref: `repo:${path}`, quote: "已批准源码" })) });
        } },
      });
      try {
        for (let n = 0; n < 3; n++) { await dispatch.refresh(); await setImmediate(); }
        const shown = dispatch.snapshot(false).items.find(item => item.number === 2);
        assert.ok(shown);
        assert.equal(Object.hasOwn(shown, "recoveredWorkerAttempts"), false, "内部消费清单不进入公开快照");
        if (starts) assert.equal("retryCount" in shown ? shown.retryCount : undefined, 1 + starts, "界面仍能读取准确的累计次数");
      }
      finally { await conversation.close(); await dispatch.close(); }
      if (scenario === "fails-again" && restart === 1) {
        assert.equal(starts, 1, "再次失败不会凭旧恢复配置自动重跑");
        requested.attemptId = latestAttempt;
        recoveryRequests.add(latestAttempt);
      }
    }
    const expected = ["success", "review-transient", "offer-save-failed"].includes(scenario) ? 1 : scenario === "fails-again" ? 2 : 0;
    assert.equal(starts, expected);
    assert.equal(publications, scenario === "fails-again" ? 0 : expected);
    assert.equal(events.filter(action => action === "worker-redispatched").length, expected);
    assert.deepEqual(records.get("2")?.approval, original?.approval);
    assert.deepEqual(records.get("2")?.delivery, original?.delivery);
    assert.deepEqual(records.get("2")?.prePrAmendments, [amendment]);
    if (expected) {
      assert.ok(reviews >= expected);
      assert.equal(records.get("2")?.retryCount, 1 + expected);
      assert.deepEqual(records.get("2")?.recoveredWorkerAttempts, expected === 2 ? [id(2), id(4), id(5)] : [id(2), id(4)]);
      assert.equal(records.get("2")?.pendingWorkerAttempt, undefined);
    }
    });
  }
});
