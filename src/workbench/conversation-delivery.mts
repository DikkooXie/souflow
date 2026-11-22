import { randomUUID } from "node:crypto";
import type { Checkpoint } from "../audit/activity-store.mts";
import type { DeliverySpec } from "../execution/issue-delivery.mts";
import { currentDevelopmentPlan, type Flow } from "../planning/conversation-flow.mts";
import type { Selection, SelectGitHubIssues } from "../planning/github-selection.mts";
import type { DecisionCard } from "./demo-state.mts";
import type { createIssueDispatch } from "./issue-dispatch.mts";

export type IssueProposal = {
  id: string; flowId: string; actor: string; planId: string; version: number; base: string;
  items: Selection[]; status: "selecting" | "pending" | "authorizing" | "submitted" | "declined" | "empty" | "uncertain";
  createdAt: number; approvedAt?: number;
};

const approve = "授权执行并开草稿 PR";
const decline = "暂不执行";
const valid = (p: IssueProposal, flow: Flow | undefined) => {
  const plan = flow && currentDevelopmentPlan(flow);
  return plan?.id === p.planId && plan.version === p.version;
};

export function createConversationDelivery(github: Pick<ReturnType<typeof createIssueDispatch>, "permits" | "suggest" | "claimApproved">, store: Checkpoint<IssueProposal>,
  select: SelectGitHubIssues) {
  const proposals = new Map<string, IssueProposal>();
  const abort = new AbortController();
  const active = new Set<Promise<void>>();
  function save(p: IssueProposal, actor = p.actor) {
    if (!store.save(p.id, p, { kind: "github.selection", flowId: p.flowId, subject: p.id, details: {
      actor, status: p.status, approvedAt: p.approvedAt, planId: p.planId, version: p.version, base: p.base,
      issues: p.items.map(({ number, files, dependsOn }) => ({ number, files, dependsOn })),
    } })) return false;
    proposals.set(p.id, p);
    return true;
  }
  for (const p of store.load()) {
    if (p.status === "selecting" || p.status === "authorizing") {
      if (!save({ ...p, status: "uncertain" })) throw Error("无法恢复 GitHub 选单。");
    } else proposals.set(p.id, p);
  }
  function begin(flow: Flow, planText?: string, retry = false) {
    const plan = currentDevelopmentPlan(flow);
    const base = flow.project?.repository?.revision;
    const actor = flow.requestedBy;
    if (abort.signal.aborted || !plan || !base || !planText || !actor || !github.permits(actor)) return false;
    const prior = [...proposals.values()].reverse().find(p => p.flowId === flow.id && p.planId === plan.id && p.version === plan.version);
    if (retry ? prior?.status !== "uncertain" || prior.approvedAt !== undefined : !!prior) return false;
    const p: IssueProposal = { id: randomUUID(), flowId: flow.id, planId: plan.id, version: plan.version,
      actor, base, status: "selecting", createdAt: Date.now(), items: [] };
    if (!save(p)) return false;
    const task = (async () => {
      try {
        const issues = await github.suggest();
        const items = issues.length ? await select(flow, planText, issues, abort.signal) : [];
        abort.signal.throwIfAborted();
        if (!save({ ...p, items, status: items.length ? "pending" : "empty" })) throw Error("无法保存授权卡。");
      } catch { save({ ...p, status: "uncertain" }); }
    })();
    active.add(task);
    void task.finally(() => active.delete(task));
    return true;
  }
  return {
    begin,
    cards(flows: Flow[], actor: string): DecisionCard[] {
      return [...proposals.values()].filter(p => p.actor === actor && p.status === "pending"
        && valid(p, flows.find(flow => flow.id === p.flowId))).map(p => ({
        id: p.id, kind: "github-authorization", flowId: p.flowId, title: "授权 GitHub 工单交付",
        session: `开发计划 v${p.version} · ${p.base.slice(0, 8)}`, status: "pending",
        prompt: p.items.map(item => [
          `#${item.number} ${item.title}`, `依据：${item.reason}`,
          `范围：${item.files.join("、")}`, `依赖：${item.dependsOn.map(n => `#${n}`).join("、") || "无"}`,
          `执行要求：${item.instructions}`,
        ].join("\n")).join("\n\n"),
        questions: [{ id: "authorization", title: "工单交付授权", prompt: "确认本机 Codex 按上述范围开发、测试并开关联草稿 PR？",
          allowCustom: false, options: [{ label: approve, description: "允许认领和推送任务分支。评审和合并由成员负责。" },
            { label: decline, description: "结束本次选单。" }] }],
        timeline: [{ label: "待确认交付范围", at: new Date(p.createdAt).toISOString() }],
      }));
    },
    statuses(flows: Flow[], actor: string) {
      const latest = new Map([...proposals.values()].filter(p => p.actor === actor && valid(p, flows.find(flow => flow.id === p.flowId)))
        .map(p => [p.flowId, p]));
      return [...latest.values()].map(({ flowId, status, items, approvedAt }) => ({
        flowId, status, approved: approvedAt !== undefined, issues: items.map(item => item.number),
      }));
    },
    has(id: string) { return proposals.has(id); },
    locks(flowId: string) { return [...proposals.values()].some(p => p.flowId === flowId
      && p.approvedAt !== undefined); },
    async answer(id: string, actor: string, input: unknown, flows: Flow[]) {
      const p = proposals.get(id);
      if (!p || p.actor !== actor) return 404;
      if (p.status !== "pending" || !valid(p, flows.find(flow => flow.id === p.flowId))) return 409;
      const value = (input as { authorization?: unknown } | null)?.authorization;
      if (!input || typeof input !== "object" || Object.keys(input).length !== 1 || (value !== approve && value !== decline)) return 422;
      if (value === decline) return save({ ...p, status: "declined" }, actor) ? 200 : 503;
      const authorized = { ...p, status: "authorizing" as const, approvedAt: Date.now() };
      if (!save(authorized, actor)) return 503;
      const specs = new Map(p.items.map(({ number, instructions, files, dependsOn, revision }): [number, DeliverySpec & { issueRevision: string }] =>
        [number, { instructions, files, dependsOn, baseRevision: p.base, issueRevision: revision }]));
      try {
        await github.claimApproved(id, actor, specs, { flowId: p.flowId, planId: p.planId, version: p.version });
        return save({ ...authorized, status: "submitted" }, actor) ? 200 : 503;
      } catch {
        save({ ...authorized, status: "uncertain" }, actor);
        return 409;
      }
    },
    async close() { abort.abort(); await Promise.allSettled(active); },
  };
}
