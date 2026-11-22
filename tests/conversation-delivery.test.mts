import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { issueRevision, type DeliveryTracker, type IssueDetail } from "../src/connections/issue-tracker.mts";
import type { Flow } from "../src/planning/conversation-flow.mts";
import { readGitHubSelection } from "../src/planning/github-selection.mts";
import { createConversationDelivery, type IssueProposal } from "../src/workbench/conversation-delivery.mts";
import { type Claim, createIssueDispatch } from "../src/workbench/issue-dispatch.mts";

const makeIssue = (number: number, body = "实施并验证。"): IssueDetail => ({
  number, title: `工单 ${number}`, body, url: `https://github.com/a/b/issues/${number}`, assignees: [], pulls: [], state: "OPEN",
});
const available = new Set(["src/main.mts", "tests/main.test.mts"]);
const up = { number: 1, reason: "首版校验", instructions: "修复校验。", files: ["src/main.mts"], dependsOn: [] };
const down = { ...up, number: 2, files: ["tests/main.test.mts"], dependsOn: [1] };

test("只选择真实候选及冻结路径，保留 Issue 声明的前置", () => {
  const issues = [makeIssue(1), makeIssue(2, "依赖 https://github.com/a/b/issues/1 合并。")];
  const read = (value: unknown[]) => readGitHubSelection(JSON.stringify({ issues: value }), issues, available);
  assert.deepEqual(read([up, down]).map(item => item.dependsOn), [[], [1]]);
  for (const bad of [
    [{ ...up, number: 999 }], [{ ...up, files: ["src/not-at-this-version.mts"] }],
    [up, { ...down, files: up.files }], [up, { ...down, dependsOn: [] }],
    [{ ...up, dependsOn: [2] }, down],
  ]) assert.throws(() => read(bad));
});

test("授权卡仅由发起者回答，固定计划并阻止双击重复派发", async () => {
  const flow: Flow = { id: "f", title: "首版", prompt: "继续推进", requestedBy: "member",
    source: { id: "request", kind: "request", version: 1, upstream: [] }, status: "ready",
    outputs: [{ title: "文档", artifacts: [{ id: "plan", kind: "development-plan", version: 1, upstream: [],
      sections: [{ title: "开发计划", text: "版本一" }] }] }],
    project: { repository: { revision: "f".repeat(40), commits: [] }, plan: { status: "read" }, github: { status: "read" } },
  };
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
  async () => readGitHubSelection(JSON.stringify({ issues: [up] }), [item], available));
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
  const plan = revised.outputs[0]?.artifacts[0];
  assert.ok(plan);
  revised.outputs[0] = { title: "文档", artifacts: [{ ...plan, version: 2 }] };
  assert.equal(await resumed.answer(card.id, "member", response, [revised]), 409);
  assert.equal(await resumed.answer(card.id, "member", { ...response, issue: 99 }, [flow]), 422);
  assert.deepEqual((await Promise.all([
    resumed.answer(card.id, "member", response, [flow]), resumed.answer(card.id, "member", response, [flow]),
  ])).sort(), [200, 409]);
  assert.deepEqual(approvals, [{ actor: "member", approval: { flowId: "f", planId: "plan", version: 1 },
    specs: new Map([[1, { instructions: up.instructions, files: up.files, dependsOn: [], baseRevision: "f".repeat(40), issueRevision: issueRevision(item) }]]) }]);
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
