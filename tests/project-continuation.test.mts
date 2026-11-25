import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import type { PlanningReference } from "../src/connections/issue-tracker.mts";
import { freezePlanningSources, frozenPlanningInput } from "../src/execution/frozen-planning-sources.mts";
import { createConversationFlows, makePhasePrompt, phases } from "../src/planning/conversation-flow.mts";
import { createProjectContextReader, readRelatedIssues, snapshotIssueCandidates } from "../src/planning/project-context.mts";
import { createCodexInbox } from "../src/workbench/codex-inbox.mts";

test("先读明确前置和已关闭的关联工单，保持候选边界与来源版本", async () => {
  const issue = (number: number, body: string, state = "OPEN", assignees: string[] = []) => ({
    number, title: `工单 ${number}`, state, assignees, body, pulls: [], url: `https://github.com/a/b/issues/${number}`,
  });
  const candidates = [issue(67, "依赖 #64\n- 依赖：#66\n相关 #72\n见 PR #77 与 [#88](https://github.com/elsewhere/other/issues/88)")];
  const committedPlan = "已有试用 https://github.com/a/b/issues/72。还需核对 #90。";
  const observed: number[] = [];
  let closedBody = "关闭前交付说明";
  const tracker = { repo: "a/b", async read(number: number) {
    observed.push(number);
    if (number === 90) throw Error("未能读取");
    return issue(number, number === 64 ? closedBody : `来源 ${number}`, number === 64 || number === 66 ? "CLOSED" : "OPEN", number === 72 ? ["member"] : []);
  } };
  const related = await readRelatedIssues(tracker, candidates, committedPlan);
  assert.deepEqual(observed, [64, 66, 72, 90]);
  assert.deepEqual(related.issues.map(row => [row.number, row.status]), [[64, "read"], [66, "read"], [72, "read"], [90, "unavailable"]]);
  const [closed, , assigned] = related.issues;
  assert.ok(closed?.status === "read" && assigned?.status === "read");
  assert.equal(closed.state, "CLOSED");
  assert.equal(assigned.assigned, true);
  assert.match(closed.source.revision ?? "", /^[a-f0-9]{64}$/);
  assert.deepEqual(snapshotIssueCandidates(candidates).map(row => row.number), [67]);
  assert.equal(related.omissions, undefined);
  closedBody = "修订后的交付说明";
  const [updated] = (await readRelatedIssues(tracker, [], "依赖 #64")).issues;
  assert.ok(updated?.status === "read");
  assert.notEqual(updated.source.revision, closed.source.revision);
  assert.equal(closed.source.body, "关闭前交付说明");
  const many = await readRelatedIssues(tracker, [], Array.from({ length: 10 }, (_, index) => `关联 #${index + 101}`).join("\n"));
  assert.equal(many.issues.length, 8);
  assert.deepEqual(many.omissions, { count: 2, examples: [109, 110] });
});

test("续推规划能读取冻结的 Issue 正文与截断信号，正文在传入前脱敏", async () => {
  const issues = [{ number: 47, title: "设备直连", body: "范围：真实心跳与回执。\n密码: example-password\n" + "续".repeat(3100),
    state: "OPEN" as const, url: "https://github.com/a/b/issues/47", assignees: [], pulls: [] }];
  const candidates = snapshotIssueCandidates(issues);
  const prompts: string[] = [];
  const service = createConversationFlows(async (flow, phase, targets) => {
    prompts.push(makePhasePrompt(flow, phase, targets));
    return phase.fields.map(field => `示例 ${field}`);
  }, 1, undefined, async () => ({ evidence: {
    plan: { status: "read" }, github: { status: "read" }, issueCandidates: candidates,
  } }));
  service.begin("继续推进 souflow 首版开发");
  await service.settled();
  assert.equal(prompts.length, phases.length);
  for (const prompt of prompts) {
    assert.match(prompt, /真实心跳与回执/);
    assert.match(prompt, /"truncated":true/);
    assert.doesNotMatch(prompt, /example-password/);
  }
});

