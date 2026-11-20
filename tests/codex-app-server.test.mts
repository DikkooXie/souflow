import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { finished } from "node:stream/promises";
import test from "node:test";
import { startCodexCommandAttempt, type CodexAttemptEvent } from "../src/execution/codex-command-attempt.mts";

type Approval = Extract<CodexAttemptEvent, { kind: "approval-requested" }>["approval"];

const model = "gpt-6.1-sol";
const fixtureCommand = "/bin/echo souflow_fixture";

test("routes native App Server cancellations in reverse order and expires a disconnected request", {
  skip: process.env.SOULFLOW_TEST_NATIVE_CODEX !== "1",
  timeout: 30_000,
}, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "souflow-native-approval-")));
  const attempts: ReturnType<typeof startCodexCommandAttempt>[] = [];
  const providerCalls: string[] = [];
  const provider = createServer(async (request, response) => {
    const route = /^\/(ticket-a|ticket-b|disconnected)\/v1\/responses$/.exec(request.url ?? "");
    if (request.method !== "POST" || !route?.[1]) {
      response.writeHead(404).end();
      return;
    }
    const label = route[1];
    request.resume();
    try {
      await finished(request, { cleanup: true });
    } catch {
      response.destroy();
      return;
    }
    if (providerCalls.includes(label)) {
      t.diagnostic(`${label} continued to the model before an expected interruption`);
      providerCalls.push(label);
      response.writeHead(409).end();
      return;
    }
    const id = `${label}-${providerCalls.push(label)}`;
    // 固定模型输出，使真实 App Server 的审批和取消行为可以重复验证。
    const item = {
      type: "function_call",
      id: `fc_${id}`,
      call_id: `call_${id}`,
      name: "exec_command",
      arguments: JSON.stringify({ cmd: fixtureCommand, login: false }),
      status: "completed",
    };
    const result = { id: `resp_${id}`, object: "response", model, status: "completed", output: [item] };
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (const event of [
      { type: "response.created", response: { ...result, status: "in_progress", output: [] } },
      { type: "response.output_item.added", output_index: 0, item },
      { type: "response.output_item.done", output_index: 0, item },
      { type: "response.completed", response: result },
    ]) {
      response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    }
    response.end();
  });
  t.after(async () => {
    for (const attempt of attempts) attempt.close();
    provider.closeAllConnections();
    await new Promise<void>(resolve => { provider.close(() => resolve()); });
    await rm(root, { recursive: true, force: true });
  });
  provider.listen(0, "127.0.0.1");
  await once(provider, "listening");
  const address = provider.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;

  async function expectPhase<T>(operation: Promise<T>, description: string): Promise<T> {
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<never>((_, reject) => {
          deadline = setTimeout(() => reject(new Error(`${description}; provider calls: ${providerCalls.join(", ")}`)), 8_000);
        }),
      ]);
    } finally {
      clearTimeout(deadline);
    }
  }

  async function run(label: string) {
    const workspace = join(root, label);
    const config = join(workspace, ".codex");
    const rules = join(config, "rules");
    await mkdir(rules, { recursive: true });
    execFileSync("git", ["init", "--quiet", workspace]);
    await writeFile(join(config, "config.toml"), "# 临时审批测试工作区\n");
    await writeFile(join(rules, "fixture.rules"),
      'prefix_rule(pattern=[["/bin/echo", "echo"], "souflow_fixture"], decision="prompt")\n');

    const events: CodexAttemptEvent[] = [];
    let present!: (approval: Approval) => void;
    const request = new Promise<Approval>(resolve => { present = resolve; });
    const attempt = startCodexCommandAttempt({
      workspace,
      prompt: "Run the single synthetic fixture command.",
      command: [
        "codex",
        "-c", `model=${JSON.stringify(model)}`,
        "-c", 'model_provider="souflow_fixture"',
        "-c", `model_providers.souflow_fixture={name="Soulflow fixture",base_url="http://127.0.0.1:${port}/${label}/v1",requires_openai_auth=false,request_max_retries=0,stream_max_retries=0}`,
        "-c", `projects.${JSON.stringify(workspace)}.trust_level="trusted"`,
        "-c", 'web_search="disabled"',
        // 固定命令包装方式，让临时规则匹配同一个命令前缀。
        "--disable", "apps", "--disable", "plugins", "--disable", "shell_snapshot",
        "app-server", "--stdio",
      ],
      onEvent(event) {
        events.push(event);
        if (event.kind === "approval-requested") present(event.approval);
      },
    });
    attempts.push(attempt);
    return {
      attempt,
      events,
      workspace,
      // 调用方开始等待时才注册失败分支，避免还在准备另一工作区时产生未处理的拒绝。
      waitForApproval: () => expectPhase(Promise.race([
        request,
        attempt.finished.then(outcome => assert.fail(`${label} ended before requesting approval: ${outcome}`)),
      ]), `Waiting for ${label} to request approval`),
    };
  }

  const a = await run("ticket-a");
  const first = await a.waitForApproval();
  const b = await run("ticket-b");
  const second = await b.waitForApproval();
  assert.notEqual(first.id, second.id);
  for (const [ticket, approval] of [[a, first], [b, second]] as const) {
    assert.equal(approval.workspace, ticket.workspace);
    assert.match(approval.command, /echo souflow_fixture/);
    assert.deepEqual(approval.availableDecisions, ["accept", "cancel"]);
  }

  assert.equal(a.attempt.answer(second.id, "cancel"), false);
  assert.equal(b.attempt.answer(second.id, "decline"), false);
  assert.equal(b.attempt.answer(second.id, "cancel"), true);
  assert.equal(b.attempt.answer(second.id, "cancel"), false);
  assert.equal(await expectPhase(b.attempt.finished, "Waiting for ticket-b to stop"), "interrupted");
  assert.deepEqual(a.events.map(event => event.kind), ["approval-requested"]);
  assert.equal(a.attempt.answer(first.id, "cancel"), true);
  assert.equal(await expectPhase(a.attempt.finished, "Waiting for ticket-a to stop"), "interrupted");
  for (const { events } of [a, b]) {
    assert.deepEqual(events.map(event => event.kind), ["approval-requested", "approval-submitted", "approval-cleared"]);
  }

  const disconnected = await run("disconnected");
  const old = await disconnected.waitForApproval();
  disconnected.attempt.close();
  assert.equal(await disconnected.attempt.finished, "needs-reconciliation");
  assert.equal(disconnected.attempt.answer(old.id, "cancel"), false);
  assert.deepEqual(disconnected.events.map(event => event.kind), ["approval-requested", "approval-expired"]);
  assert.deepEqual(providerCalls.sort(), ["disconnected", "ticket-a", "ticket-b"]);
});
