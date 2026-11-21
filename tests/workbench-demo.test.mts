import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";
import type { Flow } from "../src/planning/conversation-flow.mts";
import { createWorkbenchServer } from "../src/workbench/demo-server.mts";
import type { createDecisionDemo } from "../src/workbench/demo-state.mts";

type Snapshot = ReturnType<ReturnType<typeof createDecisionDemo>["snapshot"]> & { flows: Flow[] };

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
  }], { codex: 2, demo: 24 });
  for (let session = 0; session < 2; session += 1) {
    assert.equal((await post("/api/sessions", { prompt: `澄清会话 ${session}` })).status, 200);
  }
  assert.equal((await post("/api/workflows", { prompt: "开发一个游戏" })).status, 409);
  const capacity = await post("/api/sessions", { prompt: "超出配置的会话" });
  assert.equal(capacity.status, 409);
  assert.match((await capacity.json()).error, /已有 2 条会话进行中/);
  assert.deepEqual((await read()).flows, []);
});

test("loads local environment settings at startup and keeps the file off HTTP", { timeout: 5000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), "souflow-env-"));
  const auditPath = join(dir, "from-dotenv.sqlite");
  await writeFile(join(dir, ".env"), [
    "SOULFLOW_DEMO_PORT=0",
    "SOULFLOW_DEMO_MAX_CONCURRENT=1",
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
  const origin = /^Soulflow 决策收件箱 (http:\/\/127\.0\.0\.1:\d+)/.exec(String(first[0]))?.[1];
  assert.ok(origin, "the demo server should announce its bound address");
  assert.ok((await stat(auditPath)).isFile());
  const envResponse = await fetch(`${origin}/.env`);
  assert.equal(envResponse.status, 404);
  assert.doesNotMatch(await envResponse.text(), /synthetic-test-value/);
  const post = () => fetch(`${origin}/api/workflows`, {
    method: "POST", headers: { origin, "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: "验证配置的流程上限" }),
  });
  assert.equal((await post()).status, 200);
  assert.equal((await post()).status, 200);
  assert.equal((await post()).status, 409);
});
