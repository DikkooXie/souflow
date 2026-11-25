import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { issueRevision, type DeliveryTracker, type IssueDetail } from "../src/connections/issue-tracker.mts";
import { currentDevelopmentPlan } from "../src/planning/conversation-flow.mts";
import { readGitHubSelection } from "../src/planning/github-selection.mts";
import { snapshotIssueCandidates } from "../src/planning/project-context.mts";
import { createConversationDelivery, type IssueProposal } from "../src/workbench/conversation-delivery.mts";
import { type Claim, createIssueDispatch } from "../src/workbench/issue-dispatch.mts";
import { createPlannedIssuePublication, type IssuePublication } from "../src/workbench/planned-issue-publication.mts";
import { passingQualityReview, qualityReviewOutput, readyQualityFlow, validation } from "./fixtures/planning-quality.mts";

const makeIssue = (number: number, body = "实施并验证。"): IssueDetail => ({
  number, title: `工单 ${number}`, body, url: `https://github.com/a/b/issues/${number}`, assignees: [], pulls: [], state: "OPEN",
});
const available = new Set(["src/main.mts", "tests/main.test.mts"]);
const route = "src/route.mts";
const readable = new Set([...available, route]);
const up = { number: 1, reason: "首版校验", instructions: "修复校验。", files: ["src/main.mts"], dependsOn: [],
  criteria: ["AC-1"], validation, sourcePaths: [route] };
const down = { ...up, number: 2, files: ["tests/main.test.mts"], dependsOn: [1] };

test("只选择真实候选及冻结路径，保留 Issue 声明的前置", () => {
  const issues = [makeIssue(1), makeIssue(2, "依赖 https://github.com/a/b/issues/1 合并。")];
  const read = (value: unknown[]) => readGitHubSelection(JSON.stringify({ issues: value }), issues, available, ["AC-1"], readable);
  assert.deepEqual(read([up, down]).map(item => item.dependsOn), [[], [1]]);
  assert.deepEqual(read([up])[0]?.sourcePaths, [route]);
  for (const bad of [
    [{ ...up, number: 999 }], [{ ...up, files: ["src/not-at-this-version.mts"] }],
    [up, { ...down, files: up.files }], [up, { ...down, dependsOn: [] }],
    [{ ...up, validation: [] }],
    [{ ...up, files: [route] }], [{ ...up, sourcePaths: ["../.env"] }], [{ ...up, sourcePaths: [route, route] }],
    [{ ...up, dependsOn: [2] }, down],
  ]) assert.throws(() => read(bad));
});

test("保留 Issue 正文中用井号声明的依赖，拒绝遗漏该依赖的选单", () => {
  const issues = [makeIssue(1), makeIssue(2, "- 依赖 #1")];
  const read = (value: unknown[]) => readGitHubSelection(JSON.stringify({ issues: value }), issues, available, ["AC-1"], readable);

  assert.deepEqual(read([up, down])[1]?.dependsOn, [1]);
  assert.throws(() => read([up, { ...down, dependsOn: [] }]));
});

