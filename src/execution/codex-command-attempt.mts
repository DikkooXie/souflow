import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { createInterface } from "node:readline";
import { isDeepStrictEqual } from "node:util";

type CommandDecision = "accept" | "decline" | "cancel";
type Outcome = "completed" | "failed" | "interrupted" | "needs-reconciliation";
type Approval = Readonly<{
  id: string;
  command: string;
  workspace: string;
  availableDecisions: readonly CommandDecision[];
}>;
type RequestId = number | string;
type PendingApproval = {
  id: string;
  params: Record<string, unknown>;
  availableDecisions: readonly CommandDecision[];
  submitted: boolean;
};

const defaultDecisions = Object.freeze<CommandDecision[]>(["accept", "decline"]);

export type CodexAttemptEvent =
  | { kind: "approval-requested"; approval: Approval }
  | { kind: "approval-submitted"; approvalId: string }
  | { kind: "approval-cleared"; approvalId: string }
  | { kind: "approval-expired"; approvalId: string }
  | { kind: "approval-uncertain"; approvalId: string };

type Options = {
  workspace: string;
  prompt: string;
  onEvent: (event: CodexAttemptEvent) => void;
  command?: readonly [executable: string, ...args: string[]];
};

function record(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
}

function isRequestId(value: unknown): value is RequestId {
  return typeof value === "string" || (typeof value === "number" && Number.isSafeInteger(value));
}

function isCommandDecision(value: unknown): value is CommandDecision {
  return value === "accept" || value === "decline" || value === "cancel";
}

function readAvailableDecisions(value: unknown): readonly CommandDecision[] | undefined {
  if (value == null) return defaultDecisions;
  if (!Array.isArray(value)) return undefined;
  const decisions = new Set(value.filter(isCommandDecision));
  if (decisions.has("accept") && (decisions.has("decline") || decisions.has("cancel"))) {
    return Object.freeze([...decisions]);
  }
}

