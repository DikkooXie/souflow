import { randomUUID } from "node:crypto";
import { auditDecisionAnswers, type RecordBusiness } from "../audit/activity-store.mts";
import { type DecisionQuestion, readDecisionAnswers } from "../decisions/questions.mts";
import type { Flow, Phase } from "../planning/conversation-flow.mts";

export type Status = "pending" | "submitted" | "acknowledged" | "closed" | "expired" | "uncertain";
export type DecisionCard = {
  id: string;
  kind?: "code-review" | "github-authorization";
  session: string;
  title: string;
  flowId?: string;
  attemptId?: string;
  prompt: string;
  questions: readonly DecisionQuestion[];
  status: Status;
  answers?: Record<string, string>;
  timeline: { label: string; at: string }[];
};

const examples = [
  {
    session: "会话 A",
    title: "开发一个小游戏",
    prompt: "我要写一个游戏。",
    questions: [
      {
        id: "language", title: "开发语言", prompt: "你希望用什么语言来写这个游戏？", allowCustom: true,
        options: [
          { label: "TypeScript", description: "适合快速做一个浏览器游戏" },
          { label: "Python", description: "适合做一个便于学习的桌面原型" },
          { label: "C#", description: "适合配合 Unity 制作游戏" },
        ],
      },
      {
        id: "genre", title: "游戏类型", prompt: "你想做什么类型的游戏？", allowCustom: true,
        options: [
          { label: "解谜", description: "围绕关卡和规则设计" },
          { label: "平台跳跃", description: "围绕移动、跳跃和地图设计" },
          { label: "生存冒险", description: "围绕探索和资源管理设计" },
        ],
      },
    ],
  },
  {
    session: "会话 B",
    title: "为工单列表添加导出",
    prompt: "我想把工单导出给同事看。",
    questions: [
      {
        id: "scope", title: "导出范围", prompt: "导出哪些工单？", allowCustom: false,
        options: [
          { label: "当前筛选结果", description: "保留页面筛选条件" },
          { label: "当前项目可见的全部工单", description: "包含当前成员可以访问的工单" },
        ],
      },
    ],
  },
] satisfies Omit<DecisionCard, "id" | "status" | "timeline" | "answers">[];

const event = (label: string) => ({ label, at: new Date().toISOString() });

export function createDecisionDemo(receiptDelay = 650, record?: RecordBusiness, answerMaxLength?: number) {
  let requests = seed();
  const waiting = new Map<string, (answer: string | undefined) => void>();
  let closed = false;

  function seed(): DecisionCard[] {
    return examples.map(example => ({
      ...example, id: randomUUID(), status: "pending", timeline: [event("Codex 已发出提问")],
    }));
  }

  function disconnect(id: string): 200 | 404 | 409 {
    const request = requests.find(entry => entry.id === id);
    if (!request) return 404;
    if (request.status !== "pending" && request.status !== "submitted") return 409;
    request.status = request.status === "pending" ? "expired" : "uncertain";
    request.timeline.push(event("会话连接已断开"),
      event(request.status === "expired" ? "待答问题已失效" : "答复回执待核对"));
    record?.({ kind: "decision.updated", flowId: request.flowId, subject: id, details: { status: request.status } });
    waiting.get(id)?.(undefined);
    waiting.delete(id);
    return 200;
  }

  function settlePending() {
    for (const request of requests) if (request.flowId || request.status === "submitted") disconnect(request.id);
  }

  return {
    snapshot: () => ({ requests, mode: "demo" as const }),
    reset() {
      settlePending();
      requests = seed();
    },
    close() {
      closed = true;
      settlePending();
    },
    async runPhase(flow: Flow, phase: Phase) {
      if (closed) return;
      switch (phase.title) {
        case "调研": return ["梳理目标人群、主要使用场景、已有实现和可复用方案。", "本地演示使用样例，外部资料和项目现状需要实际调研。"];
        case "需求澄清": {
          const answer = await new Promise<string | undefined>(resolve => {
            const id = randomUUID();
            waiting.set(id, resolve);
            requests.push({
              id, session: phase.title, title: flow.title, prompt: flow.prompt, flowId: flow.id,
              status: "pending", timeline: [event("已发出范围澄清")], questions: [{
                id: "scope", title: "本轮交付范围", prompt: "首版优先做到哪一步？", allowCustom: true,
                options: [
                  { label: "最小可演示原型", description: "优先走通一个核心场景" },
                  { label: "完整的核心流程", description: "覆盖核心场景及主要失败路径" },
                ],
              }],
            });
            record?.({ kind: "decision.opened", flowId: flow.id, subject: id, details: { phase: phase.title, count: 1 } });
          });
          if (answer) return [`原始需求：${flow.prompt}\n首版范围：${answer}`, "AC-1 · 可以完成首版核心场景。\nAC-2 · 可以观察结果和主要失败状态。"];
          return;
        }
        case "技术选型": return ["优先复用现有技术栈和项目约定。", "依据已确认范围，先核对接入、维护与验收成本。"];
        case "开发文档": {
          const requirements = flow.outputs.flatMap(output => output.artifacts).find(artifact => artifact.kind === "requirements");
          return [requirements?.sections.map(section => section.text).join("\n\n") ?? "", "先实现核心路径（AC-1），再验证结果和失败状态（AC-2）。"];
        }
        case "拆单": return ["T1 · 实现核心路径（AC-1）\nT2 · 补齐失败反馈与验收（AC-2）", "T2 依赖 T1。逐条执行验收条件，记录实际结果。"];
      }
    },
    submit(id: string, input: unknown): 200 | 404 | 409 | 422 {
      const request = requests.find(entry => entry.id === id);
      if (!request) return 404;
      if (request.status !== "pending") return 409;
      const answers = readDecisionAnswers(request.questions, input, answerMaxLength);
      if (!answers) return 422;
      request.status = "submitted";
      request.answers = answers;
      request.timeline.push(event("已提交回答"));
      record?.({ kind: "decision.answered", flowId: request.flowId, subject: id, details: { answers: auditDecisionAnswers(request.questions, answers) } });
      setTimeout(() => {
        if (!requests.includes(request) || request.status !== "submitted") return;
        request.status = "acknowledged";
        request.timeline.push(event("原会话已收到回答"));
        record?.({ kind: "decision.updated", flowId: request.flowId, subject: id, details: { status: request.status } });
        waiting.get(id)?.(answers.scope);
        waiting.delete(id);
      }, receiptDelay).unref();
      return 200;
    },
    disconnect,
  };
}
