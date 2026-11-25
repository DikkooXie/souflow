import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { issueRevision, type DeliveryTracker, type IssueDetail } from "../src/connections/issue-tracker.mts";
import { currentDevelopmentPlan } from "../src/planning/conversation-flow.mts";
import { createGitHubSelector, readGitHubSelection } from "../src/planning/github-selection.mts";
import { type BatchAcceptance, type PlannedTicket, qualityPacket, reviewQuality } from "../src/planning/dispatch-quality.mts";
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

test("现有 Issue 遗漏验收时允许原发起者重规划，旧未授权失败也能恢复", async () => {
  const flow = await readyQualityFlow("推进设备接入");
  flow.project = { repository: { revision: "a".repeat(40), commits: [] }, plan: { status: "read" }, github: { status: "read" } };
  const plan = currentDevelopmentPlan(flow);
  assert.ok(plan);
  const item = makeIssue(1);
  const oldError = "工单校验未通过：uncovered:AC-2。";
  const legacy = { id: "old", flowId: flow.id, actor: "member", planId: plan.id, version: plan.version,
    base: "a".repeat(40), items: [], status: "uncertain" as const, error: oldError, createdAt: 1 };
  const saved = new Map<string, IssueProposal>([
    [legacy.id, legacy],
    ["approved", { ...legacy, id: "approved", actor: "other", approvedAt: 2 }],
  ]);
  const service = createConversationDelivery({
    permits: () => true, suggest: async () => [item],
    claimApproved: async () => assert.fail("缺少验收覆盖不得认领"),
  }, { load: () => [...saved.values()], save(id, proposal) { saved.set(id, structuredClone(proposal)); return true; } },
  async () => readGitHubSelection(JSON.stringify({ issues: [up] }), [item], available, ["AC-1", "AC-2"], readable),
  async () => assert.fail("结构检查失败时不得进入内容复核"), async () => ({}));
  try {
    assert.equal(saved.get("approved")?.status, "uncertain");
    assert.equal(service.replanFeedback(flow, "other"), undefined);
    assert.equal(service.replanFeedback(flow, "member")?.batchId, "old");
    assert.match(service.replanFeedback(flow, "member")?.findings ?? "", /未覆盖验收项 AC-2/);
    assert.deepEqual(service.cards([flow], "member"), []);

    const next = { ...flow, outputs: flow.outputs.map(output => ({ ...output, artifacts: output.artifacts
      .filter(artifact => artifact.kind !== "ticket-drafts")
      .map(artifact => artifact.id === plan.id ? { ...artifact, version: plan.version + 1 } : artifact) })) };
    assert.equal(service.begin(next, "当前计划"), true);
    await setImmediate();
    const status = service.statuses([next], "member")[0];
    assert.equal(status?.status, "blocked");
    assert.match(status?.error ?? "", /未覆盖验收项 AC-2/);
    assert.notEqual(service.replanFeedback(next, "member")?.batchId, "old");
    assert.deepEqual(service.cards([next], "member"), []);
  } finally { await service.close(); }
});