test("授权卡仅由发起者回答，固定计划并阻止双击重复派发", async () => {
  const flow = await readyQualityFlow("继续推进首版开发");
  flow.project = { repository: { revision: "f".repeat(40), commits: [] }, plan: { status: "read" }, github: { status: "read" } };
  const saved = new Map<string, IssueProposal>();
  const approvals: unknown[] = [];
  const item = makeIssue(1);
  const service = (fail = false) => createConversationDelivery({
    permits: () => true, suggest: async () => [item],
    async claimApproved(_id, actor, specs, approval) {
      approvals.push({ actor, specs, approval });
      if (fail) throw Error("批量认领中断。");
    },
  }, { load: () => [...saved.values()], save(id, p) { saved.set(id, structuredClone(p)); return true; } },
  async () => readGitHubSelection(JSON.stringify({ issues: [up] }), [item], available, ["AC-1"], readable),
  passingQualityReview, async (_revision, paths) => {
    assert.deepEqual(paths, ["src/main.mts", route]);
    return { [route]: "export const path = '/api/state';", "src/main.mts": "export const feature = true;" };
  });
  const initial = service();
  initial.begin(flow, "首版");
  await setImmediate();
  assert.equal(approvals.length, 0);
  assert.equal(initial.cards([flow], "other").length, 0);
  const card = initial.cards([flow], "member")[0];
  assert.ok(card);
  await initial.close();
  const pending = saved.get(card.id);
  assert.ok(pending);
  assert.ok(pending.quality);
  assert.deepEqual(initial.statuses([flow], "member")[0]?.quality, pending.quality);
  assert.deepEqual(initial.statuses([flow], "other"), []);
  assert.equal(Object.hasOwn(card, "quality"), false);
  const response = { authorization: "授权执行并开草稿 PR" };
  const failed = service(true);
  assert.equal(await failed.answer(card.id, "member", response, [flow]), 409);
  await failed.close();
  const recovered = service();
  assert.ok(recovered.locks(flow.id));
  assert.equal(recovered.statuses([flow], "member")[0]?.approved, true);
  assert.equal(recovered.begin(flow, "首版", true), false);
  await recovered.close();

  saved.set(card.id, pending);
  approvals.length = 0;
  const resumed = service();
  assert.equal(await resumed.answer(card.id, "other", response, [flow]), 404);
  const revised = structuredClone(flow);
  const plan = currentDevelopmentPlan(revised);
  assert.ok(plan);
  const revise = (change: Partial<typeof plan>) => {
    revised.outputs = flow.outputs.map(output => ({ ...output, artifacts: output.artifacts.map(artifact =>
      artifact.id === plan.id ? { ...artifact, ...change } : artifact) }));
  };
  revise({ version: 2 });
  assert.deepEqual(resumed.statuses([revised], "member"), []);
  assert.equal(await resumed.answer(card.id, "member", response, [revised]), 409);
  revise({ sections: [{ title: "开发计划", text: "相同版本号、不同正文" }] });
  assert.equal(await resumed.answer(card.id, "member", response, [revised]), 409);
  assert.equal(await resumed.answer(card.id, "member", { ...response, issue: 99 }, [flow]), 422);
  assert.deepEqual((await Promise.all([
    resumed.answer(card.id, "member", response, [flow]), resumed.answer(card.id, "member", response, [flow]),
  ])).sort(), [200, 409]);
  const { policy, flowDigest, batchDigest } = pending.quality;
  assert.deepEqual(approvals, [{ actor: "member", approval: { flowId: flow.id, planId: plan.id, version: 1,
    quality: { policy, flowDigest, batchDigest } },
    specs: new Map([[1, { instructions: `${up.instructions}\nAC-1：按确认指引操作后检查产物 → 产物符合验收要求`,
      files: up.files, sourcePaths: [route], dependsOn: [], baseRevision: "f".repeat(40), issueRevision: issueRevision(item) }]]) }]);
  assert.ok(resumed.locks(flow.id));
  await resumed.close();
});

test("批量认领先核对所有 Issue 内容，变更时不执行外部写操作", async () => {
  const items = [makeIssue(1), makeIssue(2)];
  const changed = makeIssue(2, "需求已变化。");
  let writes = 0;
  const tracker: DeliveryTracker = { repo: "a/b", account: async () => "login", read: async n => n === 1 ? makeIssue(1) : changed,
    candidates: async () => items, assign: async () => { writes++; }, delivery: {
      checkout: async () => assert.fail("不得执行"), find: async () => undefined, publish: async () => assert.fail("不得发布"),
    } };
  const github = createIssueDispatch(tracker, { load: (): Claim[] => [], save: () => true },
    async () => assert.fail("不得执行"), () => true, 1, new Map(), {
      specs: new Map(), conversation: true, pollMs: 60_000, prepare: async () => assert.fail("不得执行"),
    });
  try {
    await assert.rejects(github.claim("manual", "member"), /待决策/);
    await assert.rejects(github.claimApproved("id", "member", new Map(items.map(item => [item.number,
      { instructions: "已确认", files: up.files, dependsOn: [], issueRevision: issueRevision(item) }])),
      { flowId: "flow", planId: "plan", version: 1 }), /改变|变化/);
    assert.equal(writes, 0);
  } finally { await github.close(); }
});

