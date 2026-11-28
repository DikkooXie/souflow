import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { openActivityStore, type Checkpoint } from "../src/audit/activity-store.mts";
import { issueRevision, type DeliveryTracker, type IssueDetail, type IssuePull } from "../src/connections/issue-tracker.mts";
import { currentDevelopmentPlan, type StoredFlow } from "../src/planning/conversation-flow.mts";
import { qualityPacket, reviewQuality, reviewTicketSources, ticketSourceReviewReferenceLimit, type QualityTicket } from "../src/planning/dispatch-quality.mts";
import { createConversationDelivery, type IssueProposal } from "../src/workbench/conversation-delivery.mts";
import { createIssueDispatch, type Claim } from "../src/workbench/issue-dispatch.mts";
import { createPlannedIssuePublication } from "../src/workbench/planned-issue-publication.mts";
import { createPrePrAmendments, type PrePrAmendmentEvent } from "../src/workbench/pre-pr-amendment.mts";
import { matchesSourceRefresh, readApprovedSourceRefresh } from "../src/workbench/approved-source-refresh.mts";
import { createWorkbenchServer } from "../src/workbench/demo-server.mts";
import { passingQualityReview, readyQualityFlow, validation } from "./fixtures/planning-quality.mts";

const id = (last: number) => `00000000-0000-4000-8000-${String(last).padStart(12, "0")}`;
const base = "a".repeat(40), merge = "b".repeat(40), blocked = "c".repeat(40), revision = "d".repeat(40);
const source = "src/upstream.mts", main = "src/main.mts", extraTest = "tests/main.test.mts";
const requestId = id(1), attemptId = id(2), amendmentId = id(3);
const extraValidation = [{ criterion: "AC-1", procedure: "先验证离线设备；再验证超过容量的任务", expected: "离线设备不接单；容量满的设备不接单" }];
const input = () => ({ id: amendmentId, requestId, issue: 2, version: 1, issueRevision: "e".repeat(64),
  attemptId, blockedRevision: blocked, revision, testFiles: [extraTest], validation: extraValidation });
const approve = { authorization: "授权补充测试、重新复核并续派原工单" };

function memoryStore<T extends object>(rows = new Map<string, T>()): Checkpoint<T> {
  return { load: () => structuredClone([...rows.values()]), save(key, value) { rows.set(key, structuredClone(value)); return true; } };
}

