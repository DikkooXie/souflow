import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import type { CodexAttemptEvent } from "../src/execution/codex-command-attempt.mts";
import type { Flow } from "../src/planning/conversation-flow.mts";
import { createWorkbenchServer } from "../src/workbench/demo-server.mts";
import type { DecisionCard } from "../src/workbench/demo-state.mts";

test("restores interrupted planning and receipt state without redelivering a stale answer", { timeout: 12000 }, async () => {
  const workspace = await mkdtemp(join(tmpdir(), "souflow-recovery-"));
  const database = join(workspace, "existing.sqlite");
  const members = { implementer: "a".repeat(32), reviewer: "b".repeat(32) };
  const beginAttempt: NonNullable<NonNullable<Parameters<typeof createWorkbenchServer>[1]>[1]> = options => {
    const clarify = options.prompt.includes("阶段「需求澄清」");
    let finish!: (status: "completed" | "needs-reconciliation") => void;
    const finished = new Promise<"completed" | "needs-reconciliation">(resolve => { finish = resolve; });
    const requestId = randomUUID();
    let sent = false;
    const publish = (kind: "question-cleared" | "question-expired" | "question-uncertain") => options.onEvent({ kind, requestId });
    phases.push(clarify ? "clarify" : "output");
    queueMicrotask(() => {
      if (!clarify) return finish("completed");
      const event: CodexAttemptEvent = { kind: "question-requested", requestId, questions: [
        { id: "scope", title: "范围", prompt: "请选择范围。", allowCustom: true, options: [] },
      ] };
      options.onEvent(event);
      disconnect = () => {
        publish(sent ? "question-uncertain" : "question-expired");
        finish("needs-reconciliation");
      };
    });
    return {
      finished,
      close() {
        if (clarify) publish(sent ? "question-uncertain" : "question-expired");
        finish("needs-reconciliation");
      },
      output: () => JSON.stringify(Object.fromEntries(((options.outputSchema?.required ?? []) as string[]).map(field => [field, "已核对依据"]))),
      answerQuestions(id, answer) {
        if (id !== requestId) return false;
        sent = true;
        delivered.push(answer);
        if (delivered.length === 2) {
          publish("question-cleared");
          finish("completed");
        }
        return true;
      },
    };
  };
  const phases: string[] = [];
  const delivered: unknown[] = [];
  let disconnect: (() => void) | undefined;
  let server: ReturnType<typeof createWorkbenchServer> | undefined;
  let origin = "";
  async function start() {
    server = createWorkbenchServer(undefined, [workspace, beginAttempt], database, { members });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address === "object");
    origin = `http://127.0.0.1:${address.port}`;
  }
  async function close() {
    if (!server) return;
    const closed = once(server, "workbenchClosed");
    server.close();
    server.closeAllConnections();
    await closed;
    server = undefined;
  }
  const identity = (role: keyof typeof members) => `Basic ${Buffer.from(`${role}:${members[role]}`).toString("base64")}`;
  const post = (path: string, data?: object, role: keyof typeof members = "implementer") => fetch(origin + path, {
    method: "POST", headers: { origin, authorization: identity(role), ...(data ? { "Content-Type": "application/json" } : {}) },
    ...(data ? { body: JSON.stringify(data) } : {}),
  });
  const read = async () => {
    const response = await fetch(`${origin}/api/decisions`, { headers: { authorization: identity("implementer") } });
    assert.equal(response.status, 200);
    return response.json() as Promise<{ flows: Flow[]; requests: DecisionCard[] }>;
  };
  async function until<T>(lookup: (snapshot: Awaited<ReturnType<typeof read>>) => T | undefined) {
    for (let index = 0; index < 80; index++) {
      const result = lookup(await read());
      if (result !== undefined) return result;
      await delay(20);
    }
    assert.fail("等待恢复状态超时");
  }
  try {
    await start();
    assert.throws(() => createWorkbenchServer(undefined, [workspace, beginAttempt], database, { members }), /另一个工作台/);
    const initial = await post("/api/workflows", { prompt: "B4 验收样例" });
    assert.equal(initial.status, 200);
    const { flowId } = await initial.json() as { flowId: string };
    const path = `/api/workflows/${flowId}/resume`;
    const answer = (id: string, scope: string) => post(`/api/decisions/${id}/answer`, { scope });
    const first = await until(snapshot => snapshot.requests.find(card => card.status === "pending"));
    const original = (await read()).flows[0]?.outputs[0];
    assert.ok(original);
    const writer = new DatabaseSync(database);
    try {
      writer.exec("BEGIN IMMEDIATE");
      assert.equal((await answer(first.id, "未持久化的答复")).status, 503);
      assert.deepEqual(delivered, []);
    } finally {
      writer.close();
    }
    assert.equal((await answer(first.id, "已发出但无回执")).status, 200);
    await close();

    assert.throws(() => createWorkbenchServer(undefined, [workspace, beginAttempt], database), /成员登录模式不一致/);
    await start();
    const afterRestart = await read();
    assert.equal(afterRestart.flows[0]?.status, "interrupted");
    assert.deepEqual(afterRestart.flows[0]?.outputs, [original]);
    assert.equal(afterRestart.requests[0]?.status, "uncertain");
    assert.equal((await fetch(`${origin}/api/decisions`)).status, 401);
    assert.equal((await post(path, undefined, "reviewer")).status, 403);
    assert.equal((await answer(first.id, "旧答复")).status, 409);
    assert.equal((await post(path)).status, 200);
    assert.equal((await post(path)).status, 409);
    const second = await until(snapshot => snapshot.requests.find(card => card.status === "pending"));
    assert.notEqual(second.id, first.id);
    assert.ok(disconnect);
    disconnect();
    await until(snapshot => snapshot.flows[0]?.status === "interrupted" ? true : undefined);
    assert.equal((await read()).requests[1]?.status, "expired");
    assert.equal((await answer(second.id, "旧答复")).status, 409);
    assert.equal((await post(path)).status, 200);
    const third = await until(snapshot => snapshot.requests.find(card => card.status === "pending"));
    assert.notEqual(third.id, second.id);
    assert.equal((await answer(third.id, "新会话的确认")).status, 200);
    const ready = await until(snapshot => snapshot.flows.find(flow => flow.status === "ready"));
    assert.deepEqual(ready.outputs[0], original);
    assert.deepEqual(phases, ["output", "clarify", "clarify", "clarify", "output", "output", "output"]);
    assert.deepEqual(delivered, [{ scope: "已发出但无回执" }, { scope: "新会话的确认" }]);
  } finally {
    await close();
    await rm(workspace, { recursive: true, force: true });
  }
});
