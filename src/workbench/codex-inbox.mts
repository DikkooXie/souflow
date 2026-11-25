import { randomUUID } from "node:crypto";
import { auditDecisionAnswers, type BusinessEvent, type Checkpoint, type RecordBusiness, scrubAuditText } from "../audit/activity-store.mts";
import { readDecisionAnswers } from "../decisions/questions.mts";
import { startCodexQuestionAttempt, type CodexAttemptEvent } from "../execution/codex-command-attempt.mts";
import type { DispatchMonitor } from "../execution/dispatch-monitor.mts";
import { frozenPlanningInput } from "../execution/frozen-planning-sources.mts";
import { clarificationOrigin, type Flow, makePhasePrompt, type Phase, type PhaseTarget, readPhaseOutput } from "../planning/conversation-flow.mts";
import type { DecisionCard } from "./demo-state.mts";

type Attempt = ReturnType<typeof startCodexQuestionAttempt>;
type Start = typeof startCodexQuestionAttempt;
const at = (label: string) => ({ label, at: new Date().toISOString() });
const terminal = {
  "question-cleared": { status: "closed", label: "原提问已关闭" },
  "question-expired": { status: "expired", label: "待答问题已失效" },
  "question-uncertain": { status: "uncertain", label: "答复回执待核对" },
} as const;