test("追加请求只保存不可变事实，绑定原 owner、版本、失败尝试与两个源码提交", async () => {
  const a = input();
  let c: Claim = { number: 2, title: "原工单", url: "https://github.com/a/b/issues/2", state: "OPEN", assignees: ["member"], pulls: [],
    requestId, claimedBy: "member", account: "member", phase: "uncertain", syncedAt: 0, pendingWorkerAttempt: attemptId,
    sourceRefresh: { revision: blocked, state: "blocked" }, approval: { flowId: "flow", planId: "plan", version: 1, issueRevision: a.issueRevision } };
  const rows = new Map<string, PrePrAmendmentEvent>();
  const store = memoryStore(rows);
  let authorizations = 0;
  const gateway = { candidate: (_issue: number, actor: string) => actor === "member" ? c : undefined,
    claim: () => c, scope: () => ({ request: "原始需求", files: [main], criteria: [{ criterion: "AC-1", text: "原验收", procedure: "原步骤", expected: "原预期" }] }),
    async authorize(amendment: Parameters<ReturnType<typeof createIssueDispatch>["authorizeAmendment"]>[0]) {
      authorizations++;
      c = { ...c, prePrAmendments: [{ ...amendment, approvedAt: 1 }] };
      return 200;
    } };
  let service = createPrePrAmendments(store, gateway);
  assert.equal(service.submit("flow", "other", a), 409);
  assert.equal(service.submit("other-flow", "member", a), 409);
  for (const changed of [{ requestId: id(9) }, { version: 2 }, { issueRevision: "f".repeat(64) }, { attemptId: id(9) },
    { blockedRevision: "f".repeat(40) }, { issue: 9 }]) assert.equal(service.submit("flow", "member", { ...a, ...changed }), 409);
  for (const changed of [{ testFiles: ["src/main.test.mts"] }, { testFiles: ["tests/../main.test.mts"] },
    { testFiles: [extraTest, extraTest] }, { testFiles: [] }, { validation: [] }, { validation: [...extraValidation, ...extraValidation] },
    { unknown: true }]) assert.equal(service.submit("flow", "member", { ...a, ...changed }), 422);
  assert.equal(service.submit("flow", "member", { ...a, validation: [{ ...extraValidation[0], criterion: "AC-9" }] }), 409);
  assert.equal(service.submit("flow", "member", a), 200);
  assert.equal(service.submit("flow", "member", a), 200);
  assert.equal(rows.size, 1);
  assert.equal(service.submit("flow", "member", { ...a, revision: "f".repeat(40) }), 409);
  assert.equal(service.submit("flow", "member", { ...a, id: id(5) }), 409);
  assert.equal(service.cards("other").length, 0);
  assert.match(service.cards("member")[0]?.prompt ?? "", /再验证超过容量/);
  assert.equal(await service.answer(a.id, "other", approve), 404);
  assert.equal(await service.answer(a.id, "member", { ...approve, bypass: true }), 422);
  service = createPrePrAmendments(store, gateway);
  assert.equal(service.cards("member").length, 1);
  assert.equal(await service.answer(a.id, "member", approve), 200);
  assert.equal(await service.answer(a.id, "member", approve), 200);
  assert.equal(authorizations, 1);
  assert.equal(rows.size, 2);
  assert.deepEqual(rows.get(`request:${a.id}`), { kind: "request", amendment: { ...a, flowId: "flow", actor: "member" },
    at: (rows.get(`request:${a.id}`) as { at: number }).at });
});

