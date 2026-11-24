import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate, setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { promisify } from "node:util";
import { dispatchTicketOutputBytes } from "../src/config/runtime.mts";
import { createLocalDispatch, readDispatchTickets, runLocalJobs } from "../src/execution/local-dispatch.mts";
import { applyLocalCodeChanges, readEditableFile, replayLocalCodePatch } from "../src/execution/local-code-changes.mts";
import type { Flow } from "../src/planning/conversation-flow.mts";
import { createDispatchMonitor } from "../src/execution/dispatch-monitor.mts";

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
  assert.throws(
    () => read(draft.map(ticket => ticket.id === "T3"
      ? { ...ticket, dependsOn: [...ticket.dependsOn, "T1"] }
      : ticket)),
    /duplicate-dependency:T3:T1/,
  );
  assert.throws(() => readDispatchTickets(JSON.stringify({ tickets: draft }), criteria, allowed,
    "report", { routine: "fixture-sol", advanced: "fixture-astra" }), /任务难度或理由/);
  assert.throws(() => read(draft.slice(0, 2)), /uncovered:AC-3/);
  assert.throws(() => read([{ ...draft[0], dependsOn: ["T3"] }, ...draft.slice(1)]), /cycle/);
  assert.throws(() => read([{ ...draft[0], sources: ["docs/linked.md"] }, ...draft.slice(1)]), /冻结版本/);
  const code = draft.slice(0, 2).map(ticket => ({ ...ticket, editPaths: [guide] }));
  assert.throws(() => readDispatchTickets(JSON.stringify({ tickets: code }), criteria.slice(0, 2), allowed, "code"), /重复分配/);
  assert.throws(() => readDispatchTickets(JSON.stringify({ tickets: [{ ...code[0], dependsOn: ["T2"] }] }), criteria, allowed, "code"), /unknown-dependency:T1:T2/);
});

test("a ten-ticket plan preserves dependencies while executing in waves of two", async () => {
  const tickets = Array.from({ length: 10 }, (_, index) => ({
    ...draft[0],
    id: `T${index + 1}`,
    dependsOn: index === 9 ? ["T1", "T9"] : [],
  }));
  const parsed = readDispatchTickets(JSON.stringify({ tickets }), ["AC-1"], new Set([guide]));
  assert.deepEqual(parsed, tickets);
  const jobs: Parameters<typeof runLocalJobs>[0] = parsed.map(ticket => ({ ...ticket, status: "queued" }));
  let active = 0;
  let peak = 0;
  let lastInputs: string[] = [];
  await runLocalJobs(jobs, 2, async (job, inputs) => {
    active++;
    peak = Math.max(peak, active);
    if (job.id === "T10") lastInputs = inputs.map(input => input.id);
    await setImmediate();
    active--;
  });
  assert.equal(peak, 2);
  assert.deepEqual(lastInputs, ["T1", "T9"]);
  assert.ok(jobs.every(job => job.status === "ready"));
  const output = JSON.stringify({ tickets });
  const bytes = Buffer.byteLength(output);
  const limit = (value: number) => dispatchTicketOutputBytes({ SOULFLOW_DISPATCH_TICKET_OUTPUT_MAX_BYTES: String(value) });
  assert.throws(() => readDispatchTickets(output, ["AC-1"], new Set([guide]), "report", undefined, false, limit(bytes - 1)),
    /传输字节上限/);
  assert.deepEqual(readDispatchTickets(output, ["AC-1"], new Set([guide]), "report", undefined, false, limit(bytes)), tickets);
});

