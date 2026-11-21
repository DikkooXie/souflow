import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { promisify } from "node:util";
import { createLocalDispatch, readDispatchTickets, runLocalJobs } from "../src/execution/local-dispatch.mts";
import { applyLocalCodeChanges, readEditableFile } from "../src/execution/local-code-changes.mts";
import type { Flow } from "../src/planning/conversation-flow.mts";

const exec = promisify(execFile);
const guide = "docs/guide.md";
const draft = [
  { id: "T1", title: "核对版本", instructions: "读取版本规则", criteria: ["AC-1"], dependsOn: [], sources: [guide] },
  { id: "T2", title: "核对依赖", instructions: "读取依赖规则", criteria: ["AC-2"], dependsOn: [], sources: [guide] },
  { id: "T3", title: "汇总规则", instructions: "汇总前置报告", criteria: ["AC-3"], dependsOn: ["T1", "T2"], sources: [] },
];
const criteria = ["AC-1", "AC-2", "AC-3"];

test("local dispatch requires criterion coverage, an acyclic graph and approved evidence", () => {
  const allowed = new Set([guide]);
  const read = (tickets: unknown) => readDispatchTickets(JSON.stringify({ tickets }), criteria, allowed);
  assert.deepEqual(read(draft), draft);
  assert.throws(() => read(draft.slice(0, 2)), /uncovered:AC-3/);
  assert.throws(() => read([{ ...draft[0], dependsOn: ["T3"] }, ...draft.slice(1)]), /cycle/);
  assert.throws(() => read([{ ...draft[0], sources: ["docs/linked.md"] }, ...draft.slice(1)]), /冻结版本/);
  const code = draft.slice(0, 2).map(ticket => ({ ...ticket, editPaths: [guide] }));
  assert.throws(() => readDispatchTickets(JSON.stringify({ tickets: code }), criteria.slice(0, 2), allowed, "code"), /重复分配/);
  assert.throws(() => readDispatchTickets(JSON.stringify({ tickets: [{ ...code[0], dependsOn: ["T2"] }] }), criteria, allowed, "code"), /独立执行/);
});

test("code edits validate every path and anchor before changing a snapshot and emit an applicable patch", async t => {
  const target = await mkdtemp(join(tmpdir(), "souflow-code-edits-"));
  t.after(() => rm(target, { recursive: true, force: true }));
  const workspace = join(target, "source");
  const destination = join(target, "integration");
  await mkdir(join(workspace, "docs"), { recursive: true });
  await mkdir(join(destination, "docs"), { recursive: true });
  await writeFile(join(workspace, guide), "before\nrepeated repeated\n");
  await writeFile(join(destination, guide), "before\nrepeated repeated\n");
  await symlink(join(destination, guide), join(workspace, "docs", "linked.md"));
  await assert.rejects(readEditableFile(workspace, "docs/linked.md"), /普通文本/);
  const original = await readEditableFile(workspace, guide);
  const files = new Map([[guide, original]]);
  const edit = { path: guide, before: "before", after: "after" };
  await assert.rejects(applyLocalCodeChanges(target, workspace, files, [edit, { ...edit, path: "../unapproved.md" }]), /未获批准/);
  await assert.rejects(applyLocalCodeChanges(target, workspace, files, [{ ...edit, after: "[已隐藏凭据]" }]), /已脱敏内容/);
  await assert.rejects(applyLocalCodeChanges(target, workspace, files, [{ ...edit, before: "repeated" }]), /唯一匹配/);
  assert.equal(await readFile(join(workspace, guide), "utf8"), original.content);
  const result = await applyLocalCodeChanges(target, workspace, files, [edit]);
  assert.deepEqual(result.files, [guide]);
  await exec("git", ["-C", destination, "apply", "--check", "-p2", result.patchPath]);
  await exec("git", ["-C", destination, "apply", "-p2", result.patchPath]);
  assert.equal(await readFile(join(workspace, guide), "utf8"), "after\nrepeated repeated\n");
  assert.equal(await readFile(join(destination, guide), "utf8"), "after\nrepeated repeated\n");
});

test("independent jobs overlap and a failed dependency blocks its successor", async () => {
  const jobs = draft.map(ticket => ({ ...ticket, status: "queued" as const }));
  const started: string[] = [];
  await runLocalJobs(jobs, 2, async job => {
    started.push(job.id);
    await delay(0);
    assert.deepEqual(started, ["T1", "T2"]);
    if (job.id === "T1") throw Error("fixture failure");
  });
  assert.deepEqual(jobs.map(job => job.status), ["failed", "ready", "blocked"]);
});

