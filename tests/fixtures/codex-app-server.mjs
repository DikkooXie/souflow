import { createInterface } from "node:readline";
import { basename } from "node:path";

const scenario = process.argv[2];
const expectedModel = process.argv[3];
let delayedAccount;
const threadId = basename(process.cwd());
const turnId = "turn-1";
const questionMode = scenario.startsWith("question-");
const question = {
  id: 1,
  method: "item/tool/requestUserInput",
  params: {
    threadId,
    turnId,
    itemId: "question-1",
    questions: [{
      id: "language", header: "语言", question: "用什么语言？",
      isSecret: scenario === "question-secret", isOther: scenario === "question-custom-length",
      options: [{ label: " TypeScript", description: "浏览器原型" }],
    }],
  },
};
const approval = {
  id: scenario === "foreign-notifications" ? "req-1" : 1,
  method: "item/commandExecution/requestApproval",
  params: {
    threadId,
    turnId,
    itemId: "command-1",
    command: "/bin/echo soulflow",
    cwd: process.cwd(),
    availableDecisions: ["accept", "decline"],
  },
};

function send(...messages) {
  process.stdout.write(`${messages.map(message => JSON.stringify(message)).join("\n")}\n`);
}

const input = createInterface({ input: process.stdin });
input.on("line", line => {
  const message = JSON.parse(line);
  switch (message.method) {
    case "initialize":
      if (scenario === "malformed") {
        process.stdout.write("not-json\n");
        return;
      }
      send({ id: message.id, result: {} });
      return;
    case "initialized":
      return;
    case "account/read": {
      if (message.params.refreshToken !== false) throw Error("观察账号不得刷新凭据。");
      if (scenario === "question-account-silent") return;
      if (scenario === "question-account-unsupported") {
        send({ id: message.id, error: { code: -32601 } });
        return;
      }
      const account = { type: scenario === "question-account-key" ? "apiKey" : "chatgpt", email: "private@example.invalid" };
      const userId = scenario === "question-account-missing" ? null : scenario === "question-account-other" ? "fixture-other" : "fixture-primary";
      const reply = { id: message.id, result: { account, userId } };
      if (scenario === "question-account-late") delayedAccount = reply;
      else send(reply);
      return;
    }
    case "config/read":
      if (scenario === "question-invalid-config") {
        send({ id: message.id, result: { config: { mcp_servers: [] } } });
      } else {
        send({ id: message.id, result: { config: { mcp_servers: { inherited: {} } } } });
      }
      return;
    case "thread/start":
      if (scenario !== "quality-result" && expectedModel && (message.params.model !== expectedModel || message.params.allowProviderModelFallback !== false)) {
        send({ id: message.id, error: { code: -32602 } });
        return;
      }
      if (questionMode && (scenario === "question-invalid-config" || message.params.approvalPolicy !== "never"
        || message.params.sandbox !== "read-only" || message.params.config?.mcp_servers?.inherited?.enabled !== false)) {
        send({ id: message.id, error: { code: -32602 } });
        return;
      }
      send({ id: message.id, result: { thread: { id: threadId }, model: scenario === "question-model-mismatch" ? "fixture" : message.params.model ?? "fixture" } });
      return;
    case "turn/start": {
      if (scenario === "long-code-result" || scenario === "quality-result") {
        const text = scenario === "quality-result" ? process.argv[3] : JSON.stringify({
          report: "代码替换", edits: [{ path: "src/demo.mts", before: "original", after: "x".repeat(18_000) }],
        });
        const item = { type: "agentMessage", phase: "final_answer", text };
        send({ id: message.id, result: { turn: { id: turnId } } },
          { method: "item/completed", params: { threadId, turnId, item } },
          { method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed" } } });
        return;
      }
      if (questionMode) {
        const request = structuredClone(scenario === "question-command" ? approval : question);
        if (scenario === "question-foreign-thread") request.params.threadId = "another-thread";
        if (scenario === "question-foreign-turn") request.params.turnId = "another-turn";
        send({ id: message.id, result: { turn: { id: turnId } } }, ...(delayedAccount ? [delayedAccount] : []), request);
        return;
      }
      const request = structuredClone(approval);
      if (scenario === "foreign-thread") request.params.threadId = "another-thread";
      if (scenario === "early-foreign-turn") request.params.turnId = "another-turn";
      if (scenario === "network") request.params.networkApprovalContext = { host: "example.test" };
      if (scenario === "terminal-input") request.params.kind = "writeStdin";
      if (scenario === "additional-permissions") request.params.additionalPermissions = {};
      if (scenario === "outside-workspace") request.params.cwd = "/outside-fixture";
      if (scenario === "unknown-type") request.method = "item/permissions/requestApproval";
      if (scenario === "cancel") request.params.availableDecisions = ["accept", "acceptForSession", "cancel"];
      if (scenario === "accept-only") request.params.availableDecisions = ["accept"];
      if (scenario === "legacy") delete request.params.availableDecisions;
      const started = { id: message.id, result: { turn: { id: turnId } } };
      if (scenario.startsWith("early-")) {
        send({ method: "turn/started", params: { threadId, turn: { id: request.params.turnId } } }, request, started);
      } else if (scenario === "conflicting-id") {
        const conflict = structuredClone(request);
        conflict.params.command = "/bin/echo different-command";
        send(started, request, conflict);
      } else if (scenario === "foreign-notifications") {
        send(
          started,
          request,
          { method: "serverRequest/resolved", params: { threadId: "foreign-thread", requestId: request.id } },
          { method: "turn/completed", params: { threadId, turn: { id: "foreign-turn", status: "completed" } } },
        );
      } else {
        send(started, request, request);
      }
      if (scenario === "expired") {
        send({ method: "serverRequest/resolved", params: { threadId, requestId: request.id } });
      }
      return;
    }
  }

  if (questionMode && message.id === question.id) {
    if (scenario === "question-lost-after-answer") process.exit(0);
    const denied = message.error?.code === -32601;
    const expected = scenario === "question-custom-length" ? "自".repeat(1200) : " TypeScript";
    const answered = message.result?.answers?.language?.answers?.[0] === expected;
    const status = (["question-valid", "question-output", "question-custom-length"].includes(scenario) ? answered : denied) ? "completed" : "failed";
    if (scenario === "question-output") {
      send(...["{\"result\":\"有效的中间产物\"}", "x".repeat(16_385)].map(text => ({
        method: "item/completed", params: { threadId, turnId, item: { type: "agentMessage", text } },
      })));
    }
    send(
      { method: "serverRequest/resolved", params: { threadId, requestId: question.id } },
      { method: "turn/completed", params: { threadId, turn: { id: turnId, status } } },
    );
    return;
  }

  if (message.id !== approval.id) return;
  if (scenario === "lost-after-answer") {
    process.exit(0);
  }
  const accepted = message.result?.decision === "accept";
  const declined = message.result?.decision === "decline";
  const cancelled = message.result?.decision === "cancel";
  const denied = message.error?.code === -32601;
  const passed = (["accept", "early-current-turn", "foreign-notifications"].includes(scenario) && accepted)
    || (["decline", "legacy"].includes(scenario) && declined)
    || (scenario === "cancel" && cancelled)
    || (["foreign-thread", "early-foreign-turn", "network", "terminal-input", "additional-permissions", "outside-workspace", "unknown-type", "accept-only"].includes(scenario) && denied);
  const status = passed && cancelled ? "interrupted" : passed ? "completed" : "failed";
  send(
    { method: "serverRequest/resolved", params: { threadId, requestId: message.id } },
    { method: "turn/completed", params: { threadId, turn: { id: turnId, status } } },
  );
});
