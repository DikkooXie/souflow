import { randomUUID } from "node:crypto";
import type { Checkpoint } from "../audit/activity-store.mts";
import { issueRevision } from "../connections/issue-tracker.mts";
import type { DeliverySpec } from "../execution/issue-delivery.mts";
import { currentDevelopmentPlan, type Flow } from "../planning/conversation-flow.mts";
import { planningDigest, qualityBlock, qualityCurrent, qualityPacket, reviewQuality,
  type QualityReceipt, type QualityReviewer } from "../planning/dispatch-quality.mts";
import type { Selection, SelectGitHubIssues } from "../planning/github-selection.mts";
import type { DecisionCard } from "./demo-state.mts";
import type { createIssueDispatch } from "./issue-dispatch.mts";

export type IssueProposal = {
  id: string; flowId: string; actor: string; planId: string; version: number; base: string;
  items: Selection[]; status: "selecting" | "reviewing" | "blocked" | "pending" | "authorizing" | "submitted" | "declined" | "empty" | "uncertain";
  createdAt: number; approvedAt?: number;
  quality?: QualityReceipt; error?: string;
};

const approve = "授权执行并开草稿 PR";
const decline = "暂不执行";
const valid = (p: IssueProposal, flow: Flow | undefined) => {
  const plan = flow && currentDevelopmentPlan(flow);
  return plan?.id === p.planId && plan.version === p.version;
};
const reviewedSelection = (p: IssueProposal) => ({ id: p.id, base: p.base, items: p.items });
const validated = (p: IssueProposal, flow: Flow | undefined) => valid(p, flow)
  && qualityCurrent(p.quality, flow, reviewedSelection(p));