test("有验收编号但验证不对应时，不生成 GitHub 授权卡，也不认领", async () => {
  const flow = await readyQualityFlow();
  flow.project = { repository: { revision: "a".repeat(40), commits: [] }, plan: { status: "read" }, github: { status: "read" } };
  const item = makeIssue(1);
  const checks = [{ criterion: "AC-1", procedure: "首次确认纪要", expected: "发送一次待办" }];
  const store = new Map<string, IssueProposal>();
  const service = createConversationDelivery({
    permits: () => true, suggest: async () => [item],
    claimApproved: async () => assert.fail("未经复核不能认领"),
  }, { load: () => [...store.values()], save(id, value) { store.set(id, structuredClone(value)); return true; } },
  async () => readGitHubSelection(JSON.stringify({ issues: [{ ...up, validation: checks }] }), [item], available, ["AC-1"], readable),
  async packet => JSON.stringify({
    ...qualityReviewOutput(packet),
    verification: { status: "block", summary: "首次确认没有验证重复确认的幂等行为 sk-abcdefghijklmnop",
      evidence: [{ ref: "test:1:AC-1", quote: "首次确认纪要" }] },
  }), async () => ({ [route]: "只读参考", "src/main.mts": "可编辑源码" }));
  try {
    assert.equal(service.begin(flow, "首版"), true);
    await setImmediate();
    const status = service.statuses([flow], "member")[0];
    assert.equal(status?.status, "blocked");
    assert.match(status.error ?? "", /幂等/);
    assert.deepEqual(status.quality?.checks.verification, {
      status: "block", summary: "首次确认没有验证重复确认的幂等行为 [已隐藏凭据]",
      evidence: [{ ref: "test:1:AC-1", quote: "首次确认纪要" }],
    });
    assert.deepEqual(service.statuses([flow], "other"), []);
    assert.deepEqual(service.cards([flow], "member"), []);
    const id = store.keys().next().value;
    assert.ok(id);
    assert.equal(await service.answer(id, "member", { authorization: "授权执行并开草稿 PR" }, [flow]), 409);
  } finally { await service.close(); }
});

test("源码引用超出复核预算时保留重试入口，不生成授权卡", async () => {
  const flow = await readyQualityFlow();
  flow.project = { repository: { revision: "a".repeat(40), commits: [] }, plan: { status: "read" }, github: { status: "read" } };
  const issue = makeIssue(1);
  const service = createConversationDelivery({
    permits: () => true, suggest: async () => [issue], claimApproved: async () => assert.fail("不能认领"),
  }, { load: () => [], save: () => true },
  async () => readGitHubSelection(JSON.stringify({ issues: [up] }), [issue], available, ["AC-1"], readable),
  async () => assert.fail("必须加载全部源码才进入复核"), async () => ({ "src/main.mts": "编辑源码" }));
  try {
    assert.equal(service.begin(flow, "首版"), true);
    await setImmediate();
    assert.match(service.statuses([flow], "member")[0]?.error ?? "", /源码无法装入复核资料/);
    assert.deepEqual(service.cards([flow], "member"), []);
    assert.equal(service.begin(flow, "首版", true), true);
  } finally { await service.close(); }
});

test("Issue 正文在规划后变化时不进入选单或授权", async () => {
  const flow = await readyQualityFlow();
  const item = makeIssue(1);
  flow.project = { repository: { revision: "a".repeat(40), commits: [] }, plan: { status: "read" },
    github: { status: "read" }, issueCandidates: snapshotIssueCandidates([item]) };
  const service = createConversationDelivery({
    permits: () => true, suggest: async () => [{ ...item, body: "规划之后的不同范围。" }],
    claimApproved: async () => assert.fail("不能认领已经变化的工单"),
  }, { load: () => [], save: () => true }, async () => assert.fail("不能使用非本轮冻结候选"),
  passingQualityReview, async () => ({}));
  try {
    assert.equal(service.begin(flow, "首版"), true);
    await setImmediate();
    assert.match(service.statuses([flow], "member")[0]?.error ?? "", /候选 Issue 已变化/);
    assert.deepEqual(service.cards([flow], "member"), []);
    flow.project.issueCandidates = [];
    assert.equal(service.begin(flow, "首版", true), true);
    await setImmediate();
    assert.match(service.statuses([flow], "member")[0]?.error ?? "", /候选 Issue 已变化/);
    assert.deepEqual(service.cards([flow], "member"), []);
  } finally { await service.close(); }
});