test("prepares without executing, rejects stale confirmation and reads only the pinned Git blobs", { timeout: 8000 }, async t => {
  const repo = await mkdtemp(join(tmpdir(), "souflow-dispatch-test-"));
  const commit = async () => {
    await exec("git", ["-C", repo, "add", "docs"]);
    await exec("git", ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--no-gpg-sign", "-m", "fixture"]);
  };
  await exec("git", ["-C", repo, "init", "-q"]);
  await mkdir(join(repo, "docs"));
  await writeFile(join(repo, guide), "frozen evidence");
  await symlink(guide, join(repo, "docs", "linked.md"));
  await commit();
  let allowValid = false;
  const actualWorkspaces: string[] = [];
  const flow: Flow = {
    id: "flow", title: "验收", prompt: "核验首版", status: "ready",
    source: { id: "flow/request", version: 1, kind: "request", upstream: [] },
    outputs: [
      { title: "需求澄清", artifacts: [{ id: "flow/requirements", version: 1, kind: "requirements", upstream: [],
        sections: [{ title: "验收条件", text: "版本报告\n依赖报告\n汇总报告" }] }] },
      { title: "开发文档", artifacts: [{ id: "flow/development-plan", version: 1, kind: "development-plan", upstream: [],
        sections: [{ title: "开发计划", text: "两项核验后汇总。" }] }] },
    ],
  };
  const terminal = () => ({ finished: Promise.resolve("completed" as const), close() {} });
  const dispatch = createLocalDispatch(repo, 2, {
    split(options) {
      assert.equal(options.disableWebSearch, true);
      assert.doesNotMatch(options.prompt, /docs\/linked\.md/);
      return { ...terminal(), answerQuestions() { return false; },
        output: () => JSON.stringify({ tickets: allowValid ? draft : [{ ...draft[0], sources: ["docs/linked.md"] }, ...draft.slice(1)] }) };
    },
    execute(options) {
      actualWorkspaces.push(options.workspace);
      const input = JSON.parse(options.prompt.split("\n\n").at(-1) ?? "{}");
      assert.ok(input.evidence.every((entry: { text: string }) => entry.text === "frozen evidence"));
      options.onModel?.("fixture-sol");
      options.onThread?.(`thread-${actualWorkspaces.length}`);
      const names = [...input.evidence.map((item: { path: string }) => item.path), ...input.previousReports.map((item: { id: string }) => item.id)];
      return { ...terminal(), output: () => JSON.stringify({ report: `核验 ${names.join(" ")}` }) };
    },
  });
  t.after(async () => {
    await dispatch.close();
    for (const run of dispatch.list()) {
      if (run.directory) await rm(run.directory, { recursive: true, force: true });
    }
    await rm(repo, { recursive: true, force: true });
  });
  const wait = async () => {
    for (let round = 0; round < 100; round++) {
      const run = dispatch.list()[0];
      if (run && !["preparing", "running"].includes(run.status)) return run;
      await delay(20);
    }
    throw Error("等待本地派发状态超时");
  };
  assert.equal(dispatch.prepare(flow), 200);
  const rejected = await wait();
  assert.equal(rejected.status, "failed");
  assert.equal(actualWorkspaces.length, 0);
  allowValid = true;
  assert.equal(dispatch.prepare(flow), 200);
  const ready = await wait();
  assert.equal(ready.status, "ready");
  assert.notEqual(ready.id, rejected.id);
  assert.equal(dispatch.start(flow, rejected.id), 409);
  const updatedPlan = structuredClone(flow);
  const documentOutput = updatedPlan.outputs[1];
  assert.ok(documentOutput?.artifacts[0]);
  updatedPlan.outputs[1] = { ...documentOutput, artifacts: [{ ...documentOutput.artifacts[0], version: 2 }] };
  assert.equal(dispatch.start(updatedPlan, ready.id), 409);
  assert.equal(actualWorkspaces.length, 0);
  await writeFile(join(repo, guide), "later evidence");
  await commit();
  assert.equal(dispatch.start(flow, ready.id), 200);
  assert.equal(dispatch.start(flow, ready.id), 200);
  const done = await wait();
  assert.equal(done.status, "finished");
  assert.equal(actualWorkspaces.length, 3);
  assert.equal(new Set(actualWorkspaces).size, 3);
  assert.equal(new Set(done.jobs.map(job => job.threadId)).size, 3);
  assert.ok(done.jobs.every(job => job.model === "fixture-sol"));
  assert.equal(JSON.parse(await readFile(join(done.directory ?? "", "run.json"), "utf8")).status, "finished");
});
