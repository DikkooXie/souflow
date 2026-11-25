import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { createConversationFlows, makePhasePrompt, phases } from "../src/planning/conversation-flow.mts";
import { createProjectContextReader, readRelatedIssues, snapshotIssueCandidates } from "../src/planning/project-context.mts";

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

const exec = promisify(execFile);

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
