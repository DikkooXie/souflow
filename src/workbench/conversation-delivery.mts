import { randomUUID } from "node:crypto";
import type { Checkpoint } from "../audit/activity-store.mts";
import { issueRevision } from "../connections/issue-tracker.mts";
import type { DeliverySpec } from "../execution/issue-delivery.mts";
import { currentDevelopmentPlan, type Flow } from "../planning/conversation-flow.mts";
import { planningDigest, qualityBlock, qualityCurrent, qualityPacket, reviewQuality,
  type QualityReceipt, type QualityReviewer, type QualityTicket } from "../planning/dispatch-quality.mts";
import type { Selection, SelectGitHubIssues } from "../planning/github-selection.mts";
import type { DecisionCard } from "./demo-state.mts";
import type { createIssueDispatch } from "./issue-dispatch.mts";
import { type createPlannedIssuePublication, type PlannedIssueBatch, preparePlannedIssues } from "./planned-issue-publication.mts";

export type IssueProposal = {
  id: string; flowId: string; actor: string; planId: string; version: number; base: string;
  items: Selection[]; status: "selecting" | "reviewing" | "blocked" | "pending" | "authorizing" | "submitted" | "declined" | "empty" | "uncertain";
  createdAt: number; approvedAt?: number;
  drafts?: QualityTicket[];
  published?: number[];
  quality?: QualityReceipt; error?: string;
};

const approve = "授权执行并开草稿 PR";
const approveCreation = "授权创建 Issue、执行并开草稿 PR";
const decline = "暂不执行";
const valid = (p: IssueProposal, flow: Flow | undefined) => {
  const plan = flow && currentDevelopmentPlan(flow);
  return plan?.id === p.planId && plan.version === p.version;
};
const reviewedSelection = (p: IssueProposal) => ({ id: p.id, base: p.base, items: p.drafts ?? p.items });
const validated = (p: IssueProposal, flow: Flow | undefined) => valid(p, flow)
  && qualityCurrent(p.quality, flow, reviewedSelection(p));