test("GitHub 选单验收映射错误时，在同一冻结资料内只修正一次", async t => {
  const repo = await mkdtemp(join(tmpdir(), "souflow-selection-repair-"));
  t.after(() => rm(repo, { recursive: true, force: true }));
  for (const path of [...up.files, route]) {
    await mkdir(join(repo, dirname(path)), { recursive: true });
    await writeFile(join(repo, path), "export const valid = true;\n");
  }
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo }).toString().trim();
  git("init", "-q");
  git("add", "src");
  git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--no-gpg-sign", "-qm", "fixture");
  const flow = await readyQualityFlow();
  flow.project = { repository: { revision: git("rev-parse", "HEAD"), commits: [] }, plan: { status: "read" }, github: { status: "read" } };
  const signal = new AbortController().signal;
  const issue = makeIssue(1);
  async function select(second: typeof up, first: typeof up = { ...up, validation: [] }) {
    const calls: { prompt: string; context?: string }[] = [];
    const selector = createGitHubSelector(repo, { timeoutMs: 2000, newIssues: true }, options => {
      calls.push({ prompt: options.prompt, ...(options.untrustedContext ? { context: options.untrustedContext } : {}) });
      const candidate = calls.length === 1 ? first : second;
      return { finished: Promise.resolve("completed"), output: () => JSON.stringify({ intent: "existing", issues: [candidate] }),
        close() {}, answerQuestions: () => false };
    });
    const result = await selector(flow, "已冻结的计划正文", [issue], signal).catch((error: unknown) => error);
    return { result, calls };
  }
  const repaired = await select(up);
  assert.ok(Array.isArray(repaired.result));
  assert.equal(repaired.calls.length, 2);
  assert.equal(repaired.calls[0]?.context, repaired.calls[1]?.context);
  assert.match(repaired.calls[1]?.prompt ?? "", /工单 #1.*AC-1/);
  assert.equal(repaired.result[0]?.validation[0]?.criterion, "AC-1");

  const step = validation[0];
  assert.ok(step);
  const wrongId = { ...up, validation: [{ ...step, criterion: "AC-01" }] };
  const rejected = await select(wrongId);
  assert.equal(rejected.calls.length, 2);
  assert.match(String(rejected.result), /工单 #1.*AC-1/);

  const copiedNumber = await select(up, { ...wrongId, criteria: ["AC-01"] });
  assert.equal(copiedNumber.calls.length, 2);
  assert.match(copiedNumber.calls[1]?.prompt ?? "", /工单 #1 验收编号必须从本轮资料原样选择：AC-1/);
  assert.ok(Array.isArray(copiedNumber.result));

  const outsideScope = await select(up, { ...up, number: 99 });
  assert.equal(outsideScope.calls.length, 1);
  assert.match(String(outsideScope.result), /不在本轮候选资料/);

  await t.test("候选只覆盖部分验收时可转入新工单，二次漏项保持拦截", async () => {
    const section = flow.outputs.flatMap(output => output.artifacts).find(artifact => artifact.kind === "requirements")
      ?.sections.find(item => item.title === "验收条件");
    assert.ok(section);
    section.text += "\n新人在自己的设备完成登录与配对";
    const incomplete = { intent: "existing", issues: [up] };
    const allCriteria = { ...up, criteria: ["AC-1", "AC-2"], validation: [...validation,
      { criterion: "AC-2", procedure: "从新设备登录", expected: "可以完成配对" }] };
    for (const [second, expected] of [
      [{ intent: "new", issues: [] }, "new"],
      [{ intent: "existing", issues: [allCriteria] }, "existing"],
      [incomplete, "blocked"],
      [{ intent: "none", issues: [] }, "blocked"],
    ] as const) {
      const calls: Parameters<NonNullable<Parameters<typeof createGitHubSelector>[2]>>[0][] = [];
      const selector = createGitHubSelector(repo, { timeoutMs: 2000, newIssues: true }, options => {
        calls.push(options);
        const reply = calls.length === 1 ? incomplete : second;
        return { finished: Promise.resolve("completed"), output: () => JSON.stringify(reply), close() {}, answerQuestions: () => false };
      });
      const selected = await selector(flow, "已冻结的计划正文", [issue], signal).catch((error: unknown) => error);
      assert.equal(calls.length, 2);
      assert.equal(calls[0]?.untrustedContext, calls[1]?.untrustedContext);
      assert.match(calls[1]?.prompt ?? "", /现有 Issue 未覆盖 AC-2.*intent=new/);
      if (expected === "new") assert.equal(selected, "new");
      else if (expected === "existing") {
        assert.ok(Array.isArray(selected));
        assert.deepEqual(selected[0]?.criteria, ["AC-1", "AC-2"]);
      } else assert.match(String(selected), /未覆盖验收项 AC-2/);
    }
  });
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
  revised.outputs = flow.outputs.map(output => ({ ...output, artifacts: output.artifacts.map(artifact =>
    artifact.kind === "prd" ? { ...artifact, version: artifact.version + 1 } : artifact) }));
  assert.equal(resumed.cards([revised], "member").length, 0);
  assert.equal(await resumed.answer(card.id, "member", response, [revised]), 409);
  assert.equal(approvals.length, 0);
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

test("逐单复核中断时仅为本版部分拦截意见开放原对话重规划", async () => {
  const flow = await readyQualityFlow();
  const plan = currentDevelopmentPlan(flow);
  assert.ok(plan);
  const base = "a".repeat(40);
  const path = "src/main.mts";
  flow.project = { repository: { revision: base, commits: [] }, plan: { status: "read" }, github: { status: "read" } };
  const draft = { id: "T1", title: "核对发送", instructions: "核对真实调用", criteria: ["AC-1"],
    dependsOn: [], paths: [path], validation };
  const check = { ticket: "T1", revision: base, paths: [path], sourceDigest: "a".repeat(64), status: "block" as const,
    summary: "缺少固定提交上的调用入口", evidence: [{ ref: `repo:${path}`, quote: "固定源码" }] };
  const previous: IssueProposal = { id: "trial", flowId: flow.id, actor: "member", planId: plan.id, version: plan.version,
    base, items: [], drafts: [draft], status: "uncertain", createdAt: 1, sourceReviewRequired: true, sourceFindings: [check],
    error: "质量复核引用无法在本轮资料找到，可以重试。", sourceError: "第三张工单没有有效引文" };
  const quality = await reviewQuality(qualityPacket(flow, base, "partial", [draft]),
    { id: "partial", base, items: [draft] }, passingQualityReview, new AbortController().signal);
  const { sourceFindings: _unset, ...withoutSourceFindings } = previous;
  const records: IssueProposal[] = [
    previous, { ...previous, id: "empty", actor: "no-evidence", sourceFindings: [] },
    { ...withoutSourceFindings, id: "partial", actor: "quality-receipt", quality: { ...quality, sourceChecks: [check] } },
    { ...previous, id: "stale", actor: "stale", sourceFindings: [{ ...check, revision: "b".repeat(40) }] },
    { ...previous, id: "wrong-path", actor: "wrong-path", sourceFindings: [{ ...check, paths: ["src/other.mts"] }] },
    { ...previous, id: "finished", actor: "approved", approvedAt: 2 },
    { ...previous, id: "wrong-version", actor: "wrong-version", version: plan.version + 1 },
  ];
  const service = createConversationDelivery({
    permits: () => true, suggest: async () => assert.fail(), claimApproved: async () => assert.fail(),
  }, { load: () => records, save: () => assert.fail("读取反馈不改变批次") },
  async () => assert.fail(), async () => assert.fail(), async () => ({}));
  try {
    const feedback = service.replanFeedback(flow, "member");
    assert.equal(feedback?.batchId, previous.id);
    assert.deepEqual(feedback?.sourcePaths, [path]);
    assert.match(feedback?.findings ?? "", /引用无法在本轮资料找到[\s\S]*T1 源码：缺少固定提交上的调用入口/);
    assert.deepEqual(service.replanFeedback(flow, "quality-receipt")?.sourcePaths, [path]);
    assert.deepEqual(service.cards([flow], "member"), []);
    for (const actor of ["other", "no-evidence", "stale", "wrong-path", "approved", "wrong-version"]) {
      assert.equal(service.replanFeedback(flow, actor), undefined, actor);
    }
  } finally { await service.close(); }
});

test("保留原未授权草稿，十张工单分别核对固定源码，缺一份即不能授权", { timeout: 5000 }, async t => {
  const flow = await readyQualityFlow("继续实施已经确认的需求");
  const base = "a".repeat(40);
  flow.project = { repository: { revision: base, commits: [] }, plan: { status: "read" }, github: { status: "read" } };
  const plan = currentDevelopmentPlan(flow);
  assert.ok(plan);
  const drafts: PlannedTicket[] = Array.from({ length: 10 }, (_, index) => ({ id: `T${index + 1}`, title: `工单 ${index + 1}`,
    instructions: "单独回读一次交付结果。", dependsOn: index === 7 ? ["T7"] : [], criteria: ["AC-1"], validation,
    paths: [`src/feature-${index}.mts`], sources: [`tests/feature-${index}.test.mts`, `src/related-${index}.mts`],
    delivery: { outcome: index === 6 ? "提供已验证的回执查询接口" : `完成第 ${index + 1} 项验收`, priorityReason: "按确认的计划顺序安排",
      prerequisites: index === 7 ? [{ ticket: "T7", reason: "读取上游新增的回执查询接口。" }] : [] },
  }));
  for (const [label, missing, legacyPending] of [
    ["十张均取得源码回执", undefined, false], ["某工单少读源码", drafts[6]?.sources?.[1], false],
    ["旧待授权卡必须补复核", undefined, true],
  ] as const) await t.test(label, async () => {
    const previousId = "previous-draft";
    const legacyQuality = legacyPending ? await reviewQuality(qualityPacket(flow, base, previousId, drafts),
      { id: previousId, base, items: drafts }, passingQualityReview, new AbortController().signal) : undefined;
    const previous: IssueProposal = { id: "previous-draft", flowId: flow.id, actor: "member", planId: plan.id, version: plan.version,
      base, items: [], drafts, createdAt: 1, ...(legacyQuality ? { status: "pending", quality: legacyQuality }
        : { status: "uncertain", error: "工单校验未通过：部分源码无法装入复核资料，请缩小范围后重新选单。" }) };
    const checkpoint = new Map([[previous.id, previous]]);
    const reads: string[][] = [];
    const seen: string[] = [];
    let active = 0;
    let maximum = 0;
    const tracker: DeliveryTracker = { repo: "a/b", candidates: async () => [], account: async () => "member",
      read: async () => assert.fail(), assign: async () => assert.fail(),
      creation: { create: async () => assert.fail("未授权不得建单"), findCreated: async () => [] },
      delivery: { checkout: async () => assert.fail(), publish: async () => assert.fail(), find: async () => undefined } };
    const service = createConversationDelivery({ permits: () => true, suggest: async () => assert.fail("已冻结草稿无需重新选单"),
      claimApproved: async () => assert.fail("未授权不得认领"), }, {
      load: () => [...checkpoint.values()], save(id, item) { checkpoint.set(id, structuredClone(item)); return true; },
    }, async () => assert.fail("不生成别的草稿"), async (packet, signal) => {
      assert.equal(packet.sourceChecks?.length, missing ? 7 : 10);
      assert.match(packet.references["source-check:T1"] ?? "", /固定源码 src\/feature-0\.mts/);
      assert.equal(packet.tickets.length, 10);
      return passingQualityReview(packet, signal);
    }, async (revision, paths) => {
      assert.equal(revision, base);
      assert.equal(paths.length, 3);
      reads.push(paths);
      return Object.fromEntries(paths.filter(path => path !== missing).map(path => [path, `固定源码 ${path}`]));
    }, { draft: async () => assert.fail("不生成别的工单"), publish: async () => assert.fail("未授权不得建单"),
      connection: () => tracker, sourceReview: { concurrency: 2, async reviewer(packet) {
        active++;
        maximum = Math.max(maximum, active);
        seen.push(packet.ticket.id);
        assert.equal(packet.revision, base);
        assert.equal(packet.plan?.id, plan.id);
        assert.equal(packet.plan?.version, plan.version);
        assert.deepEqual(packet.upstream.map(parent => parent.delivery?.outcome), packet.ticket.id === "T8" ? ["提供已验证的回执查询接口"] : []);
        assert.equal(Object.keys(packet.references).length, 3);
        await setImmediate();
        active--;
        const ref = `repo:${packet.ticket.paths[0]}`;
        return JSON.stringify({ status: "pass", summary: "编辑范围支持验收", evidence: [{ ref, quote: packet.references[ref] }] });
      } } });
    try {
      assert.deepEqual(service.cards([flow], "member"), []);
      assert.equal(await service.answer(previous.id, "member", { authorization: "授权创建 Issue、执行并开草稿 PR" }, [flow]), 409);
      assert.equal(service.begin(flow, "首版", true), true);
      while (["selecting", "reviewing"].includes(checkpoint.get(previous.id)?.status ?? "")) await setImmediate();
      const recovered = checkpoint.get(previous.id);
      assert.deepEqual(recovered?.drafts, drafts);
      assert.equal(checkpoint.size, 1);
      assert.equal(maximum, 2);
      if (missing) {
        assert.equal(recovered?.status, "uncertain");
        assert.ok(recovered.error?.includes(`T7 的固定源码未完整读入（${missing}）`));
        assert.deepEqual(recovered.quality?.sourceChecks?.map(item => item.ticket), ["T1", "T2", "T3", "T4", "T5", "T6", "T8"]);
        assert.ok(!seen.includes("T7"));
        assert.deepEqual(service.cards([flow], "member"), []);
      } else {
        assert.equal(recovered?.status, "pending");
        assert.equal(reads.flat().length, 30);
        assert.deepEqual(recovered.quality?.sourceChecks?.map(item => item.ticket), drafts.map(item => item.id));
        assert.equal(service.cards([flow], "member")[0]?.id, previous.id);
      }
    } finally { await service.close(); }
  });
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

test("批次复核先读取逐单源码证据，技术拦截只在同版修订一次", async t => {
  for (const kind of ["pass-after-fix", "still-blocked", "scope-block", "resume-after-batch-failure"] as const) await t.test(kind, async () => {
    const flow = await readyQualityFlow();
    const base = "a".repeat(40);
    flow.project = { repository: { revision: base, commits: [] }, plan: { status: "read" }, github: { status: "read" } };
    const proposalRows = new Map<string, IssueProposal>();
    const calls: string[] = [];
    let firstBatch = true;
    const fixture = { id: "T1", title: "核对独立验收", instructions: "查明发送时机", criteria: ["AC-1"], validation,
      paths: ["src/main.mts"], dependsOn: [], delivery: { outcome: "用户只收到一条待办", priorityReason: "核心结果", prerequisites: [] } };
    const tracker: DeliveryTracker = {
      repo: "a/b", candidates: async () => [], account: async () => "member", read: async () => assert.fail(), assign: async () => assert.fail(),
      creation: { create: async () => assert.fail("未授权不得创建"), findCreated: async () => [] },
      delivery: { checkout: async () => assert.fail("未授权不得执行"), find: async () => undefined, publish: async () => assert.fail() },
    };
    const service = createConversationDelivery({
      permits: () => true, suggest: async () => [], claimApproved: async () => assert.fail("未授权不得认领"),
    }, { load: () => [], save(id, p) { proposalRows.set(id, structuredClone(p)); return true; } }, async () => "new",
    async packet => {
      const title = packet.tickets[0]?.title;
      calls.push(`批次 ${title}`);
      assert.match(packet.references["source-check:T1"] ?? "", /固定提交中的接口/);
      assert.equal(packet.sourceChecks?.[0]?.revision, base);
      if (firstBatch && kind === "resume-after-batch-failure") {
        firstBatch = false;
        throw Error("独立质量复核暂不可用");
      }
      const result = qualityReviewOutput(packet);
      if (kind === "scope-block") return JSON.stringify({ ...result, scope: { ...result.scope, status: "block", summary: "产品范围有冲突" } });
      if (title === fixture.title || kind === "still-blocked") return JSON.stringify({ ...result,
        verification: { ...result.verification, status: "block", summary: "缺少并发确认验证" } });
      return JSON.stringify(result);
    }, async (revision, paths) => {
      assert.equal(revision, base);
      return Object.fromEntries(paths.map(path => [path, "固定提交中的接口"]));
    }, {
      async draft(snapshot, id, correction) {
        assert.equal(snapshot.project?.repository?.revision, base);
        assert.ok(proposalRows.has(id));
        if (!correction) return { tickets: [fixture], batchAcceptance: [] };
        assert.deepEqual(correction.tickets, [fixture]);
        assert.match(correction.findings, /缺少并发确认验证/);
        calls.push("修订");
        return { tickets: [{ ...fixture, title: "核对并发确认" }], batchAcceptance: [] };
      },
      publish: async () => assert.fail("未授权不得发布"), connection: () => tracker,
      sourceReview: { concurrency: 1, async reviewer(packet) {
        calls.push(`源码 ${packet.ticket.title}`);
        const ref = "repo:src/main.mts";
        return JSON.stringify({ status: firstBatch && kind === "resume-after-batch-failure" ? "block" : "pass",
          summary: "找到固定提交中的接口", evidence: [{ ref, quote: packet.references[ref] }] });
      } },
    });
    try {
      assert.equal(service.begin(flow, "首版"), true);
      while (["selecting", "reviewing"].includes(service.statuses([flow], "member")[0]?.status ?? "")) await setImmediate();
      if (kind === "resume-after-batch-failure") {
        const stalled = service.statuses([flow], "member")[0];
        assert.equal(stalled?.status, "uncertain");
        assert.equal(stalled?.sourceFindings?.[0]?.status, "block");
        assert.match(stalled?.error ?? "", /暂不可用/);
        assert.equal(service.cards([flow], "member").length, 0);
        assert.equal(service.begin(flow, "首版", true), true);
        while (["selecting", "reviewing"].includes(service.statuses([flow], "member")[0]?.status ?? "")) await setImmediate();
      }
      const expected = ["源码 核对独立验收", "批次 核对独立验收"];
      if (kind === "resume-after-batch-failure") expected.push("源码 核对独立验收", "批次 核对独立验收");
      if (kind !== "scope-block") expected.push("修订", "源码 核对并发确认", "批次 核对并发确认");
      assert.deepEqual(calls, expected);
      const ready = kind === "pass-after-fix" || kind === "resume-after-batch-failure";
      assert.equal(service.statuses([flow], "member")[0]?.status, ready ? "pending" : "blocked");
      assert.equal(service.cards([flow], "member").length, ready ? 1 : 0);
    } finally { await service.close(); }
  });
});

test("从新需求复核和授权，创建 Issue 后认领派发，重启后能找回丢失的建单回执", async () => {
  const flow = await readyQualityFlow("实现一个尚未建单的新需求。");
  const existing = { ...makeIssue(3, "支持 Markdown 预览并保持原文。"), state: "CLOSED" as const };
  const [source] = snapshotIssueCandidates([existing]);
  assert.ok(source);
  flow.project = { repository: { revision: "a".repeat(40), commits: [] }, plan: { status: "read" }, github: { status: "read" },
    relatedIssues: [{ number: existing.number, url: existing.url, status: "read", state: existing.state, assigned: false, source }] };
  const acceptance = flow.outputs.flatMap(output => output.artifacts).find(artifact => artifact.kind === "requirements")
    ?.sections.find(section => section.title === "验收条件");
  assert.ok(acceptance);
  acceptance.text += "\n上游合并后下游自动启动\n项目文档的 Markdown 保持可预览";
  const batchAcceptance: BatchAcceptance[] = [
    { criterion: "AC-2", owner: "batch", issue: null, basis: null, procedure: "等待并合并上游 PR", expected: "下游只启动一次" },
    { criterion: "AC-3", owner: "related-issue", issue: 3, basis: "支持 Markdown 预览并保持原文。",
      procedure: "打开已交付的 Markdown 预览", expected: "格式正确，原文不变" },
  ];
  const proposals = new Map<string, IssueProposal>();
  const receipts = new Map<string, IssuePublication>();
  const claims = new Map<string, Claim>();
  const remote = new Map<number, IssueDetail>();
  const writes: string[] = [];
  let visible = false;
  let merged = false;
  const merge = "b".repeat(40);
  const head = "c".repeat(40);
  let liveService: ReturnType<typeof createConversationDelivery> | undefined;
  let sourceFailure: unknown;
  const reviewedRevisions: string[] = [];
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
      async publish({ issue }) {
        const pull = { number: 100 + issue, url: `https://github.com/a/b/pull/${100 + issue}`, state: "OPEN", head, baseName: "main" };
        read(issue).pulls.push(pull);
        return pull;
      },
      find: async (_branch, _head, knownPull) => knownPull === 110 ? { number: 110, url: "https://github.com/a/b/pull/110", head, baseName: "main",
        state: merged ? "MERGED" : "OPEN", ...(merged ? { mergeCommit: merge } : {}) } : undefined,
    },
  };
  const store = <T extends object>(rows: Map<string, T>) => ({
    load: () => [...rows.values()], save(id: string, value: T) { rows.set(id, structuredClone(value)); return true; },
  });
  const github = createIssueDispatch(tracker, store(claims), async () => assert.fail("不得进入只读核验"), () => true, 2,
    new Map([["member", tracker]]), { specs: new Map(), conversation: true, requireQuality: true, pollMs: 60_000,
      reviewScopeCurrent: claim => !!liveService?.reviewScope(claim, flow),
      async reviewSourceHandoff(claim, proof, sources, signal) {
        assert.ok(liveService);
        return liveService.reviewHandoff(claim, flow, proof, sources, signal);
      },
      prepare: async ({ number, branch, upstream, spec, sourceHandoff }, _connected, signal) => {
        assert.deepEqual(upstream, number === 11 ? [merge] : []);
        if (number === 11) {
          assert.ok(sourceHandoff);
          assert.deepEqual(spec.sourceFrom, up.files.map(path => ({ path, issue: 10 })));
          const parent = read(10);
          const approvedBody = parent.body;
          parent.body = "未经授权的上游范围";
          await assert.rejects(sourceHandoff.current("main", signal), /依赖合并改变了已校验的源码/);
          assert.equal(claims.get("11")?.phase, "checkingSources");
          parent.body = approvedBody;
          const producers = await sourceHandoff.current("main", signal).catch(error => { sourceFailure = error; throw error; });
          assert.deepEqual(producers.map(item => [item.issue, item.pull, item.merge]), [[10, 110, merge]]);
          const paths = [...down.files, ...up.files];
          await sourceHandoff.review({ original: "a".repeat(40), execution: merge, producers,
            blobs: paths.map(path => ({ path, mode: "100644", sha: "d".repeat(40) })) },
          Object.fromEntries(paths.map(path => [path, "合并后的真实接口夹具"])), signal).catch(error => { sourceFailure = error; throw error; });
          assert.equal(claims.get("11")?.sourceHandoff?.finding.status, "pass");
          assert.equal(claims.get("11")?.phase, "checkingSources");
          sourceHandoff.ready();
        }
        writes.push(`开发 ${number}`);
        return { workspace: "fixture", branch, base: "main", head, ...(number === 11 ? { executionRevision: merge } : {}) };
      },
    });
  const makeService = () => createConversationDelivery(github, store(proposals), async () => "new", passingQualityReview,
    async (_revision, paths) => Object.fromEntries(paths.map(path => [path, "冻结的源码"])), {
      sourceReview: { concurrency: 2, async reviewer(packet) {
        const [ref, quote] = Object.entries(packet.references)[0] ?? [];
        assert.ok(ref && quote);
        if (packet.handoff) {
          assert.equal(packet.handoff.original, "a".repeat(40));
          assert.equal(quote, "合并后的真实接口夹具");
          reviewedRevisions.push(packet.revision);
        }
        return JSON.stringify({ status: "pass", summary: "按固定资料核对接口", evidence: [{ ref, quote }] });
      } },
      draft: async () => ({ batchAcceptance, tickets: [
        { id: "T1", title: "上游工单", instructions: "实现新需求。", paths: up.files, dependsOn: [], criteria: up.criteria, validation,
          delivery: { outcome: "用户能看到待确认纪要", priorityReason: "先交付确认入口", prerequisites: [] } },
        { id: "T2", title: "下游工单", instructions: "在合并后验证。", paths: down.files, sources: up.files, dependsOn: ["T1"], criteria: up.criteria, validation,
          delivery: { outcome: "用户反复确认仍只收到一条待办", priorityReason: "复用上游确认入口",
            prerequisites: [{ ticket: "T1", reason: "需要上游合并后的确认操作入口" }] } },
      ] }),
      publish: createPlannedIssuePublication(store(receipts)), connection: actor => actor === "member" ? tracker : undefined,
    });
  const initial = makeService();
  liveService = initial;
  let restarted: ReturnType<typeof makeService> | undefined;
  try {
    assert.equal(initial.begin(flow, "首版"), true);
    await setImmediate();
    const card = initial.cards([flow], "member")[0];
    assert.ok(card);
    assert.match(card.prompt, /T2 · 下游工单/);
    assert.match(card.prompt, /可演示结果：用户能看到待确认纪要/);
    assert.match(card.prompt, /前置 T1：需要上游合并后的确认操作入口/);
    assert.ok(card.prompt.includes(`只读交接：T1 合并后重新核对 ${up.files[0]}`));
    assert.match(card.prompt, /AC-2 · 整批验收 · 等待并合并上游 PR/);
    assert.match(card.prompt, /AC-3 · 关联 Issue #3/);
    assert.deepEqual(initial.statuses([flow], "member")[0]?.batchAcceptance, batchAcceptance);
    assert.deepEqual(initial.statuses([flow], "member")[0]?.quality?.breakdown?.map(finding => finding.ticket), ["T1", "T2"]);
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
    liveService = restarted;
    assert.equal(await restarted.resumePublication(flow, "other"), 409);
    assert.equal(await restarted.resumePublication(flow, "member"), 409);
    assert.deepEqual(writes, ["创建 10"]);

    visible = true;
    assert.equal(await restarted.resumePublication(flow, "member"), 200);
    await setImmediate();
    assert.deepEqual(writes, ["创建 10", "创建 11", "认领 10", "认领 11", "开发 10"]);
    assert.match(read(11).body, /^依赖 #10$/m);
    assert.match(read(11).body, /可演示结果：用户反复确认仍只收到一条待办/);
    assert.doesNotMatch(read(11).body, /AC-2|AC-3|Markdown/);
    assert.equal(claims.get("11")?.phase, "waiting");
    assert.deepEqual(restarted.statuses([flow], "member")[0]?.issues, [10, 11]);
    assert.deepEqual(restarted.statuses([flow], "member")[0]?.batchAcceptance, batchAcceptance);
    assert.equal(await restarted.resumePublication(flow, "member"), 409);
    await github.refresh();
    assert.equal(writes.includes("开发 11"), false);
    merged = true;
    await github.refresh();
    await setImmediate();
    assert.ifError(sourceFailure);
    assert.deepEqual(writes.slice(-2), ["开发 10", "开发 11"]);
    assert.equal(claims.get("11")?.pull?.number, 111);
    assert.deepEqual(reviewedRevisions, [merge]);
    await github.refresh();
    assert.equal(writes.filter(write => write === "开发 11").length, 1);
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
    draft: async () => ({ batchAcceptance: [], tickets: [{ id: "T1", title: "过长工单", instructions: "说明".repeat(1_000),
      paths: up.files, dependsOn: [], criteria: up.criteria,
      delivery: { outcome: "用户完成一次确认", priorityReason: "完成核心流程", prerequisites: [] },
      validation: Array.from({ length: 10 }, (_, i) => ({
        criterion: `AC-${i + 1}`, procedure: "验证".repeat(250), expected: "结果".repeat(150),
      })) }] }),
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

test("旧待授权的新建工单续办前需要重新拆单，已授权回执仍可核对", async () => {
  const flow = await readyQualityFlow();
  const plan = currentDevelopmentPlan(flow);
  assert.ok(plan);
  const previous = { id: "old", flowId: flow.id, actor: "member", planId: plan.id, version: plan.version, base: "a".repeat(40),
    items: [], drafts: [{ id: "T1", title: "旧草稿", instructions: "旧执行范围", paths: up.files,
      dependsOn: [], criteria: up.criteria, validation }], status: "pending" as const, createdAt: 1 };
  const saved = new Map<string, IssueProposal>([[previous.id, previous], ["authorized", {
    ...previous, id: "authorized", status: "authorizing", approvedAt: 2,
  }]]);
  const service = createConversationDelivery({
    permits: () => true, suggest: async () => [], claimApproved: async () => assert.fail("旧草稿不能触发重派"),
  }, { load: () => [...saved.values()], save(id, proposal) { saved.set(id, structuredClone(proposal)); return true; } },
  async () => [], passingQualityReview, async () => ({}));
  try {
    assert.deepEqual(service.cards([flow], "member"), []);
    assert.equal(saved.get(previous.id)?.status, "uncertain");
    assert.match(saved.get(previous.id)?.error ?? "", /旧工单缺少逐单拆分依据/);
    assert.equal(saved.get("authorized")?.approvedAt, 2);
    assert.deepEqual(saved.get("authorized")?.drafts, previous.drafts);
    assert.equal(service.publicationNeedsCheck("authorized", "member"), true);
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