test("一次授权批量认领后，只派发就绪工单，合并后接续下游", async () => {
  const items = new Map([[1, makeIssue(1)], [2, makeIssue(2)]]);
  const records = new Map<string, Claim>();
  const started: number[] = [];
  const merge = "b".repeat(40);
  let upstreamMerged = false;
  const getItem = (number: number) => {
    const item = items.get(number);
    assert.ok(item);
    return item;
  };
  const tracker: DeliveryTracker = { repo: "a/b", account: async () => "login", read: async n => structuredClone(getItem(n)),
    candidates: async () => [...items.values()].filter(item => !item.assignees.length),
    assign: async (number, login) => { getItem(number).assignees = [login]; },
    delivery: {
      checkout: async () => assert.fail("由夹具提供工作区"),
      find: async (_branch, _head, knownPull) => knownPull === 101 ? { number: 101, url: "https://github.com/a/b/pull/101",
        state: upstreamMerged ? "MERGED" : "OPEN", ...(upstreamMerged ? { mergeCommit: merge } : {}) } : undefined,
      publish: async ({ issue }) => ({ number: 100 + issue, url: `https://github.com/a/b/pull/${100 + issue}`, state: "OPEN" }),
    } };
  const github = createIssueDispatch(tracker, { load: () => [...records.values()],
    save(id, c) { records.set(id, structuredClone(c)); return true; } }, async () => assert.fail("不得进入核验"),
  () => true, 2, new Map(), {
    specs: new Map(), conversation: true, pollMs: 60_000,
    prepare: async ({ number, branch, upstream }) => {
      assert.deepEqual(upstream, number === 2 ? [merge] : []);
      started.push(number);
      return { workspace: "fixture", branch, base: "main", head: "a".repeat(40) };
    },
  });
  try {
    const specs = new Map([up, down].map(({ number, instructions, files, dependsOn }) => [number, {
      instructions, files, dependsOn, issueRevision: issueRevision(getItem(number)),
    }]));
    await github.claimApproved("id", "member", specs, { flowId: "flow", planId: "plan", version: 1 });
    await setImmediate();
    assert.deepEqual(started, [1]);
    assert.equal(records.get("2")?.phase, "waiting");
    upstreamMerged = true;
    await github.refresh();
    await setImmediate();
    await github.refresh();
    assert.deepEqual(started, [1, 2]);
    assert.equal(records.get("2")?.pull?.number, 102);
  } finally { await github.close(); }
});