test("同进程源码拦截后经追加授权重审，测试范围与两项断言进入设备和交付复核且只派一次", async () => {
  const flow = await readyQualityFlow();
  flow.project = { repository: { revision: base, commits: [] }, plan: { status: "read" }, github: { status: "read" } };
  const plan = currentDevelopmentPlan(flow);
  assert.ok(plan);
  const drafts: QualityTicket[] = [
    { id: "T1", title: "上游", instructions: "上游实现", paths: [source], criteria: ["AC-1"], dependsOn: [], validation },
    { id: "T2", title: "下游", instructions: "下游实现", paths: [main], sources: [source], criteria: ["AC-1"], dependsOn: ["T1"],
      validation: [{ criterion: "AC-1", procedure: "原步骤".repeat(160), expected: "原预期".repeat(95) }] },
  ];
  const quality = await reviewQuality(qualityPacket(flow, base, requestId, drafts),
    { id: requestId, base, items: drafts, sourceHandoff: true }, passingQualityReview, new AbortController().signal);
  const binding = { policy: quality.policy, flowDigest: quality.flowDigest, batchDigest: quality.batchDigest };
  const merged: IssuePull = { number: 10, url: "https://github.com/a/b/pull/10", state: "MERGED", head: merge,
    mergeCommit: merge, baseName: "main", ci: "SUCCESS" };
  const parent: IssueDetail = { number: 1, title: "上游", body: "原上游", state: "CLOSED", url: "https://github.com/a/b/issues/1", assignees: ["member"], pulls: [merged] };
  const child: IssueDetail = { ...parent, number: 2, title: "下游", body: "原下游", state: "OPEN", pulls: [] };
  const approval = (issue: IssueDetail) => ({ flowId: flow.id, planId: plan.id, version: plan.version, quality: binding, issueRevision: issueRevision(issue) });
  const claims = new Map<string, Claim>([
    ["1", { ...parent, requestId, claimedBy: "member", account: "member", syncedAt: 0, phase: "submitted", approval: approval(parent),
      target: { branch: "feat/parent", head: merge }, pull: merged, delivery: { baseRevision: base, files: [source], dependsOn: [], instructions: "原上游" } }],
    ["2", { ...child, requestId, claimedBy: "member", account: "member", syncedAt: 0, phase: "deliveryFailed", approval: approval(child),
      failure: { stage: "device", reason: "device-failed", workerStage: "tests" },
      delivery: { baseRevision: base, files: [main], instructions: "原下游", dependsOn: [1], sourcePaths: [source], sourceFrom: [{ issue: 1, path: source }] } }],
  ]);
  const originalDelivery = structuredClone(claims.get("2")?.delivery);
  const proposals = new Map<string, IssueProposal>([[requestId, { id: requestId, flowId: flow.id, actor: "member", planId: plan.id,
    version: plan.version, base, items: [], drafts, published: [1, 2], sourceHandoff: true, quality, status: "submitted", approvedAt: 1, createdAt: 0 }]]);
  const originalProposal = structuredClone(proposals.get(requestId));
  let latestAttempt = attemptId;
  let head = blocked;
  let reviewPass = false;
  let starts = 0, publishes = 0, reviews = 0;
  let service: ReturnType<typeof createConversationDelivery>;
  const targetPull: IssuePull = { number: 11, url: "https://github.com/a/b/pull/11", head: revision, state: "OPEN", baseName: "main" };
  const tracker: DeliveryTracker = { repo: "a/b", account: async () => "member", assign: async () => assert.fail("不能重新认领"),
    candidates: async () => [], read: async n => structuredClone(n === 1 ? parent : { ...child, pulls: publishes ? [targetPull] : [] }),
    delivery: { currentRevision: async () => head, checkout: async () => assert.fail("使用隔离夹具"),
      find: async branch => branch === "feat/parent" ? merged : publishes ? targetPull : undefined,
      publish: async () => { publishes++; return targetPull; } } };
  const refresh = { issue: 2, requestId, version: plan.version, issueRevision: issueRevision(child), revision: blocked, attemptId,
    requireAmendment: true as const };
  const dispatch = createIssueDispatch(tracker, memoryStore(claims), async () => assert.fail("不能进入只读核验"), () => true, 2,
    new Map([["member", tracker]]), { specs: new Map(), pollMs: 60_000, conversation: true, requireQuality: true,
      sourceRefresh: refresh, recoverDeviceTestAttempts: new Set([attemptId]), hasWorkerAttempt: () => true,
      failedWorkerAttempt: () => ({ id: latestAttempt, failureStage: "tests" }),
      reviewScopeCurrent: c => !!service?.reviewScope(c, flow),
      reviewSourceHandoff: (c, proof, sources, signal) => service.reviewHandoff(c, flow, proof, sources, signal),
      async prepare({ spec, sourceHandoff, revalidateWorker, workerOffered, branch }, _connected, signal) {
        assert.ok(sourceHandoff);
        assert.equal(sourceHandoff.reuseApprovedRevision, undefined, "首次追加授权仍要求检出的当前主干等于批准提交");
        const producers = await sourceHandoff.current("main", signal);
        const execution = sourceHandoff.refreshRevision;
        assert.ok(execution);
        await sourceHandoff.review({ original: base, execution, producers, changedPaths: [source], blobs: [], refreshed: true },
          { [main]: "原实现", [source]: "上游接口", [extraTest]: "原测试" }, signal);
        await revalidateWorker?.(signal);
        sourceHandoff.ready();
        assert.deepEqual(spec.files, [main, extraTest]);
        assert.match(spec.instructions, /先验证离线设备；再验证超过容量的任务/);
        assert.match(spec.instructions, /离线设备不接单；容量满的设备不接单/);
        workerOffered?.(id(4));
        starts++;
        latestAttempt = id(4);
        return { workspace: "fixture", branch, base: "main", head: revision, executionRevision: revision,
          checked: { head: revision, passingTests: ["AC-1 离线与容量"] } };
      } });
  service = createConversationDelivery(dispatch, memoryStore(proposals), async () => [], passingQualityReview, async () => ({}), {
    draft: async () => assert.fail("不能改原草稿"), publish: createPlannedIssuePublication(memoryStore()), connection: () => tracker,
    sourceReview: { concurrency: 1, async reviewer(packet, _signal, correction) {
      reviews++;
      if (reviewPass) {
        assert.equal(packet.revision, revision);
        assert.deepEqual(packet.ticket.paths, [main, extraTest]);
        assert.match(packet.ticket.validation[0]?.procedure ?? "", /再验证超过容量/);
        assert.match(packet.ticket.validation[0]?.expected ?? "", /容量满的设备不接单/);
        assert.ok((packet.ticket.validation[0]?.procedure.length ?? 0) > 500);
        assert.ok((packet.ticket.validation[0]?.expected.length ?? 0) > 300);
        assert.equal(packet.references[`repo:${extraTest}`], "原测试");
        if (!correction) return JSON.stringify({ status: "pass", summary: "缺补充测试引文", evidence: [{ ref: `repo:${source}`, quote: "上游接口" }] });
        assert.match(correction, /补充授权测试路径/);
      }
      return JSON.stringify({ status: reviewPass ? "pass" : "block", summary: reviewPass ? "补充范围已核对" : "原范围不能覆盖回归",
        evidence: [{ ref: `repo:${source}`, quote: "上游接口" }, ...(reviewPass ? [{ ref: `repo:${extraTest}`, quote: "原测试" }] : [])] });
    } },
  });
  const rows = new Map<string, PrePrAmendmentEvent>();
  const makeAmendments = () => createPrePrAmendments(memoryStore(rows), { candidate: dispatch.amendmentCandidate,
    claim: dispatch.amendmentClaim, scope: c => service.reviewScope(c, flow), authorize: dispatch.authorizeAmendment });
  let amendments = makeAmendments();
  try {
    await dispatch.refresh();
    await setImmediate();
    assert.equal(claims.get("2")?.sourceRefresh?.state, "blocked");
    assert.equal(starts, 0);
    head = revision;
    refresh.revision = revision;
    await dispatch.refresh();
    await setImmediate();
    assert.equal(reviews, 1, "新提交配置必须等待补充授权");
    const a = { ...input(), issueRevision: issueRevision(child), version: plan.version };
    assert.equal(amendments.submit(flow.id, "member", a), 200);
    assert.equal(amendments.cards("member").length, 1);
    latestAttempt = id(9);
    assert.equal(await amendments.answer(a.id, "member", approve), 409);
    latestAttempt = attemptId;
    head = "f".repeat(40);
    assert.equal(await amendments.answer(a.id, "member", approve), 409, "当前默认分支变化时不得授权");
    head = revision;
    reviewPass = true;
    amendments = makeAmendments();
    assert.deepEqual(await Promise.all([amendments.answer(a.id, "member", approve), amendments.answer(a.id, "member", approve)]), [200, 200]);
    await setImmediate();
    assert.equal(starts, 1);
    assert.equal(publishes, 1);
    assert.equal(reviews, 3, "原内容拦截后，补充资料须通过独立复核及引文校验");
    assert.equal(claims.get("2")?.recoveryDispatchAttempt, id(4));
    assert.equal(claims.get("2")?.sourceRefresh?.amendmentId, a.id);
    assert.deepEqual(claims.get("2")?.delivery, originalDelivery);
    assert.deepEqual(claims.get("2")?.approval, approval(child));
    assert.deepEqual(proposals.get(requestId), originalProposal);
    const scope = service.reviewScope(claims.get("2") as Claim, flow);
    assert.deepEqual(scope?.files, [main, extraTest]);
    assert.match(scope?.criteria[0]?.procedure ?? "", /再验证超过容量/);
    assert.match(scope?.criteria[0]?.expected ?? "", /容量满的设备不接单/);
    assert.equal(await amendments.answer(a.id, "member", approve), 200);
    assert.equal(amendments.submit(flow.id, "member", { ...a, id: id(8) }), 409);
    await dispatch.refresh();
    await setImmediate();
    assert.equal(starts, 1);
    assert.equal(publishes, 1);
    assert.equal(rows.size, 2);
  } finally { await service.close(); await dispatch.close(); }
});

