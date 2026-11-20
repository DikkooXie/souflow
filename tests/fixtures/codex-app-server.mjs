import { createInterface } from "node:readline";
import { basename } from "node:path";

const scenario = process.argv[2];
const threadId = basename(process.cwd());
const turnId = "turn-1";
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
    case "thread/start":
      send({ id: message.id, result: { thread: { id: threadId } } });
      return;
    case "turn/start": {
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
