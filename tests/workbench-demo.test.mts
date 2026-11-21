import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";
import { currentDevelopmentPlan, type Flow, maxArtifactTextLength } from "../src/planning/conversation-flow.mts";
import type { createLocalDispatch } from "../src/execution/local-dispatch.mts";
import { createWorkbenchServer } from "../src/workbench/demo-server.mts";
import type { createDecisionDemo } from "../src/workbench/demo-state.mts";

type Snapshot = ReturnType<ReturnType<typeof createDecisionDemo>["snapshot"]> & {
  flows: Flow[];
  dispatches: ReturnType<ReturnType<typeof createLocalDispatch>["list"]>;
  inputLimits: { promptMaxLength: number; answerMaxLength: number };
};

async function start(t: TestContext, live?: Parameters<typeof createWorkbenchServer>[1], limits?: Parameters<typeof createWorkbenchServer>[3]) {
  const server = createWorkbenchServer(100, live, undefined, limits);
  t.after(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      server.closeAllConnections();
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const url = `http://127.0.0.1:${address.port}`;
  const post = (path: string, body?: object, origin = url) => fetch(url + path, {
    method: "POST", headers: body ? { origin, "Content-Type": "application/json" } : { origin },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const read = async (): Promise<Snapshot> => {
    const response = await fetch(`${url}/api/decisions`);
    assert.equal(response.status, 200);
    return response.json();
  };
  return { url, post, read };
}

test("the decision inbox routes answers to the selected session and records one receipt", async t => {
  const { url, post, read } = await start(t);
  const page = await fetch(url);
  assert.match(await page.text(), /决策收件箱/);
  const [first, second] = (await read()).requests;
  assert.ok(first && second);
  const secondAnswer = ["/api/decisions", second.id, "answer"].join("/");
  const firstAnswer = ["/api/decisions", first.id, "answer"].join("/");
  const answer = { scope: "当前筛选结果" };
  assert.equal((await post(secondAnswer, { language: "TypeScript" })).status, 422);
  assert.equal((await post(secondAnswer, { scope: "所有项目" })).status, 422);
  assert.equal((await post(secondAnswer, answer, "https://example.test")).status, 403);
  const results = await Promise.all([post(secondAnswer, answer), post(secondAnswer, answer)]);
  assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);

  await delay(130);
  const [unchanged, answered] = (await read()).requests;
  assert.equal(unchanged?.status, "pending");
  assert.equal(answered?.status, "acknowledged");
  assert.deepEqual(answered?.answers, answer);
  assert.deepEqual(answered?.timeline.map(entry => entry.label), [
    "Codex 已发出提问", "已提交回答", "原会话已收到回答",
  ]);
  assert.equal((await post(firstAnswer, { language: " TypeScript ", genre: "" })).status, 422);
  assert.equal((await post(firstAnswer, { language: " TypeScript ", genre: " 经营模拟 " })).status, 200);
  await delay(130);
  assert.deepEqual((await read()).requests[0]?.answers, { language: "TypeScript", genre: "经营模拟" });
});

test("disconnect invalidates question requests and reset prevents stale answers", async t => {
  const { post, read } = await start(t);
  const [first, second] = (await read()).requests;
  assert.ok(first && second);
  const firstPath = ["/api/decisions", first.id].join("/");
  const secondPath = ["/api/decisions", second.id].join("/");
  const scope = { scope: "当前筛选结果" };
  assert.equal((await post(`${firstPath}/disconnect`)).status, 200);
  assert.equal((await post(`${firstPath}/answer`, { language: "Python", genre: "解谜" })).status, 409);
  assert.equal((await post(`${secondPath}/answer`, scope)).status, 200);
  assert.equal((await post(`${secondPath}/disconnect`)).status, 200);
  await delay(130);
  assert.deepEqual((await read()).requests.map(request => request.status), ["expired", "uncertain"]);

  assert.equal((await post("/api/demo/reset")).status, 200);
  assert.equal((await post(`${secondPath}/answer`, scope)).status, 404);
  assert.deepEqual((await read()).requests.map(request => request.status), ["pending", "pending"]);
});

test("advances only the workflow whose clarification was answered", { timeout: 5000 }, async t => {
  const { post, read } = await start(t);
  assert.equal((await post("/api/workflows", { prompt: "项目 A 的游戏" })).status, 200);
  assert.equal((await post("/api/workflows", { prompt: "项目 B 的导出" })).status, 200);
  const { flows, requests } = await read();
  const [a, b] = flows;
  assert.ok(a && b);
  assert.deepEqual(a.outputs.map(output => output.title), ["调研"]);
  const decision = requests.find(card => card.flowId === b.id);
  assert.ok(decision);
  assert.equal((await post(`/api/decisions/${decision.id}/answer`, { scope: "CSV 首版" })).status, 200);
  const deadline = Date.now() + 2000;
  let snapshot = await read();
  while (snapshot.flows[1]?.status !== "ready" && Date.now() < deadline) {
    await delay(30);
    snapshot = await read();
  }
  assert.equal(snapshot.flows[0]?.status, "running");
  assert.equal(snapshot.flows[1]?.status, "ready");
  assert.deepEqual(snapshot.flows[1]?.outputs.map(output => output.title), ["调研", "需求澄清", "技术选型", "开发文档", "拆单"]);
  assert.match(snapshot.flows[1]?.outputs[3]?.artifacts[0]?.sections[0]?.text ?? "", /CSV 首版/);
  assert.equal(snapshot.requests.find(card => card.flowId === a.id)?.status, "pending");
});

test("rejects a new workflow when existing Codex sessions have filled capacity", async t => {
  const { post, read } = await start(t, [process.cwd(), () => {
    let close!: () => void;
    const finished = new Promise<"interrupted">(resolve => { close = () => resolve("interrupted"); });
    return { finished, close, answerQuestions: () => false, output: () => undefined };
  }], { limits: { codex: 2, demo: 24 } });
  for (let session = 0; session < 2; session += 1) {
    assert.equal((await post("/api/sessions", { prompt: `澄清会话 ${session}` })).status, 200);
  }
  assert.equal((await post("/api/workflows", { prompt: "开发一个游戏" })).status, 409);
  const capacity = await post("/api/sessions", { prompt: "超出配置的会话" });
  assert.equal(capacity.status, 409);
  assert.match((await capacity.json()).error, /已有 2 条会话进行中/);
  assert.deepEqual((await read()).flows, []);
});

test("revises a plan without reusing the old dispatch confirmation or changing an active code run", { timeout: 10000 }, async t => {
  const repo = await mkdtemp(join(tmpdir(), "souflow-code-workbench-"));
  const file = "docs/guide.md";
  await mkdir(join(repo, "docs"));
  await writeFile(join(repo, file), "初始文档\n");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "ignore" });
  git("init", "-q");
  git("add", "docs");
  git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--no-gpg-sign", "-qm", "fixture");
  const terminal = { finished: Promise.resolve("completed" as const), close() {} };
  let executions = 0;
  const splitPrompts: string[] = [];
  let finishExecution!: () => void;
  const executionGate = new Promise<"completed">(resolve => { finishExecution = () => resolve("completed"); });
  const executedDirs = new Set<string>();
  const { post, read } = await start(t, [repo, options => ({
    ...terminal, answerQuestions: () => false,
    output: () => JSON.stringify(Object.fromEntries(((options.outputSchema?.required ?? []) as string[]).map(field => [field, `示例${field}`]))),
  })], { dispatchAdapters: {
    split(options) {
      splitPrompts.push(options.prompt);
      const code = options.prompt.includes("拆成本地代码工单");
      const fields = { id: "T1", title: "整理指引", instructions: "更新使用步骤", criteria: ["AC-1"], dependsOn: [], sources: [file] };
      return { ...terminal, answerQuestions: () => false,
        output: () => JSON.stringify({ tickets: [code ? { ...fields, editPaths: [file] } : fields] }) };
    },
    execute(options) {
      executions += 1;
      executedDirs.add(join(options.workspace, "..", ".."));
      return { finished: executionGate, close: finishExecution, output: () => JSON.stringify({ report: `已核对 ${file}`,
        ...(options.prompt.includes("文本替换") ? { edits: [{ path: file, before: "初始文档", after: "已更新" }] } : {}),
      }) };
    },
  } });
  t.after(async () => {
    for (const dir of executedDirs) await rm(dir, { recursive: true, force: true });
    await rm(repo, { recursive: true, force: true });
  });
  async function waitFor<T>(find: (snapshot: Snapshot) => T | undefined): Promise<T> {
    for (let index = 0; index < 100; index++) {
      const value = find(await read());
      if (value !== undefined) return value;
      await delay(20);
    }
    throw Error("等待派发状态超时");
  }
  assert.equal((await post("/api/workflows", { prompt: "更新使用指引" })).status, 200);
  const flow = await waitFor(snapshot => snapshot.flows.find(item => item.status === "ready"));
  const base = `/api/workflows/${flow.id}/local-dispatch`;
  const revise = `/api/workflows/${flow.id}/plan/revise`;
  const original = currentDevelopmentPlan(flow);
  const draft = flow.outputs.flatMap(output => output.artifacts).find(artifact => artifact.kind === "ticket-drafts");
  assert.ok(original && draft);
  assert.equal((await post(`${base}/prepare`, { kind: "invalid" })).status, 422);
  assert.equal((await post(`${base}/prepare`)).status, 200);
  const report = await waitFor(snapshot => snapshot.dispatches.find(run => run.kind === "report" && run.status === "ready"));
  assert.equal((await post(`${base}/prepare`, { kind: "code" })).status, 200);
  const code = await waitFor(snapshot => snapshot.dispatches.find(run => run.kind === "code" && run.status === "ready"));
  assert.equal(executions, 0);
  assert.deepEqual(code.jobs[0]?.editPaths, [file]);
  assert.equal((await post(`${base}/start`, { id: "stale" })).status, 409);
  assert.equal((await post(revise, { version: 1, text: "新计划" }, "https://example.test")).status, 403);
  assert.equal((await post(revise, { version: 1, text: " " })).status, 422);
  assert.equal((await post(revise, { version: 1, text: "超".repeat(maxArtifactTextLength + 1) })).status, 422);
  assert.equal((await post(revise, { version: 1, text: original.sections[0]?.text })).status, 422);
  const revised = await Promise.all([
    post(revise, { version: 1, text: "只更新使用步骤" }),
    post(revise, { version: 1, text: "只更新使用步骤" }),
  ]);
  assert.deepEqual(revised.map(response => response.status).sort(), [200, 409]);
  const [updated] = (await read()).flows;
  assert.ok(updated);
  const current = currentDevelopmentPlan(updated);
  assert.equal(current?.version, 2);
  assert.equal(current?.id, original.id);
  assert.deepEqual(current?.replaces, { id: original.id, version: 1 });
  assert.deepEqual(current?.upstream, original.upstream);
  assert.equal(current?.sections[0]?.text, "只更新使用步骤");
  assert.deepEqual(updated.planHistory, [original, draft]);
  assert.ok(updated.outputs.every(output => output.artifacts.every(artifact => artifact.kind !== "ticket-drafts")));

  assert.equal((await post(`${base}/start`, { id: code.id })).status, 409);
  assert.equal((await post(`${base}/start`, { id: report.id })).status, 409);
  assert.equal(executions, 0);
  assert.equal((await post(`${base}/prepare`, { kind: "code" })).status, 200);
  const newCode = await waitFor(snapshot => snapshot.dispatches.find(run => run.kind === "code" && run.plan.version === 2 && run.status === "ready"));
  assert.notEqual(newCode.id, code.id);
  assert.match(splitPrompts.at(-1) ?? "", /只更新使用步骤/);
  assert.equal((await post(`${base}/start`, { id: newCode.id })).status, 200);
  assert.equal((await post(revise, { version: 2, text: "另一个新版" })).status, 409);
  finishExecution();
  const finished = await waitFor(snapshot => snapshot.dispatches.find(run => run.id === newCode.id && run.status === "finished"));
  assert.equal(executions, 1);
  assert.deepEqual(finished.jobs[0]?.changedFiles, [file]);
  assert.ok(finished.jobs[0]?.patchPath);
  assert.equal(await readFile(join(repo, file), "utf8"), "初始文档\n");
  assert.equal((await read()).dispatches.find(run => run.id === report.id)?.status, "ready");
  assert.equal((await read()).dispatches.find(run => run.id === code.id)?.status, "ready");
  assert.equal((await post(revise, { version: 2, text: "保留已交付记录的新计划" })).status, 200);
  assert.equal((await post(`${base}/start`, { id: newCode.id })).status, 409);
  assert.deepEqual((await read()).flows[0]?.planHistory, [original, draft, current]);
});