export function createCodexInbox(workspace: string, options: {
  limit: number;
  answerMaxLength: number;
  startAttempt?: Start | undefined;
  record?: RecordBusiness;
  monitor?: DispatchMonitor;
  store?: Checkpoint<DecisionCard>;
}) {
  const { limit, answerMaxLength, startAttempt = startCodexQuestionAttempt, record, monitor, store } = options;
  const requests = store?.load() ?? [];
  const routes = new Map<string, Attempt>();
  const active = new Set<Attempt>();
  let sequence = 0;
  let lastMessage = "";
  let closed = false;
  const canBegin = () => !closed && active.size < limit;

  function save(request: DecisionCard, event: BusinessEvent) {
    if (store) return store.save(request.id, {
        ...request, title: scrubAuditText(request.title), prompt: scrubAuditText(request.prompt),
        questions: request.questions.map(question => ({ ...question, title: scrubAuditText(question.title),
          prompt: scrubAuditText(question.prompt), options: question.options.map(option => ({
            label: scrubAuditText(option.label), description: scrubAuditText(option.description),
          })) })),
      }, event);
    record?.(event);
    return true;
  }

  function transition(request: DecisionCard, status: DecisionCard["status"], label: string) {
    const updated = { ...request, status, timeline: [...request.timeline, at(label)] };
    const saved = save(updated, { kind: "decision.updated", flowId: request.flowId, attemptId: request.attemptId,
      subject: request.id, details: { status } });
    // 连接已不存在时，即使存储失败，也在内存中禁止继续投递。
    Object.assign(request, updated);
    return saved;
  }

  for (const request of requests) {
    if (request.status !== "pending" && request.status !== "submitted") continue;
    const update = request.status === "pending" ? terminal["question-expired"] : terminal["question-uncertain"];
    if (!transition(request, update.status, `工作台重启 · ${update.label}`)) throw Error("无法恢复决策历史。");
  }

  function begin(prompt: string, step?: { flow: Flow; phase: Phase; targets: readonly PhaseTarget[];
    sourceInput?: string;
    complete: (output: string | undefined, interrupted: boolean) => void }): 200 | 409 | 503 {
    if (!canBegin()) return 409;
    const attemptId = randomUUID();
    const flowId = step?.flow.id;
    const trace = { attemptId, flowId };
    const session = `Codex · 会话 ${++sequence}`;
    const title = [...prompt.split("\n")[0] ?? prompt].slice(0, 40).join("");
    const monitored = monitor?.begin({ title: step?.flow.title ?? title, task: step?.phase.title ?? "直接澄清", flowId });
    let asked = false;
    let unanswered = false;
    let attempt: Attempt;
    const onEvent = (event: CodexAttemptEvent) => {
      if (!("requestId" in event) || !active.has(attempt)) return;
      if (event.kind === "question-requested") {
        const origin = step && clarificationOrigin(step.flow, step.phase, step.targets);
        const request: DecisionCard = {
          id: event.requestId, session: step?.phase.title ?? session, title: step?.flow.title ?? title,
          prompt: step?.flow.prompt ?? scrubAuditText(prompt), questions: event.questions,
          ...(step ? { flowId: step.flow.id } : {}),
          ...(origin ? { clarificationOrigin: origin } : {}),
          attemptId,
          status: "pending", timeline: [at("Codex 已发出提问")],
        };
        if (!save(request, { kind: "decision.opened", ...trace, subject: event.requestId,
          details: { phase: step?.phase.title, count: event.questions.length, ...(origin ? { origin } : {}) } })) {
          unanswered = true;
          attempt.close();
          return;
        }
        monitored?.waiting(true);
        asked = true;
        routes.set(event.requestId, attempt);
        requests.push(request);
        return;
      }
      if (event.kind === "question-submitted") return;
      const request = requests.find(card => card.id === event.requestId);
      if (!request || routes.get(request.id) !== attempt) return;
      if (event.kind === "question-expired" || event.kind === "question-uncertain") unanswered = true;
      const update = terminal[event.kind];
      if (!transition(request, update.status, update.label)) unanswered = true;
      routes.delete(request.id);
      monitored?.waiting([...routes.values()].includes(attempt));
    };
    try {
      const fields = step?.phase.fields;
      attempt = startAttempt({ workspace, prompt, onEvent, answerMaxLength,
        ...(step?.flow.project ? { disableWebSearch: true } : {}),
        ...(step?.sourceInput ? { untrustedContext: step.sourceInput } : {}),
        ...(monitored ? { onThread: monitored.connected, onAccount: monitored.account } : {}),
        onModel: model => {
          monitored?.model(model);
          record?.({ kind: "model.started", ...trace, details: { model, phase: step?.phase.title } });
        },
        ...(fields ? { outputSchema: {
        type: "object", additionalProperties: false, required: fields,
        properties: Object.fromEntries(fields.map(key => [key, { type: "string" }])),
      } } : {}) });
    } catch {
      monitored?.finish("failed");
      return 503;
    }
    if (!step) record?.({ kind: "request.submitted", ...trace, details: { text: prompt } });
    record?.({ kind: "attempt.started", ...trace, details: { phase: step?.phase.title } });
    active.add(attempt);
    lastMessage = "";
    void attempt.finished.then(outcome => {
      monitored?.finish(outcome);
      active.delete(attempt);
      record?.({ kind: "attempt.finished", ...trace, details: { outcome } });
      if (step) step.complete(outcome === "completed" && !unanswered ? attempt.output() : undefined,
        unanswered || outcome === "needs-reconciliation" || outcome === "interrupted" || closed);
      else if (outcome !== "completed") lastMessage = `${session} 已结束，状态需核对。`;
      else if (!asked) lastMessage = `${session} 本轮未发出结构化提问。`;
    });
    return 200;
  }

  return {
    snapshot: () => ({ requests, mode: "codex" as const, active: active.size, lastMessage }),
    begin,
    canBegin,
    async runPhase(flow: Flow, phase: Phase, targets: readonly PhaseTarget[], planText?: string) {
      const sourceInput = await frozenPlanningInput(workspace, flow.project);
      return new Promise<string[] | "interrupted" | undefined>(resolve => {
        const status = begin(makePhasePrompt(flow, phase, targets, planText), {
          flow, phase, targets, ...(sourceInput ? { sourceInput } : {}),
          complete: (output, interrupted) => resolve(interrupted ? "interrupted" : readPhaseOutput(phase, output)),
        });
        if (status !== 200) resolve(status === 409 ? "interrupted" : undefined);
      });
    },
    submit(id: string, input: unknown): 200 | 404 | 409 | 422 | 503 {
      const request = requests.find(card => card.id === id);
      if (!request) return 404;
      const attempt = routes.get(id);
      if (!attempt || request.status !== "pending") return 409;
      const answers = readDecisionAnswers(request.questions, input, answerMaxLength);
      if (!answers) return 422;
      const recordedAnswers = Object.fromEntries(Object.entries(auditDecisionAnswers(request.questions, answers))
        .flatMap(([key, value]) => value === undefined ? [] : [[key, scrubAuditText(value)]]));
      const updated: DecisionCard = { ...request, status: "submitted", answers: recordedAnswers,
        timeline: [...request.timeline, at("已提交回答")] };
      // 先持久化答复意图。若进程在投递与确认之间退出，重启只显示待核对。
      if (!save(updated, { kind: "decision.answered", flowId: request.flowId, attemptId: request.attemptId,
        subject: id, details: { answers: recordedAnswers, ...(request.clarificationOrigin ? { origin: request.clarificationOrigin } : {}) } })) return 503;
      Object.assign(request, updated);
      if (!attempt.answerQuestions(id, answers)) {
        transition(request, "uncertain", "原会话已不可答复");
        routes.delete(id);
        attempt.close();
        return 409;
      }
      return 200;
    },
    close() {
      closed = true;
      const attempts = [...active];
      for (const attempt of attempts) attempt.close();
      return Promise.allSettled(attempts.map(attempt => attempt.finished));
    },
  };
}