test("冻结混合 GitHub 引用时保留真实类型，PR 不占用 Issue 候选", async () => {
  const issue = (number: number) => ({ number, title: `工单 ${number}`, state: "CLOSED" as const,
    assignees: [], body: `工单依据 ${number}`, pulls: [], url: `https://github.com/a/b/issues/${number}` });
  const candidates = [{ ...issue(67), body: "依赖 #64\n相关 #60、#61、#62、#75、#76、#55\n[他仓 PR](https://github.com/other/repo/pull/15)" }];
  const texts = "已验 PR #42 与 [旧 PR](https://github.com/a/b/pull/80)。相关 #47、#43、#44、#78、#66、#99。";
  const observed: number[][] = [];
  let head = "a".repeat(40);
  const tracker = { repo: "a/b", read: async () => assert.fail("混合引用应使用连接层类型查询"),
    async readPlanningReferences(numbers: readonly number[]) {
      observed.push([...numbers]);
      const rows = new Map<number, PlanningReference>();
      for (const number of numbers) {
        if ([60, 61, 62, 75, 76, 42, 78, 80].includes(number)) {
          rows.set(number, { number, kind: "pull", title: "旧 PR", body: "真实交付正文\n密码: example-password",
            state: "MERGED", head, mergeCommit: "b".repeat(40) });
        } else if (number !== 99) rows.set(number, { ...issue(number), kind: "issue", assigned: false });
      }
      return rows;
    },
  };
  const result = await readRelatedIssues(tracker, candidates, texts);
  assert.equal(observed.length, 1);
  assert.equal(observed[0]?.[0], 64);
  assert.equal(observed[0]?.length, 15);
  assert.ok(!observed[0]?.includes(15) && !observed[0]?.includes(67));
  assert.equal(result.issues.find(row => row.number === 55)?.status, "read");
  assert.equal(result.issues.find(row => row.number === 99)?.status, "unavailable");
  assert.equal(result.issues.some(row => row.number === 60), false);
  const pr = result.pullRequests.find(row => row.number === 60);
  assert.ok(pr);
  assert.equal(pr.mergeCommit, "b".repeat(40));
  assert.match(pr.source.body ?? "", /真实交付正文/);
  assert.doesNotMatch(pr.source.body ?? "", /example-password/);
  assert.deepEqual(snapshotIssueCandidates(candidates).map(item => item.number), [67]);
  assert.equal(result.omissions, undefined);
  head = "c".repeat(40);
  const reread = await readRelatedIssues(tracker, candidates, texts);
  assert.notEqual(reread.pullRequests.find(row => row.number === 60)?.source.revision, pr.source.revision);
});

const exec = promisify(execFile);