export function startCodexCommandAttempt(options: Options) {
  const workspace = realpathSync(options.workspace);
  const [executable, ...args] = options.command ?? ["codex", "app-server", "--listen", "stdio://"];
  const child = spawn(executable, args, { cwd: workspace, stdio: ["pipe", "pipe", "ignore"] });
  const input = createInterface({ input: child.stdout });
  let threadId: string | undefined;
  let turnId: string | undefined;
  let startingTurn = false;
  let closed = false;
  let callId = 0;
  let pendingCall: { id: number; receive: (result: Record<string, unknown>) => void } | undefined;
  const earlyMessages: { method: string; id: RequestId | undefined; params: Record<string, unknown> }[] = [];
  let complete!: (outcome: Outcome) => void;
  const finished = new Promise<Outcome>(resolve => { complete = resolve; });
  const serverRequests = new Map<RequestId, PendingApproval | null>();
  const answerable = new Map<string, RequestId>();
  const startupDeadline = setTimeout(connectionLost, 15_000);

  function send(message: Record<string, unknown>) {
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  function call(
    method: string,
    params: Record<string, unknown>,
    receive: (result: Record<string, unknown>) => void,
  ) {
    const id = ++callId;
    pendingCall = { id, receive };
    send({ id, method, params });
  }

  function finish(outcome: Outcome) {
    if (closed) return;
    closed = true;
    clearTimeout(startupDeadline);
    pendingCall = undefined;
    answerable.clear();
    earlyMessages.length = 0;
    child.stdin.destroy();
    input.close();
    child.kill();
    for (const approval of serverRequests.values()) {
      if (approval === null) continue;
      publish({
        kind: approval.submitted ? "approval-uncertain" : "approval-expired",
        approvalId: approval.id,
      });
    }
    serverRequests.clear();
    complete(outcome);
  }

  function connectionLost() {
    finish(startingTurn ? "needs-reconciliation" : "failed");
  }

  function publish(event: CodexAttemptEvent) {
    try {
      options.onEvent(event);
    } catch {
      // 消费方无法记录决策时关停连接，已发出的答复仍需核对。
      connectionLost();
    }
  }

  function handleRequest(id: RequestId, method: string, params: Record<string, unknown>) {
    const previous = serverRequests.get(id);
    if (previous !== undefined) {
      if (previous && (method !== "item/commandExecution/requestApproval" || !isDeepStrictEqual(params, previous.params))) {
        connectionLost();
      }
      return;
    }
    const { command, cwd } = params;
    const availableDecisions = readAvailableDecisions(params.availableDecisions);
    if (method !== "item/commandExecution/requestApproval"
      || (params.kind !== undefined && params.kind !== "command")
      || !turnId || params.threadId !== threadId || params.turnId !== turnId
      || typeof params.itemId !== "string"
      || typeof command !== "string" || !command.trim() || cwd !== workspace
      || params.networkApprovalContext != null || params.additionalPermissions != null
      || !availableDecisions) {
      serverRequests.set(id, null);
      send({ id, error: { code: -32601, message: "Unsupported approval request" } });
      return;
    }
    const approvalId = randomUUID();
    serverRequests.set(id, { id: approvalId, params, availableDecisions, submitted: false });
    answerable.set(approvalId, id);
    publish({ kind: "approval-requested", approval: { id: approvalId, command, workspace, availableDecisions } });
  }

  function handleNotification(method: string, params: Record<string, unknown>) {
    if (!threadId || params.threadId !== threadId) return;
    const turn = record(params.turn);
    if (method === "serverRequest/resolved" && isRequestId(params.requestId)) {
      const approval = serverRequests.get(params.requestId);
      if (!approval) return;
      serverRequests.set(params.requestId, null);
      answerable.delete(approval.id);
      // 服务端清理请求时也发此通知，命令结果须由执行事件另行证明。
      publish({
        kind: approval.submitted ? "approval-cleared" : "approval-expired",
        approvalId: approval.id,
      });
    }
    if (method === "turn/completed" && turnId && turn?.id === turnId) {
      const status = turn.status;
      if (status === "completed" || status === "failed" || status === "interrupted") finish(status);
      else connectionLost();
    }
  }

  function handleMethod(method: string, id: RequestId | undefined, params: Record<string, unknown>) {
    if (closed) return;
    // 轮次归属由匹配的 turn/start 回执确认。先到的通知不能建立审批路由。
    if (startingTurn && !turnId) {
      if (earlyMessages.length === 64) return connectionLost();
      earlyMessages.push({ method, id, params });
      return;
    }
    if (id === undefined) handleNotification(method, params);
    else handleRequest(id, method, params);
  }

  function handleLine(line: string) {
    if (closed) return;
    let message: Record<string, unknown> | undefined;
    try {
      message = record(JSON.parse(line));
    } catch {
      connectionLost();
      return;
    }
    if (!message) {
      connectionLost();
      return;
    }
    if (typeof message.method === "string") {
      const params = record(message.params) ?? {};
      if (message.id === undefined || isRequestId(message.id)) {
        handleMethod(message.method, message.id, params);
      }
      return;
    }
    if (pendingCall && message.id === pendingCall.id) {
      const { receive } = pendingCall;
      pendingCall = undefined;
      const result = record(message.result);
      if (result && message.error === undefined) receive(result);
      else connectionLost();
    }
  }

  child.on("error", connectionLost);
  child.stdin.on("error", connectionLost);
  input.on("error", connectionLost);
  input.on("close", connectionLost);
  input.on("line", handleLine);

  call("initialize", {
    clientInfo: { name: "soulflow", version: "0.1.0" },
    // 收到完整的权限字段，才能拒绝超出当前适配范围的命令。
    capabilities: { experimentalApi: true },
  }, () => {
    send({ method: "initialized" });
    call("thread/start", {
      cwd: workspace,
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandbox: "workspace-write",
      ephemeral: true,
    }, result => {
      const thread = record(result.thread);
      if (typeof thread?.id !== "string" || !thread.id) return connectionLost();
      threadId = thread.id;
      startingTurn = true;
      call("turn/start", { threadId, input: [{ type: "text", text: options.prompt }] }, result => {
        const turn = record(result.turn);
        if (typeof turn?.id !== "string" || !turn.id) {
          return connectionLost();
        }
        turnId = turn.id;
        clearTimeout(startupDeadline);
        for (const message of earlyMessages.splice(0)) handleMethod(message.method, message.id, message.params);
      });
    });
  });

  return {
    finished,
    close: connectionLost,
    answer(approvalId: string, decision: CommandDecision): boolean {
      if (closed || !isCommandDecision(decision)) return false;
      const id = answerable.get(approvalId);
      if (id === undefined) return false;
      const approval = serverRequests.get(id);
      // 取消会结束本轮，必须由操作者明确选择。
      if (!approval?.availableDecisions.includes(decision)) return false;
      answerable.delete(approvalId);
      approval.submitted = true;
      send({ id, result: { decision } });
      publish({ kind: "approval-submitted", approvalId });
      return true;
    },
  };
}