test("loads local environment settings at startup and keeps the file off HTTP", { timeout: 5000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), "souflow-env-"));
  const auditPath = join(dir, "from-dotenv.sqlite");
  await writeFile(join(dir, ".env"), [
    "SOULFLOW_DEMO_PORT=0",
    "SOULFLOW_DEMO_MAX_CONCURRENT=1",
    "SOULFLOW_PROMPT_MAX_LENGTH=8000",
    "SOULFLOW_ANSWER_MAX_LENGTH=6",
    "SOULFLOW_AUDIT_REPEAT_CLICK_MS=600",
    "SOULFLOW_AUDIT_QUICK_RETURN_MS=1500",
    "SOULFLOW_AUDIT_INSIGHT_MIN_COUNT=1",
    `SOULFLOW_AUDIT_DB="${auditPath}"`,
    "OPENAI_API_KEY=synthetic-test-value",
  ].join("\n"), { mode: 0o600 });
  const entry = fileURLToPath(new URL("../src/workbench/demo-server.mts", import.meta.url));
  const child = spawn(process.execPath, ["--experimental-strip-types", entry], {
    cwd: dir, env: { SOULFLOW_DEMO_MAX_CONCURRENT: "2" }, stdio: ["ignore", "pipe", "inherit"],
  });
  const closed = once(child, "close");
  t.after(async () => {
    child.kill();
    try {
      await closed;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  const lines = createInterface({ input: child.stdout });
  const first = await Promise.race([once(lines, "line", { signal: t.signal }), closed.then(() => [])]);
  const origin = /^souflow 决策收件箱 (http:\/\/127\.0\.0\.1:\d+)/.exec(String(first[0]))?.[1];
  assert.ok(origin, "the demo server should announce its bound address");
  assert.ok((await stat(auditPath)).isFile());
  const envResponse = await fetch(`${origin}/.env`);
  assert.equal(envResponse.status, 404);
  assert.doesNotMatch(await envResponse.text(), /synthetic-test-value/);
  const snapshot = await (await fetch(`${origin}/api/decisions`)).json() as Snapshot;
  assert.deepEqual(snapshot.inputLimits, { promptMaxLength: 8000, answerMaxLength: 6 });
  const report = await fetch(`${origin}/api/audit`);
  assert.equal(report.status, 200);
  assert.deepEqual((await report.json()).thresholds, { repeatClickMs: 600, quickReturnMs: 1500, insightMinCount: 1 });
  const firstCard = snapshot.requests[0];
  assert.ok(firstCard);
  const post = (path: string, body: object) => fetch(origin + path, {
    method: "POST", headers: { origin, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const submit = (prompt: string) => post("/api/workflows", { prompt });
  const widePrompt = "界".repeat(snapshot.inputLimits.promptMaxLength);
  const overLimit = await submit(widePrompt + "外");
  assert.equal(overLimit.status, 422);
  assert.match((await overLimit.json()).error, /8000/);
  assert.equal((await submit(widePrompt)).status, 200);
  assert.equal((await submit("验证配置的流程上限")).status, 200);
  assert.equal((await submit("第三个流程")).status, 409);
  const answer = (genre: string) => post(`/api/decisions/${firstCard.id}/answer`, { language: "TypeScript", genre });
  assert.equal((await answer("🎮🎮🎮外")).status, 422);
  assert.equal((await answer("🎮🎮🎮")).status, 200);
});