export function createConversationDelivery(github: Pick<ReturnType<typeof createIssueDispatch>, "permits" | "suggest" | "claimApproved">, store: Checkpoint<IssueProposal>,
  select: SelectGitHubIssues, review: QualityReviewer,
  readSources: (revision: string, paths: string[], signal: AbortSignal) => Promise<Record<string, string>>) {
  const proposals = new Map<string, IssueProposal>();
  const abort = new AbortController();
  const active = new Set<Promise<void>>();
  function save(p: IssueProposal, actor = p.actor) {
    if (!store.save(p.id, p, { kind: "github.selection", flowId: p.flowId, subject: p.id, details: {
      actor, status: p.status, approvedAt: p.approvedAt, planId: p.planId, version: p.version, base: p.base,
      quality: p.quality, reason: p.error,
      issues: p.items.map(({ number, files, dependsOn, sourcePaths }) => ({ number, files, dependsOn, sourcePaths })),
    } })) return false;
    proposals.set(p.id, p);
    return true;
  }
  for (const p of store.load()) {
    if (p.status === "selecting" || p.status === "reviewing" || p.status === "authorizing" || (p.status === "pending" && !p.quality)) {
      if (!save({ ...p, status: "uncertain", error: "请选择重新核对本轮 GitHub 工单。" })) throw Error("无法恢复 GitHub 选单。");
    } else proposals.set(p.id, p);
  }
  function begin(flow: Flow, planText?: string, retry = false) {
    const plan = currentDevelopmentPlan(flow);
    const base = flow.project?.repository?.revision;
    const actor = flow.requestedBy;
    if (abort.signal.aborted || !plan || !base || !planText || !actor || !github.permits(actor)) return false;
    const prior = [...proposals.values()].reverse().find(p => p.flowId === flow.id && p.planId === plan.id && p.version === plan.version);
    if (retry ? !prior || !["uncertain", "blocked"].includes(prior.status) || prior.approvedAt !== undefined : !!prior) return false;
    const snapshot = structuredClone(flow);
    const p: IssueProposal = { id: randomUUID(), flowId: flow.id, planId: plan.id, version: plan.version,
      actor, base, status: "selecting", createdAt: Date.now(), items: [] };
    if (!save(p)) return false;
    const task = (async () => {
      let draft = p;
      try {
        if (!planningDigest(snapshot)) throw Error("工单校验未通过：规划产物或上游版本不完整。");
        const eligible = await github.suggest();
        const candidates = snapshot.project?.issueCandidates;
        const frozen = candidates?.every(item => item.revision) ? new Map(candidates.map(item => [item.number, item.revision])) : undefined;
        const issues = frozen ? eligible.filter(issue => frozen.get(issue.number) === issueRevision(issue)) : eligible;
        if (frozen && !issues.length && eligible.length) {
          throw Error("工单校验未通过：候选 Issue 已变化，请按最新资料开启新一轮规划。");
        }
        const items = issues.length ? await select(snapshot, planText, issues, abort.signal) : [];
        abort.signal.throwIfAborted();
        if (!items.length) {
          if (!save({ ...p, status: "empty" })) throw Error("无法保存选单结果。");
          return;
        }
        draft = { ...p, items, status: "reviewing" };
        if (!save(draft)) throw Error("无法保存待复核工单。");
        const evidence = await readSources(base, items.flatMap(item => [...item.files, ...(item.sourcePaths ?? [])]), abort.signal);
        const publishedPath = snapshot.project?.plan.path;
        if (publishedPath && snapshot.project?.plan.status === "read") evidence[publishedPath] = planText;
        const packet = qualityPacket(snapshot, base, p.id, items.map(item => ({
          id: String(item.number), title: item.title, instructions: item.instructions, criteria: item.criteria,
          ...(item.sourcePaths ? { sources: item.sourcePaths } : {}),
          dependsOn: item.dependsOn.map(String), paths: item.files, validation: item.validation,
          issue: { revision: item.revision, text: item.issueText },
        })), evidence);
        const quality = await reviewQuality(packet, reviewedSelection(draft), review, abort.signal);
        if (quality.flowDigest !== planningDigest(flow)) throw Error("工单校验未通过：规划版本已变化，请重新选单。");
        const error = qualityBlock(quality);
        if (!save(error ? { ...draft, quality, status: "blocked", error } : { ...draft, quality, status: "pending" })) {
          throw Error("无法保存质量复核结果。");
        }
      } catch (error) {
        const message = error instanceof Error && /^(工单校验|质量复核|独立质量复核)/.test(error.message)
          ? error.message : "无法完成 GitHub 选单或质量复核，可以重试。";
        save({ ...draft, status: "uncertain", error: message });
      }
    })();
    active.add(task);
    void task.finally(() => active.delete(task));
    return true;
  }
  return {
    begin,
    cards(flows: Flow[], actor: string): DecisionCard[] {
      return [...proposals.values()].filter(p => p.actor === actor && p.status === "pending"
        && validated(p, flows.find(flow => flow.id === p.flowId))).map(p => ({
        id: p.id, kind: "github-authorization", flowId: p.flowId, title: "授权 GitHub 工单交付",
        session: `开发计划 v${p.version} · ${p.base.slice(0, 8)}`, status: "pending",
        prompt: p.items.map(item => [
          `#${item.number} ${item.title}`, `依据：${item.reason}`,
          `范围：${item.files.join("、")}`, `依赖：${item.dependsOn.map(n => `#${n}`).join("、") || "无"}`,
          `执行要求：${item.instructions}`,
          ...item.validation.map(({ criterion, procedure, expected }) => `${criterion}：${procedure} → ${expected}`),
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
      return [...latest.values()].map(({ flowId, status, items, approvedAt, error, quality }) => ({
        flowId, status, approved: approvedAt !== undefined, issues: items.map(item => item.number), error, quality,
      }));
    },
    has(id: string) { return proposals.has(id); },
    locks(flowId: string) { return [...proposals.values()].some(p => p.flowId === flowId
      && p.approvedAt !== undefined); },
    async answer(id: string, actor: string, input: unknown, flows: Flow[]) {
      const p = proposals.get(id);
      if (!p || p.actor !== actor) return 404;
      const quality = p.quality;
      const flow = flows.find(flow => flow.id === p.flowId);
      if (!quality || p.status !== "pending" || !validated(p, flow)) return 409;
      const value = (input as { authorization?: unknown } | null)?.authorization;
      if (!input || typeof input !== "object" || Object.keys(input).length !== 1 || (value !== approve && value !== decline)) return 422;
      if (value === decline) return save({ ...p, status: "declined" }, actor) ? 200 : 503;
      const authorized = { ...p, status: "authorizing" as const, approvedAt: Date.now() };
      if (!save(authorized, actor)) return 503;
      const basePlanPath = flow?.project?.plan.status === "read" ? flow.project.plan.path : undefined;
      const specs = new Map(p.items.map(({ number, instructions, files, dependsOn, revision, validation, sourcePaths }): [number, DeliverySpec & { issueRevision: string }] =>
        [number, { instructions: [instructions, ...validation.map(item => `${item.criterion}：${item.procedure} → ${item.expected}`)].join("\n"),
          files, dependsOn, baseRevision: p.base, ...(basePlanPath ? { basePlanPath } : {}),
          ...(sourcePaths?.length ? { sourcePaths } : {}), issueRevision: revision }]));
      try {
        await github.claimApproved(id, actor, specs, { flowId: p.flowId, planId: p.planId, version: p.version,
          quality: { policy: quality.policy, flowDigest: quality.flowDigest, batchDigest: quality.batchDigest } });
        return save({ ...authorized, status: "submitted" }, actor) ? 200 : 503;
      } catch {
        save({ ...authorized, status: "uncertain" }, actor);
        return 409;
      }
    },
    async close() { abort.abort(); await Promise.allSettled(active); },
  };
}
