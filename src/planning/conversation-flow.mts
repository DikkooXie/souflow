import { randomUUID } from "node:crypto";
import type { RecordBusiness } from "../audit/activity-store.mts";

const definitions = {
  research: { fields: ["场景与已有依据", "待核实事项"], upstream: ["request"] },
  requirements: { fields: ["目标与范围", "验收条件"], upstream: ["research"] },
  technology: { fields: ["推荐方案", "依据与取舍"], upstream: ["requirements"] },
  prd: { fields: ["PRD"], upstream: ["requirements"] },
  "development-plan": { fields: ["开发计划"], upstream: ["prd", "technology"] },
  "ticket-drafts": { fields: ["建议工单", "依赖与验证"], upstream: ["development-plan"] },
} as const;

const steps = [
  { title: "调研", artifacts: ["research"], instruction: "归纳可核实的现状、用户场景和相关方案。说明证据来源，缺少依据的事项明确列为待核实。" },
  { title: "需求澄清", artifacts: ["requirements"], instruction: "判断还有哪些产品决定会实质影响范围或验收；有必要时使用 request_user_input 收集答案。形成包含使用者、场景、范围和编号验收条件的结构化需求。" },
  { title: "技术选型", artifacts: ["technology"], instruction: "比较满足需求的技术方案与约束。影响交付的重大选择使用 request_user_input 确认；保留必要的假设。" },
  { title: "开发文档", artifacts: ["prd", "development-plan"], instruction: "分别生成可审阅的 PRD 和开发计划。开发计划基于本阶段生成的 PRD 和已记录的技术选型，引用需求验收条件并说明实现顺序和验证方法。" },
  { title: "拆单", artifacts: ["ticket-drafts"], instruction: "根据开发计划起草独立可验证的工单，列出对应验收条件、依赖和验证方式。保持为待审阅的草稿。" },
] as const;

export const phases = steps.map(step => ({
  ...step, fields: step.artifacts.flatMap<string>(kind => definitions[kind].fields),
}));

type DraftKind = keyof typeof definitions;
type ArtifactKind = "request" | DraftKind;
type ArtifactVersion = Readonly<{ id: string; version: number }>;
type ArtifactTrace<K extends ArtifactKind = ArtifactKind> = ArtifactVersion & Readonly<{
  kind: K;
  upstream: readonly ArtifactVersion[];
}>;
export type PhaseTarget = ArtifactTrace<DraftKind>;
type Section = { title: string; text: string };
type Artifact = PhaseTarget & { sections: readonly Section[] };

export type Phase = (typeof phases)[number];
export type Flow = {
  id: string;
  prompt: string;
  title: string;
  source: ArtifactTrace<"request">;
  status: "running" | "ready" | "failed";
  outputs: { title: string; artifacts: readonly Artifact[] }[];
};

type RunPhase = (flow: Flow, phase: Phase, targets: readonly PhaseTarget[]) => Promise<readonly string[] | undefined>;

function nextTargets(flow: Flow, phase: Phase): PhaseTarget[] {
  const versions = new Map<ArtifactKind, ArtifactVersion>([[flow.source.kind, flow.source]]);
  for (const { artifacts } of flow.outputs) {
    for (const artifact of artifacts) versions.set(artifact.kind, artifact);
  }
  return phase.artifacts.map(kind => {
    // 同阶段的开发计划引用本阶段待生成的 PRD。阶段成功后一次性记录两份产物。
    const upstream = definitions[kind].upstream.map(source => {
      const artifact = versions.get(source);
      if (!artifact) throw new Error(`Missing upstream artifact: ${source}`);
      return { id: artifact.id, version: artifact.version };
    });
    const target = { kind, id: `${flow.id}/${kind}`, version: 1, upstream };
    versions.set(kind, target);
    return target;
  });
}

export function createConversationFlows(runPhase: RunPhase, limit: number, record?: RecordBusiness) {
  const flows: Flow[] = [];
  const running = new Set<Promise<void>>();

  async function run(flow: Flow) {
    let phaseTitle: string | undefined;
    try {
      for (const phase of phases) {
        phaseTitle = phase.title;
        const targets = nextTargets(flow, phase);
        record?.({ kind: "phase.started", flowId: flow.id, subject: phase.title });
        const result = await runPhase(flow, phase, targets);
        if (!flows.includes(flow)) return;
        if (!result || result.length !== phase.fields.length || result.some(text => !text.trim())) {
          flow.status = "failed";
          return;
        }
        const content = new Map(phase.fields.map((title, index) => [title, result[index] ?? ""]));
        flow.outputs.push({ title: phase.title, artifacts: targets.map(target => ({
          ...target, sections: definitions[target.kind].fields.map(title => ({ title, text: content.get(title) ?? "" })),
        })) });
        record?.({ kind: "phase.completed", flowId: flow.id, subject: phase.title, details: { artifacts: targets } });
      }
      flow.status = "ready";
    } catch {
      flow.status = "failed";
    } finally {
      if (flows.includes(flow)) record?.({ kind: "flow.finished", flowId: flow.id, details: { status: flow.status, phase: phaseTitle } });
    }
  }

  return {
    list: () => flows,
    begin(prompt: string) {
      if (flows.filter(flow => flow.status === "running").length >= limit) return;
      const id = randomUUID();
      const flow: Flow = {
        id, prompt, title: [...(prompt.split("\n")[0] ?? prompt)].slice(0, 32).join(""),
        source: { id: `${id}/request`, version: 1, kind: "request", upstream: [] },
        status: "running", outputs: [],
      };
      flows.push(flow);
      record?.({ kind: "request.submitted", flowId: flow.id, subject: flow.source.id, details: { text: prompt } });
      const runResult = run(flow);
      running.add(runResult);
      void runResult.then(() => running.delete(runResult));
      return flow;
    },
    reset() {
      for (const flow of flows) {
        if (flow.status === "running") record?.({ kind: "flow.finished", flowId: flow.id, details: { status: "reset" } });
      }
      flows.length = 0;
    },
    settled: () => Promise.allSettled(running),
  };
}

export function makePhasePrompt(flow: Flow, phase: Phase, targets: readonly PhaseTarget[]) {
  return [
    `你正在为 Soulflow 完成单个规划阶段「${phase.title}」。${phase.instruction}`,
    "只完成当前阶段；不修改文件，不派单或发布。上一阶段的产物是待核实的上下文。",
    `原始需求：${JSON.stringify({ ...flow.source, text: flow.prompt })}`,
    `已有产物：${JSON.stringify(flow.outputs)}`,
    `本阶段预定的产物及来源版本：${JSON.stringify(targets)}`,
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
