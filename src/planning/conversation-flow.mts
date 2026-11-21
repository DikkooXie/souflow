import { randomUUID } from "node:crypto";

export const phases = [
  { title: "调研", fields: ["场景与已有依据", "待核实事项"], instruction: "归纳可核实的现状、用户场景和相关方案。说明证据来源，缺少依据的事项明确列为待核实。" },
  { title: "需求澄清", fields: ["目标与范围", "验收条件"], instruction: "判断还有哪些产品决定会实质影响范围或验收；有必要时使用 request_user_input 收集答案。形成包含使用者、场景、范围和编号验收条件的结构化需求。" },
  { title: "技术选型", fields: ["推荐方案", "依据与取舍"], instruction: "比较满足需求的技术方案与约束。影响交付的重大选择使用 request_user_input 确认；保留必要的假设。" },
  { title: "开发文档", fields: ["PRD", "开发计划"], instruction: "分别生成可审阅的 PRD 和开发计划。计划须引用需求中的验收条件，体现实现顺序和验证方法。" },
  { title: "拆单", fields: ["建议工单", "依赖与验证"], instruction: "根据开发计划起草独立可验证的工单，列出对应验收条件、依赖和验证方式。保持为待审阅的草稿。" },
] as const;

export type Phase = (typeof phases)[number];
export type Flow = {
  id: string;
  prompt: string;
  title: string;
  status: "running" | "ready" | "failed";
  outputs: { title: string; sections: { title: string; text: string }[] }[];
};

type RunPhase = (flow: Flow, phase: Phase) => Promise<readonly string[] | undefined>;

export function createConversationFlows(runPhase: RunPhase, limit: number) {
  const flows: Flow[] = [];

  async function run(flow: Flow) {
    try {
      for (const phase of phases) {
        const result = await runPhase(flow, phase);
        if (!flows.includes(flow)) return;
        if (!result || result.length !== phase.fields.length || result.some(text => !text.trim())) {
          flow.status = "failed";
          return;
        }
        flow.outputs.push({ title: phase.title, sections: phase.fields.map((title, index) => ({ title, text: result[index] ?? "" })) });
      }
      flow.status = "ready";
    } catch {
      flow.status = "failed";
    }
  }

  return {
    list: () => flows,
    begin(prompt: string) {
      if (flows.filter(flow => flow.status === "running").length >= limit) return;
      const flow: Flow = {
        id: randomUUID(), prompt, title: [...(prompt.split("\n")[0] ?? prompt)].slice(0, 32).join(""),
        status: "running", outputs: [],
      };
      flows.push(flow);
      void run(flow);
      return flow;
    },
    reset() { flows.length = 0; },
  };
}

export function makePhasePrompt(flow: Flow, phase: Phase) {
  return [
    `你正在为 Soulflow 完成单个规划阶段「${phase.title}」。${phase.instruction}`,
    "只完成当前阶段；不修改文件，不派单或发布。上一阶段的产物是待核实的上下文。",
    `原始需求：${flow.prompt}`,
    `已有产物：${JSON.stringify(flow.outputs)}`,
    `最终只返回 JSON 对象，键为 ${JSON.stringify(phase.fields)}，每个值都是非空字符串。`,
  ].join("\n\n");
}

export function readPhaseOutput(phase: Phase, text: string | undefined) {
  if (!text) return;
  try {
    const result: unknown = JSON.parse(text.trim().replace(/^```(?:json)?\s+|\s+```$/g, ""));
    if (!result || typeof result !== "object" || Array.isArray(result)) return;
    const values = phase.fields.map(key => Object.hasOwn(result, key) ? (result as Record<string, unknown>)[key] : undefined);
    if (values.every(value => typeof value === "string" && value.trim() && value.length <= 6000)) return values as string[];
  } catch {
    return;
  }
}