test("the process reads local .env and inherited settings take precedence", async t => {
  const dir = await mkdtemp(join(tmpdir(), "souflow-dispatch-env-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, ".env"), "SOULFLOW_DISPATCH_TICKET_OUTPUT_MAX_BYTES=1428\n");
  const runtime = new URL("../src/config/runtime.mts", import.meta.url).href;
  const args = ["--experimental-strip-types", "--input-type=module", "--eval", `
    import { loadLocalEnv, dispatchTicketOutputBytes } from ${JSON.stringify(runtime)};
    loadLocalEnv();
    process.stdout.write(String(dispatchTicketOutputBytes()));
  `];
  const env = { ...process.env };
  delete env.SOULFLOW_DISPATCH_TICKET_OUTPUT_MAX_BYTES;
  assert.equal((await exec(process.execPath, args, { cwd: dir, env })).stdout, "1428");
  assert.equal((await exec(process.execPath, args, {
    cwd: dir, env: { ...env, SOULFLOW_DISPATCH_TICKET_OUTPUT_MAX_BYTES: "2856" },
  })).stdout, "2856");
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

test("replays a verified patch across umask differences and rejects executable-mode changes", async t => {
  const target = await mkdtemp(join(tmpdir(), "souflow-code-mode-"));
  t.after(() => rm(target, { recursive: true, force: true }));
  const source = join(target, "source");
  const successor = join(target, "successor");
  for (const workspace of [source, successor]) {
    await mkdir(join(workspace, "docs"), { recursive: true });
    await writeFile(join(workspace, guide), "before\n");
    await chmod(join(workspace, guide), 0o664);
  }
  const files = new Map([[guide, await readEditableFile(source, guide)]]);
  const patch = await applyLocalCodeChanges(target, source, files, [{ path: guide, before: "before", after: "after" }]);
  await chmod(join(successor, guide), 0o755);
  await assert.rejects(replayLocalCodePatch(successor, patch.patchPath, patch), /补丁文件版本不匹配/);
  await chmod(join(successor, guide), 0o664);
  await replayLocalCodePatch(successor, patch.patchPath, patch);
  assert.equal(await readFile(join(successor, guide), "utf8"), "after\n");
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

test("a ready successor starts while an independent job is still running", { timeout: 8000 }, async t => {
  const jobs: Parameters<typeof runLocalJobs>[0] = draft.map(ticket => ({
    ...ticket, dependsOn: ticket.id === "T3" ? ["T1"] : ticket.dependsOn, status: "queued",
  }));
  const gate = () => {
    let release!: () => void;
    const wait = new Promise<void>(resolve => { release = resolve; });
    return { wait, release };
  };
  const t1 = { started: gate(), finish: gate() };
  const t2 = { started: gate(), finish: gate() };
  const started: string[] = [];

  const dispatch = runLocalJobs(jobs, 2, async job => {
    started.push(job.id);
    if (job.id === "T3") return;
    const control = job.id === "T1" ? t1 : t2;
    control.started.release();
    await control.finish.wait;
  });
  t.after(async () => {
    t1.finish.release();
    t2.finish.release();
    await dispatch;
  });

  await Promise.all([t1.started.wait, t2.started.wait]);
  assert.deepEqual(started, ["T1", "T2"]);
  assert.deepEqual(jobs.map(job => job.status), ["running", "running", "queued"]);

  t1.finish.release();
  await setImmediate();
  assert.deepEqual(started, ["T1", "T2", "T3"]);
  assert.equal(jobs[0]?.status, "ready");
  assert.equal(typeof jobs[0]?.finishedAt, "number");
  assert.equal(jobs[1]?.status, "running");
  assert.equal(jobs[1]?.finishedAt, undefined);

  t2.finish.release();
  await dispatch;
  assert.deepEqual(jobs.map(job => job.status), ["ready", "ready", "ready"]);
  assert.ok(jobs.every(job => typeof job.startedAt === "number" && typeof job.finishedAt === "number"));
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
  const routing = { routine: "fixture-sol", advanced: "fixture-astra" };
  const classified = draft.map(ticket => ({
    ...ticket, difficulty: ticket.id === "T2" ? "advanced" : "routine", routingReason: `核对 ${ticket.id} 的验收范围`,
  }));
  const monitor = createDispatchMonitor("测试机器");
  let snapshotsChecked = 0;
  const dispatch = createLocalDispatch(repo, 2, {
    routing, monitor,
    split(options) {
      assert.equal(options.disableWebSearch, true);
      assert.doesNotMatch(options.prompt, /docs\/linked\.md/);
      return { ...terminal(), answerQuestions() { return false; },
        output: () => JSON.stringify({ tickets: allowValid ? classified : [{ ...classified[0], sources: ["docs/linked.md"] }, ...classified.slice(1)] }) };
    },
    execute(options) {
      actualWorkspaces.push(options.workspace);
      const input = JSON.parse(options.prompt.split("\n\n").at(-1) ?? "{}");
      assert.ok(input.evidence.every((entry: { text: string }) => entry.text === "frozen evidence"));
      assert.ok(options.model);
      options.onModel?.(options.model);
      const threadId = `thread-${actualWorkspaces.length}`;
      // 在真实派发回调前后读取，确保测试观察的是同一个会话。
      const before = monitor.snapshot().hosts[0]?.active.find(session => session.status === "connecting");
      assert.ok(before);
      const readSession = () => monitor.snapshot().hosts[0]?.active.find(session => session.id === before.id);
      options.onThread?.(threadId);
      const after = readSession();
      assert.ok(after);
      assert.equal(before.status, "connecting");
      assert.equal(before.threadId, undefined);
      assert.equal(after.status, "running");
      assert.equal(after.threadId, threadId);
      after.status = "connecting";
      assert.equal(readSession()?.status, "running");
      snapshotsChecked++;
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
  assert.deepEqual(ready.jobs.map(job => job.modelRoute?.requestedModel), ["fixture-sol", "fixture-astra", "fixture-sol"]);
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
  assert.equal(snapshotsChecked, actualWorkspaces.length);
  assert.equal(new Set(actualWorkspaces).size, 3);
  assert.equal(new Set(done.jobs.map(job => job.threadId)).size, 3);
  assert.deepEqual(done.jobs.map(job => job.model), ["fixture-sol", "fixture-astra", "fixture-sol"]);
  const host = monitor.snapshot().hosts[0];
  assert.ok(host);
  assert.equal(host.name, "测试机器");
  assert.deepEqual(host.active, []);
  for (const job of done.jobs) {
    const session: (typeof host.recent)[number] | undefined = host.recent.find(item => item.ticketId === job.id);
    assert.ok(session);
    assert.equal(session.batchId, done.id);
    assert.equal(session.flowId, flow.id);
    assert.equal(session.planVersion, 1);
    assert.equal(session.threadId, job.threadId);
    assert.equal(session.model, job.model);
    assert.equal(session.status, "completed");
    assert.ok(session.connectedAt && session.finishedAt && session.finishedAt >= session.connectedAt);
  }
  assert.equal(JSON.parse(await readFile(join(done.directory ?? "", "run.json"), "utf8")).status, "finished");
});
