import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { auditDecisionAnswers, openActivityStore, readActivity } from "../src/audit/activity-store.mts";
import { createWorkbenchServer } from "../src/workbench/demo-server.mts";

test("counts retries once and measures repeats and returns within a tab", () => {
  const audit = openActivityStore(":memory:", () => 100_000);
  const session = randomUUID();
  function record(input: object) {
    const event = readActivity({ id: randomUUID(), session, ...input });
    assert.ok(event);
    assert.ok(audit.recordActivity(event));
    return event;
  }
  try {
    const subject = randomUUID();
    const click = { kind: "ui.click", view: "decisions", control: "open-card", subject };
    const first = record({ ...click, elapsed: 100 });
    assert.ok(audit.recordActivity(first));
    record({ ...click, elapsed: 800 });
    record({ ...click, elapsed: 900, subject: randomUUID() });
    record({ ...click, elapsed: 1000, session: randomUUID() });
    record({ ...click, elapsed: 3500 });
    for (const [view, destination, elapsed] of [["home", "audit", 100], ["audit", "home", 800], ["home", "audit", 7000], ["audit", "home", 40000]]) {
      record({ kind: "ui.navigate", view, destination, elapsed });
    }
    record({ ...click, elapsed: 41_000 });
    record({ kind: "ui.navigate", view: "decisions", destination: "home", elapsed: 41_100 });
    record({ kind: "ui.navigate", view: "home", destination: "decisions", elapsed: 41_200 });
    record({ ...click, elapsed: 41_300 });
    const report = audit.report(1);
    assert.equal(report.totals["ui.click"], 7);
    assert.deepEqual({ ...report.clicks[0] }, { control: "open-card", count: 7, repeated: 1 });
    assert.deepEqual({ ...report.transitions[0] }, { first: "audit", second: "home", count: 4, reversals: 2 });
    assert.equal(report.interactions.length, 13);
  } finally {
    audit.close();
  }
});

test("hides unprefixed credentials in structured answers without losing ordinary text", () => {
  const audit = openActivityStore();
  try {
    const answers = auditDecisionAnswers([
      { id: "q-one", title: "连接资料", prompt: "请输入访问令牌" },
      { id: "format", title: "格式", prompt: "导出的文件格式" },
    ], { "q-one": "plain-test-credential", format: "CSV" });
    audit.record({ kind: "decision.answered", details: { answers: { ...answers, password: "synthetic-value-only" } } });
    assert.deepEqual(audit.report(1).recent[0]?.details, { answers: {
      "q-one": "[已隐藏凭据]", format: "CSV", password: "[已隐藏凭据]",
    } });
  } finally {
    audit.close();
  }
});