test("主干变化拒绝续派后可撤回旧请求、追加新版，授权进行中不接受并发撤回", async () => {
  const a = input();
  const c: Claim = { number: 2, title: "原工单", url: "https://github.com/a/b/issues/2", state: "OPEN", assignees: ["member"], pulls: [],
    requestId, claimedBy: "member", account: "member", phase: "uncertain", syncedAt: 0, pendingWorkerAttempt: attemptId,
    sourceRefresh: { revision: blocked, state: "blocked" }, approval: { flowId: "flow", planId: "plan", version: 1, issueRevision: a.issueRevision } };
  const rows = new Map<string, PrePrAmendmentEvent>();
  let finish: (status: number) => void = () => assert.fail("尚未开始授权");
  const service = createPrePrAmendments(memoryStore(rows), { candidate: () => c, claim: () => c,
    scope: () => ({ request: "原请求", files: [main], criteria: [{ ...validation[0], criterion: "AC-1", text: "原验收",
      procedure: "原步骤", expected: "原结果" }] }), authorize: () => new Promise(resolve => { finish = resolve; }) });
  assert.equal(service.submit("flow", "member", a), 200);
  const pending = service.answer(a.id, "member", approve);
  assert.equal(await service.answer(a.id, "member", { authorization: "暂不修订" }), 409);
  finish(409);
  assert.equal(await pending, 409);
  assert.equal(await service.answer(a.id, "member", { authorization: "暂不修订" }), 200);
  assert.equal(service.submit("flow", "member", { ...a, id: id(9), revision: "f".repeat(40) }), 200);
  assert.equal(rows.size, 4);
  const restored = createPrePrAmendments(memoryStore(rows), { candidate: () => c, claim: () => c,
    scope: () => ({ request: "原请求", files: [main], criteria: [{ criterion: "AC-1", text: "原验收", procedure: "原步骤", expected: "原结果" }] }),
    authorize: async () => 409 });
  assert.deepEqual(restored.cards("member").map(card => card.id), [id(9)]);
});