export function createConversationDelivery(github: Pick<ReturnType<typeof createIssueDispatch>, "permits" | "suggest" | "claimApproved">, store: Checkpoint<IssueProposal>,
  select: SelectGitHubIssues, review: QualityReviewer,
  readSources: (revision: string, paths: string[], signal: AbortSignal) => Promise<Record<string, string>>,
  planned?: {
    draft: (flow: Flow, id: string) => Promise<QualityTicket[]>;
    publish: ReturnType<typeof createPlannedIssuePublication>;
    connection: (actor: string) => Parameters<ReturnType<typeof createPlannedIssuePublication>>[1] | undefined;
  }) {
  const proposals = new Map<string, IssueProposal>();
  const abort = new AbortController();
  const active = new Set<Promise<unknown>>();
  function save(p: IssueProposal, actor = p.actor) {
    if (!store.save(p.id, p, { kind: "github.selection", flowId: p.flowId, subject: p.id, details: {
      actor, status: p.status, approvedAt: p.approvedAt, planId: p.planId, version: p.version, base: p.base,
      quality: p.quality, reason: p.error,
      issues: p.items.map(({ number, files, dependsOn, sourcePaths }) => ({ number, files, dependsOn, sourcePaths })),
      ...(p.drafts ? { drafts: p.drafts.map(({ id, dependsOn, paths }) => ({ id, dependsOn, paths })), published: p.published } : {}),
    } })) return false;
    proposals.set(p.id, p);
    return true;
  }
  for (const p of store.load()) {
    if (p.status === "selecting" || p.status === "reviewing" || p.status === "authorizing" || (p.status === "pending" && !p.quality)) {
      if (!save({ ...p, status: "uncertain", error: p.drafts && p.approvedAt !== undefined
        ? "建单或派发结果待核对，可以沿用本轮授权续办。" : "请选择重新核对本轮 GitHub 工单。" })) throw Error("无法恢复 GitHub 选单。");
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
        const selection = issues.length || planned ? await select(snapshot, planText, issues, abort.signal) : [];
        const drafts = selection === "new" && planned ? await planned.draft(snapshot, p.id) : undefined;
        const items = selection === "new" ? [] : selection;
        if (!drafts && frozen && !issues.length && eligible.length) {
          throw Error("工单校验未通过：候选 Issue 已变化，请按最新资料开启新一轮规划。");
        }
        abort.signal.throwIfAborted();
        if (!(drafts?.length || items.length)) {
          if (!save({ ...p, status: "empty" })) throw Error("无法保存选单结果。");
          return;
        }
        draft = { ...p, items, ...(drafts ? { drafts } : {}), status: "reviewing" };
        if (drafts) {
          const connection = planned?.connection(actor);
          if (!connection?.creation) throw Error("工单校验未通过：当前 GitHub 连接不支持创建 Issue。");
          preparePlannedIssues(publicationBatch(draft, drafts), connection.repo);
        }
        if (!save(draft)) throw Error("无法保存待复核工单。");
        const sourcePaths = drafts ? drafts.flatMap(item => [...item.paths, ...(item.sources ?? [])])
          : items.flatMap(item => [...item.files, ...(item.sourcePaths ?? [])]);
        const evidence = await readSources(base, sourcePaths, abort.signal);
        if (sourcePaths.some(path => !Object.hasOwn(evidence, path))) {
          throw Error("工单校验未通过：部分源码无法装入复核资料，请缩小范围后重新选单。");
        }
        const publishedPath = snapshot.project?.plan.path;
        if (publishedPath && snapshot.project?.plan.status === "read") evidence[publishedPath] = planText;
        const packet = qualityPacket(snapshot, base, p.id, drafts ?? items.map(item => ({
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
  const verificationText = (validation: QualityTicket["validation"]) =>
    validation.map(({ criterion, procedure, expected }) => `${criterion}：${procedure} → ${expected}`);
  const draftText = (draft: QualityTicket) => [draft.instructions, "", `允许修改：${draft.paths.join("、")}`,
    ...verificationText(draft.validation)].join("\n");
  const publicationBatch = (proposal: IssueProposal, drafts: readonly QualityTicket[]): PlannedIssueBatch => ({
    ...proposal, drafts: drafts.map(draft => ({ id: draft.id, title: draft.title, body: draftText(draft), dependsOn: draft.dependsOn })),
  });

  async function deliver(p: IssueProposal, flow: Flow | undefined, actor: string) {
    const quality = p.quality;
    if (!quality || !validated(p, flow)) return 409;
    const basePlanPath = flow?.project?.plan.status === "read" ? flow.project.plan.path : undefined;
    let publication = p;
    try {
      let items = p.items;
      if (p.drafts) {
        const connection = planned?.connection(actor);
        if (!connection || !planned) throw Error("当前成员未连接可用于建单的 GitHub 账号。");
        const issued = await planned.publish(publicationBatch(p, p.drafts), connection, abort.signal);
        const numberFor = (id: string) => {
          const issue = issued.get(id);
          if (!issue) throw Error("已审核的工单缺少创建回执。");
          return issue.number;
        };
        items = p.drafts.map(draft => {
          const issue = issued.get(draft.id);
          if (!issue) throw Error("已审核的工单缺少创建回执。");
          return { number: issue.number, title: issue.title, reason: "", revision: issueRevision(issue),
            files: [...draft.paths], instructions: draft.instructions, dependsOn: draft.dependsOn.map(numberFor),
            criteria: [...draft.criteria], validation: [...draft.validation], issueText: issue.body,
            ...(draft.sources ? { sourcePaths: [...draft.sources] } : {}) };
        });
        publication = { ...p, published: items.map(item => item.number) };
        if (!save(publication, actor)) throw Error("无法保存本轮创建的 Issue。");
      }
      const specs = new Map(items.map(({ number, instructions, files, dependsOn, revision, validation, sourcePaths }): [number, DeliverySpec & { issueRevision: string }] =>
        [number, { instructions: [instructions, ...verificationText(validation)].join("\n"),
          files, dependsOn, baseRevision: p.base, ...(basePlanPath ? { basePlanPath } : {}),
          ...(sourcePaths?.length ? { sourcePaths } : {}), issueRevision: revision }]));
      abort.signal.throwIfAborted();
      await github.claimApproved(p.id, actor, specs, { flowId: p.flowId, planId: p.planId, version: p.version,
        quality: { policy: quality.policy, flowDigest: quality.flowDigest, batchDigest: quality.batchDigest } }, !!p.drafts);
      return save({ ...publication, status: "submitted", error: "" }, actor) ? 200 : 503;
    } catch {
      save({ ...publication, status: "uncertain",
        ...(p.drafts ? { error: "建单或派发结果待核对。续办会核对已创建的 Issue 和认领状态。" } : {}) }, actor);
      return 409;
    }
  }

  async function finishPublication(p: IssueProposal, flow: Flow | undefined, actor: string) {
    const task = deliver(p, flow, actor);
    active.add(task);
    try { return await task; }
    finally { active.delete(task); }
  }

  return {
    begin,
    cards(flows: Flow[], actor: string): DecisionCard[] {
      return [...proposals.values()].filter(p => p.actor === actor && p.status === "pending"
        && validated(p, flows.find(flow => flow.id === p.flowId))).map(p => ({
        id: p.id, kind: "github-authorization", flowId: p.flowId, title: "授权 GitHub 工单交付",
        session: `开发计划 v${p.version} · ${p.base.slice(0, 8)}`, status: "pending",
        prompt: p.drafts ? p.drafts.map(draft => [`${draft.id} · ${draft.title}`,
          `依赖：${draft.dependsOn.join("、") || "无"}`, draftText(draft)].join("\n")).join("\n\n") : p.items.map(item => [
          `#${item.number} ${item.title}`, `依据：${item.reason}`,
          `范围：${item.files.join("、")}`, `依赖：${item.dependsOn.map(n => `#${n}`).join("、") || "无"}`,
          `执行要求：${item.instructions}`,
          ...item.validation.map(({ criterion, procedure, expected }) => `${criterion}：${procedure} → ${expected}`),
        ].join("\n")).join("\n\n"),
        questions: [{ id: "authorization", title: "工单交付授权",
          prompt: p.drafts ? `确认在 ${flows.find(flow => flow.id === p.flowId)?.project?.github.repo ?? "关联仓库"} 创建上述 Issue，并将它们交给 Codex 开发、测试和开草稿 PR？`
            : "确认本机 Codex 按上述范围开发、测试并开关联草稿 PR？",
          allowCustom: false, options: [{ label: p.drafts ? approveCreation : approve,
            description: p.drafts ? "允许创建、认领 Issue 和推送任务分支。评审和合并由成员负责。"
              : "允许认领和推送任务分支。评审和合并由成员负责。" },
            { label: decline, description: "结束本次选单。" }] }],
        timeline: [{ label: "待确认交付范围", at: new Date(p.createdAt).toISOString() }],
      }));
    },
    statuses(flows: Flow[], actor: string) {
      const latest = new Map([...proposals.values()].filter(p => p.actor === actor && valid(p, flows.find(flow => flow.id === p.flowId)))
        .map(p => [p.flowId, p]));
      return [...latest.values()].map(({ flowId, status, items, approvedAt, error, quality, drafts, published }) => ({
        flowId, status, approved: approvedAt !== undefined, issues: published ?? items.map(item => item.number), error, quality,
        ...(drafts ? { createsIssues: true } : {}),
      }));
    },
    has(id: string) { return proposals.has(id); },
    publicationNeedsCheck(id: string, actor: string) {
      const p = proposals.get(id);
      return p?.actor === actor && !!p.drafts && p.status === "uncertain" && p.approvedAt !== undefined;
    },
    replanFeedback(flow: Flow, actor: string) {
      const p = [...proposals.values()].reverse().find(item => item.flowId === flow.id && item.actor === actor && valid(item, flow));
      if (p?.status === "blocked" && p.approvedAt === undefined && p.error) return { batchId: p.id, findings: p.error };
    },
    locks(flowId: string) { return [...proposals.values()].some(p => p.flowId === flowId
      && p.approvedAt !== undefined); },
    async resumePublication(flow: Flow, actor: string) {
      const p = [...proposals.values()].reverse().find(item => item.flowId === flow.id && item.actor === actor
        && item.status === "uncertain" && item.approvedAt !== undefined && item.drafts);
      if (!p || !github.permits(actor) || !validated(p, flow)) return 409;
      const resumed = { ...p, status: "authorizing" as const, error: "" };
      if (!save(resumed, actor)) return 503;
      return finishPublication(resumed, flow, actor);
    },
    async answer(id: string, actor: string, input: unknown, flows: Flow[]) {
      const p = proposals.get(id);
      if (!p || p.actor !== actor) return 404;
      const quality = p.quality;
      const flow = flows.find(flow => flow.id === p.flowId);
      if (!quality || p.status !== "pending" || !validated(p, flow)) return 409;
      const value = (input as { authorization?: unknown } | null)?.authorization;
      if (!input || typeof input !== "object" || Object.keys(input).length !== 1
        || (value !== (p.drafts ? approveCreation : approve) && value !== decline)) return 422;
      if (value === decline) return save({ ...p, status: "declined" }, actor) ? 200 : 503;
      const authorized = { ...p, status: "authorizing" as const, approvedAt: Date.now() };
      if (!save(authorized, actor)) return 503;
      return finishPublication(authorized, flow, actor);
    },
    async close() { abort.abort(); await Promise.allSettled(active); },
  };
}