test("audits a complete planning path, rejects forged activity, and retains records after restart", { timeout: 10_000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), "souflow-audit-"));
  const file = join(dir, "audit.sqlite");
  const server = createWorkbenchServer(1, undefined, file);
  const close = async () => {
    if (!server.listening) return;
    server.close();
    server.closeAllConnections();
    await once(server, "close");
  };
  t.after(async () => { await close(); await rm(dir, { recursive: true }); });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  const post = (path: string, body: object, site = origin) => fetch(origin + path, {
    method: "POST", headers: { origin: site, "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const event = { kind: "ui.click", id: randomUUID(), session: randomUUID(), view: "home", elapsed: 50, control: "send-request" };
  assert.equal((await post("/api/activity", event, "https://example.invalid")).status, 403);
  assert.equal((await post("/api/activity", { ...event, control: "literal-tampered-content" })).status, 422);
  assert.equal((await post("/api/activity", { ...event, text: "untracked typed text" })).status, 200);
  assert.equal((await fetch(`${origin}/api/audit`, { headers: { "sec-fetch-site": "cross-site" } })).status, 403);
  assert.equal((await fetch(`${origin}/api/audit?days=90`)).status, 422);

  const prompt = "给列表添加导出\nAPI_KEY=sample-secret-value";
  const response = await post("/api/workflows", { prompt });
  assert.equal(response.status, 200);
  const { flowId } = await response.json() as { flowId: string };
  const snapshot = await (await fetch(`${origin}/api/decisions`)).json() as { requests: { id: string; flowId?: string }[] };
  const card = snapshot.requests.find(item => item.flowId === flowId);
  assert.ok(card);
  assert.equal((await post(`/api/decisions/${card.id}/answer`, { scope: "只导出当前筛选" })).status, 200);

  const deadline = Date.now() + 2000;
  for (;;) {
    const report = await (await fetch(`${origin}/api/audit`)).json() as { totals: Record<string, number> };
    if (report.totals["flow.finished"] === 1) break;
    assert.ok(Date.now() < deadline, "audit did not receive completion");
    await delay(25);
  }
  const resetFlow = await post("/api/workflows", { prompt: "验证演示重置记录" });
  assert.equal(resetFlow.status, 200);
  const { flowId: canceledId } = await resetFlow.json() as { flowId: string };
  const reset = await fetch(`${origin}/api/demo/reset`, { method: "POST", headers: { origin } });
  assert.equal(reset.status, 200);
  await close();
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  const audit = openActivityStore(file);
  try {
    const report = audit.report(7);
    assert.equal(report.totals["request.submitted"], 2);
    assert.equal(report.totals["phase.completed"], 6);
    assert.equal(report.totals["decision.answered"], 1);
    const timeline = report.recent.filter(row => row.flowId === flowId).reverse();
    assert.equal(timeline[0]?.kind, "request.submitted");
    assert.deepEqual(timeline[0]?.details, { text: "给列表添加导出\nAPI_KEY=[已隐藏凭据]" });
    assert.equal(timeline.find(row => row.kind === "decision.updated")?.subject, card.id);
    assert.deepEqual(timeline.at(-1)?.details, { status: "ready", phase: "拆单" });
    assert.deepEqual(report.recent.find(row => row.flowId === canceledId && row.kind === "flow.finished")?.details, { status: "reset" });
    assert.deepEqual(report.recent.find(row => row.kind === "demo.reset")?.details, { flowIds: [canceledId] });
    assert.doesNotMatch(JSON.stringify(report), /sample-secret-value|untracked typed text|literal-tampered-content/);
  } finally {
    audit.close();
  }
});

test("retains terminal audit records when a Codex planning run is shut down", { timeout: 5000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), "souflow-audit-close-"));
  const file = join(dir, "audit.sqlite");
  const server = createWorkbenchServer(undefined, [dir, () => {
    let close!: () => void;
    const finished = new Promise<"interrupted">(resolve => { close = () => resolve("interrupted"); });
    return { finished, close, answerQuestions: () => false, output: () => undefined };
  }], file);
  t.after(async () => {
    if (server.listening) {
      server.close();
      server.closeAllConnections();
      await once(server, "close");
    }
    await rm(dir, { recursive: true });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  const response = await fetch(`${origin}/api/workflows`, {
    method: "POST", headers: { origin, "Content-Type": "application/json" }, body: JSON.stringify({ prompt: "验证停止时的事件" }),
  });
  assert.equal(response.status, 200);
  const { flowId } = await response.json() as { flowId: string };
  server.close();
  server.closeAllConnections();
  await once(server, "close");
  await delay(0);
  const audit = openActivityStore(file);
  try {
    const events = audit.report(1).recent.filter(row => row.flowId === flowId);
    assert.equal(events[0]?.kind, "flow.finished");
    assert.deepEqual(events[0]?.details, { status: "failed", phase: "调研" });
    assert.equal(events.find(row => row.kind === "attempt.finished")?.attemptId, events.find(row => row.kind === "attempt.started")?.attemptId);
  } finally {
    audit.close();
  }
});