test("源码引用容量覆盖改变的文件与新授权测试的并集，不丢未变更的补充测试依据", async () => {
  const flow = await readyQualityFlow();
  const changedPaths = [main, source, "src/three.mts", "src/four.mts", "src/five.mts", "src/six.mts", extraTest];
  const secondTest = "tests/remote.test.mts";
  const ticket: QualityTicket = { id: "T1", title: "原工单", instructions: "原要求", paths: [main, extraTest, secondTest],
    sources: changedPaths.filter(path => path !== main && path !== extraTest), criteria: ["AC-1"], dependsOn: [], validation };
  const handoff = { original: base, changedPaths, authorizedTestPaths: [extraTest, secondTest] };
  assert.equal(ticketSourceReviewReferenceLimit({ handoff }), 8);
  assert.equal(ticketSourceReviewReferenceLimit({ handoff: { original: base, changedPaths } }), 7);
  const sources = Object.fromEntries([...changedPaths, secondTest].map(path => [path, `固定源码 ${path}`]));
  const finding = await reviewTicketSources(qualityPacket(flow, base, requestId, [ticket]), ticket, sources,
    async packet => JSON.stringify({ status: "pass", summary: "完整核对八份源码",
      evidence: Object.entries(packet.references).map(([ref, quote]) => ({ ref, quote })) }), new AbortController().signal, handoff);
  assert.equal(finding.status, "pass");
  assert.equal(finding.evidence.length, 8);
});