test("规划只接收固定提交的只读正文，编辑工作区与旧版本恢复均有边界", async t => {
  const repo = await mkdtemp(join(tmpdir(), "souflow-frozen-planning-"));
  t.after(() => rm(repo, { recursive: true, force: true }));
  const git = async (...args: string[]) => (await exec("git", ["-C", repo, ...args])).stdout.trim();
  await git("init", "-q");
  await mkdir(join(repo, "src", "other"), { recursive: true });
  await writeFile(join(repo, "src/entry.mts"), "export const visible = 'approved-source';\n密码: example-password\n");
  await writeFile(join(repo, "src/route.mts"), "export const route = 'a';\n");
  await writeFile(join(repo, "src/other/route.mts"), "export const route = 'b';\n");
  await writeFile(join(repo, "src/.local.mts"), "do not use");
  await symlink("entry.mts", join(repo, "src/linked.mts"));
  await git("add", "src");
  await git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "initial");
  const revision = await git("rev-parse", "HEAD");
  const planningSources = await freezePlanningSources(repo, revision,
    ["entry.mts 和 route.mts", "src/missing.mts\nsrc/linked.mts\nsrc/.local.mts\nsrc/route.mts"], 3);
  assert.ok(planningSources);
  assert.deepEqual(planningSources.files.map(item => [item.path, item.status]),
    [["src/entry.mts", "read"], ["src/missing.mts", "unavailable"], ["src/linked.mts", "unavailable"]]);
  assert.equal(planningSources.omitted, 1);
  await writeFile(join(repo, "src/entry.mts"), "export const visible = 'new-head';");
  await git("add", "src/entry.mts");
  await git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "new");
  await writeFile(join(repo, "src/entry.mts"), "export const visible = 'dirty-workspace';");
  const evidence = { repository: { revision, commits: [] }, plan: { status: "read" as const },
    github: { status: "read" as const }, planningSources };
  const input = await frozenPlanningInput(repo, evidence);
  assert.match(input ?? "", /approved-source/);
  assert.doesNotMatch(input ?? "", /new-head|dirty-workspace|example-password/);
  const sent: (string | undefined)[] = [];
  const inbox = createCodexInbox(repo, { limit: 1, answerMaxLength: 100, startAttempt(options) {
    sent.push(options.untrustedContext);
    assert.doesNotMatch(options.prompt, /approved-source/);
    return { finished: Promise.resolve("completed"), close() {}, answerQuestions: () => false,
      output: () => JSON.stringify(Object.fromEntries(((options.outputSchema?.required ?? []) as string[]).map(field => [field, "样例"]))) };
  } });
  const service = createConversationFlows(inbox.runPhase, 1, undefined, async () => ({ evidence }));
  service.begin("更新 entry.mts");
  await service.settled();
  assert.equal(service.list()[0]?.status, "ready");
  assert.deepEqual(sent, Array(phases.length).fill(input));
  assert.doesNotMatch(JSON.stringify(service.list()), /approved-source|example-password/);
  const invalid = structuredClone(evidence);
  const file = invalid.planningSources.files[0];
  assert.ok(file?.status === "read");
  file.sha256 = "0".repeat(64);
  await assert.rejects(frozenPlanningInput(repo, invalid), /固定规划源码资料已不可读/);
  const { planningSources: _unused, ...legacy } = evidence;
  assert.equal(await frozenPlanningInput(repo, legacy), undefined);
});

test("continuing a project binds every stage to the same committed plan, with unavailable sources explicit", async t => {
  const repo = await mkdtemp(join(tmpdir(), "souflow-project-context-"));
  t.after(() => rm(repo, { recursive: true, force: true }));
  const git = async (...args: string[]) => (await exec("git", ["-C", repo, ...args])).stdout.trim();
  await git("init", "-q");
  await mkdir(join(repo, "docs"));
  await writeFile(join(repo, "docs/plan.md"), "已跟踪的首版计划");
  await symlink("plan.md", join(repo, "docs/link.md"));
  await git("add", "docs");
  await git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--no-gpg-sign", "-m", "Track first-release plan");
  await git("remote", "add", "origin", "https://github.com/example/other.git");
  const revision = await git("rev-parse", "HEAD");
  await writeFile(join(repo, "docs/plan.md"), "本机未提交的改动");
  const reader = createProjectContextReader(repo, { planPath: "docs/plan.md", githubRepo: "example/project" });
  let captures = 0;
  const prompts: string[] = [];
  const flows = createConversationFlows(async (flow, phase, targets, planText) => {
    prompts.push(makePhasePrompt(flow, phase, targets, planText));
    return phase.fields.map(field => `说明 ${field}`);
  }, 1, undefined, () => {
    captures++;
    return reader();
  });
  const flow = flows.begin("继续推进 souflow 开发");
  assert.ok(flow);
  await flows.settled();
  assert.equal(flow.status, "ready");
  assert.equal(captures, 1);
  assert.equal(flow.project?.plan.status, "read");
  assert.equal(flow.project?.repository?.revision, revision);
  assert.equal(flow.project?.repository?.commits[0]?.subject, "Track first-release plan");
  assert.equal(flow.project?.github.status, "unavailable");
  assert.equal(prompts.length, phases.length);
  for (const prompt of prompts) {
    assert.match(prompt, /已跟踪的首版计划/);
    assert.ok(prompt.includes(revision));
    assert.doesNotMatch(prompt, /本机未提交的改动/);
  }
  assert.doesNotMatch(JSON.stringify(flow), /已跟踪的首版计划/);
  assert.equal((await createProjectContextReader(repo, { planPath: "docs/link.md" })()).evidence.plan.status, "unavailable");
  assert.throws(() => createProjectContextReader(repo, { planPath: "docs/../README.md" }), /相对 Markdown 路径/);
});