test("从新需求复核和授权，创建 Issue 后认领派发，重启后能找回丢失的建单回执", async () => {
  const flow = await readyQualityFlow("实现一个尚未建单的新需求。");
  flow.project = { repository: { revision: "a".repeat(40), commits: [] }, plan: { status: "read" }, github: { status: "read" } };
  const proposals = new Map<string, IssueProposal>();
  const receipts = new Map<string, IssuePublication>();
  const claims = new Map<string, Claim>();
  const remote = new Map<number, IssueDetail>();
  const writes: string[] = [];
  let visible = false;
  let merged = false;
  const merge = "b".repeat(40);
  function read(number: number) {
    const issue = remote.get(number);
    assert.ok(issue);
    return issue;
  }
  const tracker: DeliveryTracker = {
    repo: "a/b", account: async () => "login", candidates: async () => [...remote.values()],
    read: async number => structuredClone(read(number)),
    assign: async (number, account) => {
      assert.equal(remote.size, 2);
      writes.push(`认领 ${number}`);
      read(number).assignees = [account];
    },
    creation: {
      async create({ title, body }) {
        const number = 10 + remote.size;
        writes.push(`创建 ${number}`);
        remote.set(number, { ...makeIssue(number, body), title });
        if (number === 10) throw Error("GitHub 已写入，响应断开。");
        return number;
      },
      async findCreated(marker) {
        return visible ? [...remote.values()].filter(issue => issue.body.split("\n").includes(marker)).map(issue => issue.number) : [];
      },
    },
    delivery: {
      checkout: async () => assert.fail("由夹具提供工作区"),
      publish: async ({ issue }) => ({ number: 100 + issue, url: `https://github.com/a/b/pull/${100 + issue}`, state: "OPEN" }),
      find: async (_branch, _head, knownPull) => knownPull === 110 ? { number: 110, url: "https://github.com/a/b/pull/110",
        state: merged ? "MERGED" : "OPEN", ...(merged ? { mergeCommit: merge } : {}) } : undefined,
    },
  };
  const store = <T extends object>(rows: Map<string, T>) => ({
    load: () => [...rows.values()], save(id: string, value: T) { rows.set(id, structuredClone(value)); return true; },
  });
  const github = createIssueDispatch(tracker, store(claims), async () => assert.fail("不得进入只读核验"), () => true, 2,
    new Map([["member", tracker]]), { specs: new Map(), conversation: true, requireQuality: true, pollMs: 60_000,
      prepare: async ({ number, branch, upstream }) => {
        assert.deepEqual(upstream, number === 11 ? [merge] : []);
        writes.push(`开发 ${number}`);
        return { workspace: "fixture", branch, base: "main", head: "a".repeat(40) };
      },
    });
  const makeService = () => createConversationDelivery(github, store(proposals), async () => "new", passingQualityReview,
    async (_revision, paths) => Object.fromEntries(paths.map(path => [path, "冻结的源码"])), {
      draft: async () => [
        { id: "T2", title: "下游工单", instructions: "在合并后验证。", paths: down.files, dependsOn: ["T1"], criteria: up.criteria, validation },
        { id: "T1", title: "上游工单", instructions: "实现新需求。", paths: up.files, dependsOn: [], criteria: up.criteria, validation },
      ],
      publish: createPlannedIssuePublication(store(receipts)), connection: actor => actor === "member" ? tracker : undefined,
    });
  const initial = makeService();
  let restarted: ReturnType<typeof makeService> | undefined;
  try {
    assert.equal(initial.begin(flow, "首版"), true);
    await setImmediate();
    const card = initial.cards([flow], "member")[0];
    assert.ok(card);
    assert.match(card.prompt, /T2 · 下游工单/);
    const answer = { authorization: "授权创建 Issue、执行并开草稿 PR" };
    const changedFlow = { ...flow, prompt: "授权后改变的原始需求" };
    assert.equal(await initial.answer(card.id, "member", answer, [changedFlow]), 409);
    assert.equal(await initial.answer(card.id, "other", answer, [flow]), 404);
    assert.equal(await initial.answer(card.id, "member", { authorization: "授权执行并开草稿 PR" }, [flow]), 422);
    assert.equal(writes.length, 0);
    assert.equal(await initial.answer(card.id, "member", answer, [flow]), 409);
    assert.deepEqual(writes, ["创建 10"]);
    assert.deepEqual(await github.suggest(), []);
    await initial.close();
    restarted = makeService();
    assert.equal(await restarted.resumePublication(flow, "other"), 409);
    assert.equal(await restarted.resumePublication(flow, "member"), 409);
    assert.deepEqual(writes, ["创建 10"]);

    visible = true;
    assert.equal(await restarted.resumePublication(flow, "member"), 200);
    await setImmediate();
    assert.deepEqual(writes, ["创建 10", "创建 11", "认领 11", "认领 10", "开发 10"]);
    assert.match(read(11).body, /^依赖 #10$/m);
    assert.equal(claims.get("11")?.phase, "waiting");
    assert.deepEqual(restarted.statuses([flow], "member")[0]?.issues, [11, 10]);
    assert.equal(await restarted.resumePublication(flow, "member"), 409);
    await github.refresh();
    assert.equal(writes.includes("开发 11"), false);
    merged = true;
    await github.refresh();
    await setImmediate();
    assert.deepEqual(writes.slice(-2), ["开发 10", "开发 11"]);
    assert.equal(claims.get("11")?.pull?.number, 111);
  } finally {
    await Promise.all([initial.close(), restarted?.close(), github.close()]);
  }
});

test("认领已写入但回读失败时，重启后续办不会重复指派", async () => {
  const item = makeIssue(10);
  const saved = new Map<string, Claim>();
  let assignments = 0;
  let starts = 0;
  let failRead = false;
  const tracker: DeliveryTracker = {
    repo: "a/b", account: async () => "login", candidates: async () => [],
    read: async () => {
      if (failRead) throw Error("GitHub 回读中断。");
      return structuredClone(item);
    },
    assign: async (_number, account) => {
      assignments++;
      item.assignees = [account];
      failRead = true;
    },
    delivery: {
      checkout: async () => assert.fail("由夹具提供工作区"),
      find: async () => undefined,
      publish: async () => ({ number: 110, url: "https://github.com/a/b/pull/110", state: "OPEN" }),
    },
  };
  const dispatcher = () => createIssueDispatch(tracker, {
    load: () => [...saved.values()], save(id, item) { saved.set(id, structuredClone(item)); return true; },
  }, async () => assert.fail("不得进入核验"), () => true, 1, new Map(), {
    specs: new Map(), conversation: true, pollMs: 60_000,
    prepare: async ({ branch }) => {
      starts++;
      return { workspace: "fixture", branch, base: "main", head: "a".repeat(40) };
    },
  });
  const approved = new Map([[item.number, { instructions: "已确认。", files: up.files, dependsOn: [], issueRevision: issueRevision(item) }]]);
  const authorization = { flowId: "flow", planId: "plan", version: 1 };
  const initial = dispatcher();
  try {
    await assert.rejects(initial.claimApproved("batch", "member", approved, authorization, true), /待核对/);
    assert.equal(saved.get("10")?.claimUncertain, true);
    assert.equal(starts, 0);
  } finally { await initial.close(); }
  failRead = false;
  const resumed = dispatcher();
  try {
    await assert.rejects(resumed.claimApproved("other-batch", "member", approved, authorization, true), /变化/);
    await resumed.claimApproved("batch", "member", approved, authorization, true);
    await setImmediate();
    assert.equal(assignments, 1);
    assert.equal(starts, 1);
    assert.equal(saved.get("10")?.pull?.number, 110);
  } finally { await resumed.close(); }
});

test("Issue 正文超出回读上限时不生成授权卡，原计划仍可修订", async () => {
  const flow = await readyQualityFlow();
  flow.project = { repository: { revision: "a".repeat(40), commits: [] }, plan: { status: "read" }, github: { status: "read" } };
  const tracker: DeliveryTracker = {
    repo: "a/b", account: async () => "login", candidates: async () => [],
    read: async () => assert.fail("未授权不得回读创建结果"),
    assign: async () => assert.fail("未授权不得认领"),
    creation: { create: async () => assert.fail("未授权不得建单"), findCreated: async () => [] },
    delivery: {
      checkout: async () => assert.fail("不得执行"), find: async () => undefined, publish: async () => assert.fail("不得发布"),
    },
  };
  const saved = new Map<string, IssueProposal>();
  const service = createConversationDelivery({
    permits: () => true, suggest: async () => [], claimApproved: async () => assert.fail("不得派发"),
  }, { load: () => [...saved.values()], save(id, proposal) { saved.set(id, structuredClone(proposal)); return true; } },
  async () => "new", async () => assert.fail("无效草稿不得进入复核"), async () => ({}), {
    draft: async () => [{ id: "T1", title: "过长工单", instructions: "说明".repeat(1_000),
      paths: up.files, dependsOn: [], criteria: up.criteria,
      validation: Array.from({ length: 10 }, (_, i) => ({
        criterion: `AC-${i + 1}`, procedure: "验证".repeat(250), expected: "结果".repeat(150),
      })) }],
    publish: async () => assert.fail("未授权不得发布"), connection: () => tracker,
  });
  try {
    assert.equal(service.begin(flow, "首版"), true);
    await setImmediate();
    assert.equal(service.cards([flow], "member").length, 0);
    assert.match(service.statuses([flow], "member")[0]?.error ?? "", /T1.*正文/);
    assert.equal(service.locks(flow.id), false);
    assert.equal(service.begin(flow, "首版", true), true);
  } finally { await service.close(); }
});

test("已保留到其他批次的 Issue 不会占满选单窗口", async () => {
  const marker = `<!-- souflow-issue:${"a".repeat(64)} -->`;
  const items = Array.from({ length: 10 }, (_, index) => makeIssue(index + 1, index < 8 ? marker : "可认领。"));
  const tracker: DeliveryTracker = {
    repo: "a/b", account: async () => "login", candidates: async () => items,
    read: async number => { const item = items[number - 1]; assert.ok(item); return item; },
    assign: async () => assert.fail("选单不得认领"),
    delivery: {
      checkout: async () => assert.fail("不得执行"), find: async () => undefined, publish: async () => assert.fail("不得发布"),
    },
  };
  const github = createIssueDispatch(tracker, { load: () => [], save: () => true }, async () => assert.fail("不得执行"),
    () => true, 1, new Map(), { conversation: true, specs: new Map(), pollMs: 60_000,
      prepare: async () => assert.fail("不得执行") });
  try { assert.deepEqual((await github.suggest()).map(issue => issue.number), [9, 10]); }
  finally { await github.close(); }
});
