import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import type { IssueDetail } from "../src/connections/issue-tracker.mts";
import { startCodexReadOnlyTask } from "../src/execution/codex-command-attempt.mts";
import { createDispatchMonitor } from "../src/execution/dispatch-monitor.mts";
import { createIssueVerifier, IssueVerificationUncertain } from "../src/execution/issue-verification.mts";

const issue: IssueDetail = { number: 1, title: "测试工单", body: "核验工单的验收步骤", state: "OPEN", assignees: [], pulls: [],
  url: "https://github.com/example/repo/issues/1" };

test("核验器校验结构化报告并区分未确认结果", async () => {
  const monitor = createDispatchMonitor("fixture");
  const make = (outcome: "completed" | "interrupted" | "needs-reconciliation", output?: string) =>
    createIssueVerifier(monitor, { startAttempt(options) {
      assert.equal(options.untrustedContext, JSON.stringify({ title: issue.title, description: issue.body }));
      assert.doesNotMatch(options.prompt, /验收步骤/);
      assert.deepEqual(options.outputSchema?.required, ["report"]);
      return { finished: Promise.resolve(outcome), output: () => output, close() {} };
    } });
  const signal = new AbortController().signal;
  assert.equal(await make("completed", '{"report":"已核对清单"}')(issue, () => {}, signal), "已核对清单");
  for (const invalid of [undefined, "报告", '{"report":""}', '{"report":"内容","extra":1}']) {
    await assert.rejects(make("completed", invalid)(issue, () => {}, signal), /报告格式无效/);
  }
  for (const outcome of ["interrupted", "needs-reconciliation"] as const) {
    await assert.rejects(make(outcome)(issue, () => {}, signal), (error: unknown) =>
      error instanceof IssueVerificationUncertain && error.reason === outcome);
  }
  const timed = createIssueVerifier(monitor, { timeoutMs: 5, startAttempt() {
    let complete!: (value: "needs-reconciliation") => void;
    const finished = new Promise<"needs-reconciliation">(resolve => { complete = resolve; });
    return { finished, output: () => undefined, close() { complete("needs-reconciliation"); } };
  } });
  await assert.rejects(timed(issue, () => {}, signal), (error: unknown) =>
    error instanceof IssueVerificationUncertain && error.reason === "timeout");
  const controller = new AbortController();
  const interrupted = timed(issue, () => {}, controller.signal);
  controller.abort();
  await assert.rejects(interrupted, (error: unknown) => error instanceof IssueVerificationUncertain && error.reason === "interrupted");
});

test("原生 Codex 通过本地模型回环暴露的工具和不可信工单上下文", {
  skip: process.env.SOULFLOW_TEST_NATIVE_CODEX !== "1", timeout: 30_000,
}, async t => {
  let received: Record<string, unknown> | undefined;
  const requests: string[] = [];
  const provider = createServer(async (request, response) => {
    requests.push(`${request.method} ${request.url}`);
    if (request.method !== "POST" || request.url !== "/v1/responses") { response.writeHead(404).end(); return; }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    received = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const item = { type: "message", id: "msg_fixture", role: "assistant", status: "completed",
      content: [{ type: "output_text", text: '{"report":"模拟核验完成"}', annotations: [] }] };
    const result = { id: "resp_fixture", object: "response", model: "gpt-6.1-sol", status: "completed", output: [item] };
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (const event of [
      { type: "response.created", response: { ...result, status: "in_progress", output: [] } },
      { type: "response.output_item.added", output_index: 0, item },
      { type: "response.output_item.done", output_index: 0, item },
      { type: "response.completed", response: result },
    ]) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    response.end();
  });
  provider.listen(0, "127.0.0.1");
  await once(provider, "listening");
  t.after(async () => { provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve())); });
  const address = provider.address();
  assert.ok(address && typeof address === "object");
  const verify = createIssueVerifier(createDispatchMonitor("fixture"), { startAttempt(options) {
    return startCodexReadOnlyTask({ ...options, model: "gpt-6.1-sol", command: ["codex",
      "-c", 'model="gpt-6.1-sol"', "-c", 'model_provider="souflow_fixture"',
      "-c", "features.multi_agent_v2=true", "-c", "features.shell_tool=true", "-c", "features.untrusted_as_tool_output=false",
      "-c", `model_providers.souflow_fixture={name="Fixture",base_url="http://127.0.0.1:${address.port}/v1",requires_openai_auth=false,request_max_retries=0,stream_max_retries=0}`,
      "--disable", "apps", "--disable", "plugins", "--disable", "hooks", "app-server", "--stdio"] });
  } });
  try {
    assert.equal(await verify(issue, () => {}, new AbortController().signal), "模拟核验完成");
  } catch (error) {
    t.diagnostic(`本地模型请求：${requests.join("、")}`);
    throw error;
  }
  assert.ok(received);
  const tools = received.tools as Array<{ name?: string }> | undefined;
  assert.deepEqual(tools ?? [], []);
  assert.ok(Array.isArray(received.input));
  assert.ok(received.input.some((item: { type?: string; name?: string; output?: string }) =>
    item.type === "function_call_output" && item.name === "github_issue" && item.output?.includes("核验工单的验收步骤")));
});

