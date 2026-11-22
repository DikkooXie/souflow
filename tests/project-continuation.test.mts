import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { createConversationFlows, makePhasePrompt, phases } from "../src/planning/conversation-flow.mts";
import { createProjectContextReader, snapshotIssueCandidates } from "../src/planning/project-context.mts";

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
