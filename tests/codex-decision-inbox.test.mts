import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { startCodexQuestionAttempt } from "../src/execution/codex-command-attempt.mts";
import { type Flow, phases } from "../src/planning/conversation-flow.mts";
import { createWorkbenchServer } from "../src/workbench/demo-server.mts";
import type { DecisionCard } from "../src/workbench/demo-state.mts";

async function listen(server: Server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
}

function close(server: Server) {
  return new Promise<void>(resolve => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
}

test("real App Server question replies reach their originating sessions through HTTP", {
  skip: process.env.SOULFLOW_TEST_NATIVE_CODEX !== "1",
  timeout: 30_000,
}, async t => {
  const root = await mkdtemp(join(tmpdir(), "souflow-native-question-"));
  const marker = join(root, "mcp-started");
  const results = new Map<string, string>();
  const stageRequests = new Set<string>();
  let nextResponse = 0;
  const model = "gpt-6.1-sol";
  const provider = createServer(async (request, response) => {
    const session = /^\/(a|b)\/v1\/responses$/.exec(request.url ?? "")?.[1];
    if (!session || request.method !== "POST") {
      response.writeHead(404).end();
      return;
    }
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { input?: { type: string; output?: unknown }[] };
      const output = body.input?.find(item => item.type === "function_call_output");
      const input = JSON.stringify(body.input ?? []);
      const phase = phases.find(entry => input.includes(`阶段「${entry.title}」`));
      const id = String(++nextResponse);
      if (output) results.set(session, JSON.stringify(output.output));
      if (phase) stageRequests.add(phase.title);
      const stageOutput = phase ? Object.fromEntries(phase.fields.map(field => [field, `合成产物 ${field}`])) : undefined;
      const item = output || (phase && phase.title !== "需求澄清") ? {
        type: "message", id: `msg_${id}`, role: "assistant", status: "completed",
        content: [{ type: "output_text", text: stageOutput ? JSON.stringify(stageOutput) : "已收到回答。", annotations: [] }],
      } : {
        type: "function_call", id: `fc_${id}`, call_id: `call_${id}`, status: "completed", name: "request_user_input",
        arguments: JSON.stringify({ questions: [{
          id: "language", header: "语言", question: "用什么语言？",
          options: [
            { label: "TypeScript", description: "浏览器原型" },
            { label: "Python", description: "桌面原型" },
          ],
        }] }),
      };
      const result = { id: `resp_${id}`, object: "response", model, status: "completed", output: [item] };
      response.writeHead(200, { "content-type": "text/event-stream" });
      for (const event of [
        { type: "response.created", response: { ...result, status: "in_progress", output: [] } },
        { type: "response.output_item.added", output_index: 0, item },
        { type: "response.output_item.done", output_index: 0, item },
        { type: "response.completed", response: result },
      ]) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      response.end();
    } catch {
      response.destroy();
    }
  });
  let server: Server | undefined;
  t.after(async () => {
    if (server) await close(server);
    await close(provider);
    await rm(root, { recursive: true, force: true });
  });
  const endpoint = await listen(provider);
  server = createWorkbenchServer(undefined, [root, options => {
    const session = options.prompt.includes("会话 A 的游戏") ? "a" : "b";
    const markerProgram = `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "started"); process.stdin.resume();`;
    return startCodexQuestionAttempt({
      ...options,
      command: [
        "codex", "--disable", "apps", "--disable", "plugins", "--disable", "hooks",
        "-c", `model=${JSON.stringify(model)}`, "-c", 'model_provider="souflow_fixture"',
        "-c", `model_providers.souflow_fixture={name="Soulflow fixture",base_url="${endpoint}/${session}/v1",requires_openai_auth=false,request_max_retries=0,stream_max_retries=0}`,
        "-c", `mcp_servers.souflow_test={command=${JSON.stringify(process.execPath)},args=${JSON.stringify(["-e", markerProgram])}}`,
        "app-server", "--stdio",
      ],
    });
  }]);
  const origin = await listen(server);
  const post = (url: string, body: object) => fetch(origin + url, {
    method: "POST", headers: { origin, "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  async function waitFor(predicate: (cards: DecisionCard[]) => boolean) {
    const deadline = Date.now() + 9000;
    for (;;) {
      const snapshot = await (await fetch(`${origin}/api/decisions`)).json() as {
        requests: DecisionCard[]; lastMessage: string; active: number;
      };
      if (predicate(snapshot.requests)) return snapshot.requests;
      if (Date.now() >= deadline || (!snapshot.active && snapshot.lastMessage)) {
        assert.fail(`Codex did not reach expected state: ${snapshot.lastMessage || "timed out"}`);
      }
      await delay(70);
    }
  }

  assert.equal((await post("/api/sessions", { prompt: "会话 A 的游戏" })).status, 200);
  const [a] = await waitFor(cards => cards.length === 1);
  assert.ok(a);
  assert.equal((await post("/api/sessions", { prompt: "会话 B 的游戏" })).status, 200);
  const [, b] = await waitFor(cards => cards.length === 2);
  assert.ok(b);
  assert.notEqual(a.id, b.id);
  const second = `/api/decisions/${b.id}/answer`;
  assert.equal((await post(second, { wrong: "Python" })).status, 422);
  assert.equal((await post(second, { language: "Python" })).status, 200);
  assert.equal((await post(second, { language: "Python" })).status, 409);
  const [unchanged] = await waitFor(cards => cards[1]?.status === "closed" && results.has("b"));
  assert.equal(unchanged?.status, "pending");
  assert.equal(results.has("a"), false);
  assert.equal((await post(`/api/decisions/${a.id}/answer`, { language: "TypeScript" })).status, 200);
  await waitFor(cards => cards[0]?.status === "closed" && results.has("a"));
  assert.match(results.get("a") ?? "", /TypeScript/);
  assert.match(results.get("b") ?? "", /Python/);
  await assert.rejects(stat(marker), { code: "ENOENT" });

  const kickoff = await post("/api/workflows", { prompt: "会话 A 的游戏，验证完整规划" });
  assert.equal(kickoff.status, 200);
  const { flowId } = await kickoff.json() as { flowId: string };
  const cards = await waitFor(entries => entries.some(card => card.flowId === flowId && card.status === "pending"));
  const clarification = cards.find(card => card.flowId === flowId);
  assert.ok(clarification);
  assert.deepEqual([...stageRequests], ["调研", "需求澄清"]);
  assert.equal((await post(`/api/decisions/${clarification.id}/answer`, { language: "Python" })).status, 200);
  const deadline = Date.now() + 12_000;
  for (;;) {
    const snapshot = await (await fetch(`${origin}/api/decisions`)).json() as { flows: Flow[] };
    const flow = snapshot.flows.find(entry => entry.id === flowId);
    assert.ok(flow);
    if (flow.status === "ready") {
      assert.deepEqual(flow.outputs.map(entry => entry.title), phases.map(entry => entry.title));
      const [prd, plan] = flow.outputs[3]?.artifacts ?? [];
      assert.ok(prd && plan);
      assert.equal(prd.sections[0]?.text, "合成产物 PRD");
      assert.deepEqual(plan.upstream[0], { id: prd.id, version: prd.version });
      assert.deepEqual(flow.outputs[4]?.artifacts[0]?.upstream, [{ id: plan.id, version: plan.version }]);
      break;
    }
    assert.equal(flow.status, "running", `流程停在第 ${flow.outputs.length + 1} 阶段`);
    assert.ok(Date.now() < deadline, "流程超时");
    await delay(70);
  }
  await assert.rejects(stat(marker), { code: "ENOENT" });
  const audit = await (await fetch(`${origin}/api/audit`)).json() as {
    recent: { flowId: string | null; attemptId: string | null; subject: string | null; kind: string; details: { model?: string } }[];
  };
  const attempts = new Set([a, b].map(card => audit.recent.find(event => event.kind === "decision.opened" && event.subject === card.id)?.attemptId));
  assert.equal(attempts.size, 2);
  for (const id of attempts) {
    assert.ok(id);
    assert.ok(audit.recent.some(event => event.kind === "request.submitted" && event.attemptId === id));
  }
  assert.equal(audit.recent.filter(event => event.flowId === flowId && event.kind === "model.started" && event.details.model === model).length, 5);
});