test("要求追加授权的源码恢复仍显式绑定失败尝试，原格式保持兼容", () => {
  const config = { issue: 2, requestId, version: 1, issueRevision: "e".repeat(64), revision, attemptId };
  assert.deepEqual(readApprovedSourceRefresh(JSON.stringify(config)), config);
  assert.deepEqual(readApprovedSourceRefresh(JSON.stringify({ ...config, requireAmendment: true })), { ...config, requireAmendment: true });
  assert.throws(() => readApprovedSourceRefresh(JSON.stringify({ ...config, attemptId: undefined, requireAmendment: true })));
  assert.throws(() => readApprovedSourceRefresh(JSON.stringify({ ...config, requireAmendment: false })));
  const c: Claim = { number: 2, title: "原工单", url: "fixture", state: "OPEN", assignees: ["member"], pulls: [],
    requestId, claimedBy: "member", account: "member", phase: "uncertain", syncedAt: 0, pendingWorkerAttempt: attemptId,
    sourceRefresh: { revision: blocked, state: "blocked" }, failure: { stage: "device", reason: "device-failed", workerStage: "tests" },
    approval: { flowId: "flow", planId: "plan", version: 1, issueRevision: config.issueRevision,
      quality: { policy: 1, flowDigest: "a".repeat(64), batchDigest: "b".repeat(64) } },
    delivery: { baseRevision: base, files: [main], instructions: "原要求", dependsOn: [1], sourcePaths: [source], sourceFrom: [{ issue: 1, path: source }] } };
  assert.equal(matchesSourceRefresh(c, config), true, "默认仍能在新主干按原范围复核");
  assert.equal(matchesSourceRefresh(c, { ...config, requireAmendment: true }), false, "需要补充范围时先等追加授权");
});

test("原对话修订 HTTP 入口复用成员和原 owner 权限，非法请求不进入派发", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "souflow-amendment-http-"));
  const database = join(workspace, "audit.sqlite");
  const flow = await readyQualityFlow();
  flow.requestedBy = "implementer";
  const seed = openActivityStore(database);
  assert.equal(seed.checkpoint<StoredFlow>("flows").save(flow.id, { flow }), true);
  seed.close();
  const keys = { implementer: "a".repeat(32), reviewer: "b".repeat(32), second: "c".repeat(32) };
  const auth = (name: keyof typeof keys) => `Basic ${Buffer.from(`${name}:${keys[name]}`).toString("base64")}`;
  const server = createWorkbenchServer(0, [workspace, () => assert.fail("不能启动 Codex")], database, {
    members: { ...keys, additionalImplementers: { second: keys.second } }, qualityReviewer: passingQualityReview,
    issueTracker: { repo: "a/b", candidates: async () => [], account: async () => "member",
      read: async () => assert.fail("无有效修订不得回读 Issue"), assign: async () => assert.fail("不得认领") },
    issueDelivery: { specs: new Map(), pollMs: 60_000, conversation: true, image: "fixture", timeoutMs: 1_000 },
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const url = `http://127.0.0.1:${address.port}`;
    const route = `/api/workflows/${flow.id}/github-amendments`;
    const post = (actor?: keyof typeof keys, body: object = {}) => fetch(url + route, { method: "POST",
      headers: { origin: url, "content-type": "application/json", ...(actor ? { authorization: auth(actor) } : {}) }, body: JSON.stringify(body) });
    assert.equal((await post()).status, 401);
    assert.equal((await post("reviewer")).status, 403);
    assert.equal((await post("second", input())).status, 404);
    assert.equal((await post("implementer")).status, 422);
    assert.equal((await post("implementer", input())).status, 409);
  } finally {
    const closed = once(server, "workbenchClosed");
    server.close();
    server.closeAllConnections();
    await closed;
    await rm(workspace, { recursive: true, force: true });
  }
});
