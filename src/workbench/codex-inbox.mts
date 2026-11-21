import { randomUUID } from "node:crypto";
import { auditDecisionAnswers, type RecordBusiness } from "../audit/activity-store.mts";
import { readDecisionAnswers } from "../decisions/questions.mts";
import { startCodexQuestionAttempt, type CodexAttemptEvent } from "../execution/codex-command-attempt.mts";
import { type Flow, makePhasePrompt, type Phase, type PhaseTarget, readPhaseOutput } from "../planning/conversation-flow.mts";
import type { DecisionCard } from "./demo-state.mts";

type Attempt = ReturnType<typeof startCodexQuestionAttempt>;
type Start = typeof startCodexQuestionAttempt;
const at = (label: string) => ({ label, at: new Date().toISOString() });
const terminal = {
  "question-cleared": { status: "closed", label: "原提问已关闭" },
  "question-expired": { status: "expired", label: "待答问题已失效" },
  "question-uncertain": { status: "uncertain", label: "答复回执待核对" },
} as const;

export function createCodexInbox(workspace: string, limit: number, startAttempt: Start = startCodexQuestionAttempt, record?: RecordBusiness) {
  const requests: DecisionCard[] = [];
  const routes = new Map<string, Attempt>();
  const active = new Set<Attempt>();
  let sequence = 0;
  let lastMessage = "";
  let closed = false;
  const canBegin = () => !closed && active.size < limit;

  function begin(prompt: string, step?: { flow: Flow; phase: Phase; complete: (output: string | undefined) => void }): 200 | 409 | 503 {
    if (!canBegin()) return 409;
    const attemptId = randomUUID();
    const flowId = step?.flow.id;
    const trace = { attemptId, flowId };
    const session = `Codex · 会话 ${++sequence}`;
    const title = [...prompt.split("\n")[0] ?? prompt].slice(0, 40).join("");
    let asked = false;
    let unanswered = false;
    let attempt: Attempt;
    const onEvent = (event: CodexAttemptEvent) => {
      if (!("requestId" in event) || !active.has(attempt)) return;
      if (event.kind === "question-requested") {
        asked = true;
        routes.set(event.requestId, attempt);
        requests.push({
          id: event.requestId, session: step?.phase.title ?? session, title: step?.flow.title ?? title,
          prompt: step?.flow.prompt ?? prompt, questions: event.questions,
          ...(step ? { flowId: step.flow.id } : {}),
          attemptId,
          status: "pending", timeline: [at("Codex 已发出提问")],
        });
        record?.({ kind: "decision.opened", ...trace, subject: event.requestId,
          details: { phase: step?.phase.title, count: event.questions.length } });
        return;
      }
      if (event.kind === "question-submitted") return;
      const request = requests.find(card => card.id === event.requestId);
      if (!request || routes.get(request.id) !== attempt) return;
      if (event.kind === "question-expired" || event.kind === "question-uncertain") unanswered = true;
      const update = terminal[event.kind];
      request.status = update.status;
      request.timeline.push(at(update.label));
      record?.({ kind: "decision.updated", ...trace, subject: request.id, details: { status: update.status } });
      routes.delete(request.id);
    };
    try {
      const fields = step?.phase.fields;
      attempt = startAttempt({ workspace, prompt, onEvent,
        onModel: model => record?.({ kind: "model.started", ...trace, details: { model, phase: step?.phase.title } }),
        ...(fields ? { outputSchema: {
        type: "object", additionalProperties: false, required: fields,
        properties: Object.fromEntries(fields.map(key => [key, { type: "string" }])),
      } } : {}) });
    } catch {
      return 503;
    }
    if (!step) record?.({ kind: "request.submitted", ...trace, details: { text: prompt } });
    record?.({ kind: "attempt.started", ...trace, details: { phase: step?.phase.title } });
    active.add(attempt);
    lastMessage = "";
    void attempt.finished.then(outcome => {
      active.delete(attempt);
      record?.({ kind: "attempt.finished", ...trace, details: { outcome } });
      if (step) step.complete(outcome === "completed" && !unanswered ? attempt.output() : undefined);
      else if (outcome !== "completed") lastMessage = `${session} 已结束，状态需核对。`;
      else if (!asked) lastMessage = `${session} 本轮未发出结构化提问。`;
    });
    return 200;
  }

  return {
    snapshot: () => ({ requests, mode: "codex" as const, active: active.size, lastMessage }),
    begin,
    canBegin,
    runPhase(flow: Flow, phase: Phase, targets: readonly PhaseTarget[]) {
      return new Promise<string[] | undefined>(resolve => {
        const status = begin(makePhasePrompt(flow, phase, targets), {
          flow, phase, complete: output => resolve(readPhaseOutput(phase, output)),
        });
        if (status !== 200) resolve(undefined);
      });
    },
    submit(id: string, input: unknown): 200 | 404 | 409 | 422 {
      const request = requests.find(card => card.id === id);
      if (!request) return 404;
      const attempt = routes.get(id);
      if (!attempt || request.status !== "pending") return 409;
      const answers = readDecisionAnswers(request.questions, input);
      if (!answers) return 422;
      if (!attempt.answerQuestions(id, answers)) return 409;
      request.status = "submitted";
      request.answers = answers;
      request.timeline.push(at("已提交回答"));
      record?.({ kind: "decision.answered", flowId: request.flowId, attemptId: request.attemptId,
        subject: id, details: { answers: auditDecisionAnswers(request.questions, answers) } });
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
