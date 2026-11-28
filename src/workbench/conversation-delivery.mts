import { randomUUID } from "node:crypto";
import type { Checkpoint } from "../audit/activity-store.mts";
import { issueRevision } from "../connections/issue-tracker.mts";
import { IssueDeliverySourcesChanged, type SourceHandoff } from "../execution/dependency-source-handoff.mts";
import type { DeliverySpec } from "../execution/issue-delivery.mts";
import { currentDevelopmentPlan, type Flow } from "../planning/conversation-flow.mts";
import type { DeliveryReviewScope } from "../planning/delivery-review.mts";
import { acceptanceCriteria, planningDigest, qualityBlock, qualityCurrent, qualityPacket, reviewQuality, reviewTicketSources, withTicketSourceEvidence,
  type BatchAcceptance, type DraftCorrection, type PlannedTicketBatch, type QualityReceipt, type QualityReviewer, type QualityTicket,
  type TicketSourceFinding, type TicketSourceReviewer } from "../planning/dispatch-quality.mts";
import { IssueCoverageGap, type Selection, type SelectGitHubIssues } from "../planning/github-selection.mts";
import { ticketDeliveryLines } from "../planning/ticket-delivery.mts";
import type { DecisionCard } from "./demo-state.mts";
import type { Claim, createIssueDispatch } from "./issue-dispatch.mts";
import { type createPlannedIssuePublication, type PlannedIssueBatch, preparePlannedIssues } from "./planned-issue-publication.mts";

export type IssueProposal = {
  id: string; flowId: string; actor: string; planId: string; version: number; base: string;
  items: Selection[]; status: "selecting" | "reviewing" | "blocked" | "pending" | "authorizing" | "submitted" | "declined" | "empty" | "uncertain";
  createdAt: number; approvedAt?: number;
  drafts?: QualityTicket[];
  batchAcceptance?: BatchAcceptance[];
  sourceReviewRequired?: boolean;
  sourceHandoff?: boolean;
  sourceFindings?: TicketSourceFinding[];
  sourceError?: string;
  corrected?: boolean;
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
const reviewedSelection = (p: IssueProposal) => ({ id: p.id, base: p.base, items: p.drafts ?? p.items,
  ...(p.sourceHandoff ? { sourceHandoff: true } : {}),
  ...(p.batchAcceptance?.length ? { batchAcceptance: p.batchAcceptance } : {}) });
const ticketPaths = (ticket: QualityTicket) => [...new Set([...ticket.paths, ...(ticket.sources ?? [])])];
const sourceProducers = (p: IssueProposal, ticket: QualityTicket) => p.sourceHandoff
  ? (p.drafts ?? []).filter(parent => ticket.dependsOn.includes(parent.id)).flatMap(parent =>
    (ticket.sources ?? []).filter(path => parent.paths.includes(path)).map(path => ({ path, parent: parent.id })))
  : [];
const validated = (p: IssueProposal, flow: Flow | undefined) => valid(p, flow)
  && qualityCurrent(p.quality, flow, reviewedSelection(p))
  && (!p.drafts?.some(ticket => ticket.delivery)
    || p.drafts.every(ticket => p.quality?.breakdown?.some(finding => finding.ticket === ticket.id && finding.status === "pass")))
  && (!p.sourceReviewRequired || p.drafts?.every(ticket => p.quality?.sourceChecks?.some(finding =>
    finding.ticket === ticket.id && finding.status === "pass" && finding.revision === p.base
    && JSON.stringify(finding.paths) === JSON.stringify(ticketPaths(ticket)))));

const missingBatchSources = "工单校验未通过：部分源码无法装入复核资料，请缩小范围后重新选单。";
const reviewError = (error: unknown, fallback: string) => error instanceof Error && /^(工单校验|质量复核|独立质量复核)/.test(error.message)
  ? error.message : fallback;

export function createConversationDelivery(github: Pick<ReturnType<typeof createIssueDispatch>, "permits" | "suggest" | "claimApproved">, store: Checkpoint<IssueProposal>,
  select: SelectGitHubIssues, review: QualityReviewer,
  readSources: (revision: string, paths: string[], signal: AbortSignal) => Promise<Record<string, string>>,
  planned?: {
    draft: (flow: Flow, id: string, correction?: DraftCorrection) => Promise<PlannedTicketBatch>;
    publish: ReturnType<typeof createPlannedIssuePublication>;
    connection: (actor: string) => Parameters<ReturnType<typeof createPlannedIssuePublication>>[1] | undefined;
    sourceReview?: { concurrency: number; reviewer: TicketSourceReviewer };
  }) {
  const proposals = new Map<string, IssueProposal>();
  const abort = new AbortController();
  const active = new Set<Promise<unknown>>();
  function save(p: IssueProposal, actor = p.actor) {
    if (!store.save(p.id, p, { kind: "github.selection", flowId: p.flowId, subject: p.id, details: {
      actor, status: p.status, approvedAt: p.approvedAt, planId: p.planId, version: p.version, base: p.base,
      quality: p.quality, reason: p.error,
      issues: p.items.map(({ number, files, dependsOn, sourcePaths }) => ({ number, files, dependsOn, sourcePaths })),
      ...(p.drafts ? { drafts: p.drafts.map(({ id, dependsOn, paths, delivery }) => ({ id, dependsOn, paths, delivery })), published: p.published } : {}),
      ...(p.batchAcceptance?.length ? { batchAcceptance: p.batchAcceptance } : {}),
      ...(p.corrected ? { corrected: true } : {}),
      ...(p.sourceHandoff ? { sourceHandoff: true } : {}),
      ...(p.sourceFindings?.length ? { sourceFindings: p.sourceFindings } : {}),
      ...(p.sourceError ? { sourceError: p.sourceError } : {}),
    } })) return false;
    proposals.set(p.id, p);
    return true;
  }
  function boundProposal(claim: Pick<Claim, "requestId" | "claimedBy" | "approval">, flow: Flow | undefined) {
    const p = proposals.get(claim.requestId);
    const bound = claim.approval;
    const receipt = p?.quality;
    if (!p || p.approvedAt === undefined || p.actor !== claim.claimedBy || !bound?.quality || !flow || !receipt
      || p.flowId !== bound.flowId || p.flowId !== flow.id || p.planId !== bound.planId || p.version !== bound.version
      || bound.quality.policy !== receipt.policy || bound.quality.flowDigest !== receipt.flowDigest
      || bound.quality.batchDigest !== receipt.batchDigest || !validated(p, flow)) return;
    return p;
  }
  for (const p of store.load()) {
    const gap = p.status === "uncertain" && p.approvedAt === undefined && IssueCoverageGap.fromLegacy(p.error);
    if (gap) {
      if (!save({ ...p, status: "blocked", error: gap.message })) throw Error("无法恢复 GitHub 选单。");
      continue;
    }
    const incompleteDrafts = p.approvedAt === undefined && p.drafts?.some(ticket => !ticket.delivery);
    if (p.status === "pending" && p.approvedAt === undefined && p.drafts?.length && !incompleteDrafts
      && planned?.sourceReview && !p.sourceReviewRequired) {
      const { quality: _previous, ...unapproved } = p;
      if (!save({ ...unapproved, sourceReviewRequired: true, status: "uncertain", error: "原批次需要补齐逐单源码复核，请重新校验。" })) {
        throw Error("无法恢复 GitHub 选单。");
      }
      continue;
    }
    if (p.status === "selecting" || p.status === "reviewing" || p.status === "authorizing"
      || (p.status === "pending" && (!p.quality || incompleteDrafts))) {
      if (!save({ ...p, status: "uncertain", error: p.drafts && p.approvedAt !== undefined
        ? "建单或派发结果待核对，可以沿用本轮授权续办。"
        : incompleteDrafts ? "旧工单缺少逐单拆分依据，请重新核对后授权。" : "请选择重新核对本轮 GitHub 工单。" })) {
        throw Error("无法恢复 GitHub 选单。");
      }
    } else proposals.set(p.id, p);
  }
  async function reviewProposal(draft: IssueProposal, flow: Flow, planText: string,
    keepFindings: (findings: TicketSourceFinding[], error?: string) => void) {
    const { base, items, drafts } = draft;
    const sourceReview = drafts && planned?.sourceReview;
    const sourcePaths = sourceReview ? [] : drafts ? drafts.flatMap(ticketPaths)
      : items.flatMap(item => [...item.files, ...(item.sourcePaths ?? [])]);
    const evidence = sourcePaths.length ? await readSources(base, sourcePaths, abort.signal) : {};
    if (sourcePaths.some(path => !Object.hasOwn(evidence, path))) throw Error(missingBatchSources);
    const publishedPath = flow.project?.plan.path;
    if (publishedPath && flow.project?.plan.status === "read") evidence[publishedPath] = planText;
    const packet = qualityPacket(flow, base, draft.id, drafts ?? items.map(item => ({
      id: String(item.number), title: item.title, instructions: item.instructions, criteria: item.criteria,
      ...(item.sourcePaths ? { sources: item.sourcePaths } : {}),
      dependsOn: item.dependsOn.map(String), paths: item.files, validation: item.validation,
      issue: { revision: item.revision, text: item.issueText },
    })), evidence, draft.batchAcceptance);
    const sourceChecks: TicketSourceFinding[] = [];
    let sourceFailure: PromiseRejectedResult | undefined;
    if (sourceReview) {
      const { concurrency, reviewer } = sourceReview;
      if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw Error("工单校验未通过：源码复核并发配置无效。");
      for (let offset = 0; offset < packet.tickets.length; offset += concurrency) {
        abort.signal.throwIfAborted();
        const findings = await Promise.allSettled(packet.tickets.slice(offset, offset + concurrency).map(async ticket =>
          reviewTicketSources(packet, ticket, await readSources(base, ticketPaths(ticket), abort.signal), reviewer, abort.signal)));
        sourceChecks.push(...findings.flatMap(finding => finding.status === "fulfilled" ? [finding.value] : []));
        sourceFailure = findings.find(result => result.status === "rejected");
        if (sourceFailure) break;
      }
      keepFindings(sourceChecks, sourceFailure ? reviewError(sourceFailure.reason, "逐单源码复核未完成，可以重试。") : undefined);
    }
    const quality = await reviewQuality(sourceReview ? withTicketSourceEvidence(packet, sourceChecks) : packet,
      reviewedSelection(draft), review, abort.signal);
    return { quality: sourceReview ? { ...quality, sourceChecks } : quality, sourceFailure };
  }

  function begin(flow: Flow, planText?: string, retry = false) {
    const plan = currentDevelopmentPlan(flow);
    const base = flow.project?.repository?.revision;
    const actor = flow.requestedBy;
    if (abort.signal.aborted || !plan || !base || !planText || !actor || !github.permits(actor)) return false;
    const prior = [...proposals.values()].reverse().find(p => p.flowId === flow.id && p.planId === plan.id && p.version === plan.version);
    if (retry ? !prior || !["uncertain", "blocked"].includes(prior.status) || prior.approvedAt !== undefined : !!prior) return false;
    const snapshot = structuredClone(flow);
    const reuse = retry && planned?.sourceReview && prior?.actor === actor && prior.base === base
      && prior.status === "uncertain" && (prior.error === missingBatchSources || prior.sourceReviewRequired)
      && prior.drafts?.length ? prior : undefined;
    const p: IssueProposal = { id: reuse?.id ?? randomUUID(), flowId: flow.id, planId: plan.id, version: plan.version,
      actor, base, status: "selecting", createdAt: reuse?.createdAt ?? Date.now(), items: [],
      ...(reuse?.drafts ? { drafts: reuse.drafts, ...(reuse.batchAcceptance?.length ? { batchAcceptance: reuse.batchAcceptance } : {}),
        ...(reuse.corrected ? { corrected: true } : {}) } : {}) };
    if (!save(p)) return false;
    const task = (async () => {
      let draft = p;
      try {
        if (!planningDigest(snapshot)) throw Error("工单校验未通过：规划产物或上游版本不完整。");
        const eligible = reuse ? [] : await github.suggest();
        const candidates = snapshot.project?.issueCandidates;
        const frozen = candidates?.every(item => item.revision) ? new Map(candidates.map(item => [item.number, item.revision])) : undefined;
        const issues = frozen ? eligible.filter(issue => frozen.get(issue.number) === issueRevision(issue)) : eligible;
        const selection = reuse?.drafts ? "new" : issues.length || planned ? await select(snapshot, planText, issues, abort.signal) : [];
        const newBatch = !reuse && selection === "new" ? await planned?.draft(snapshot, p.id) : undefined;
        const drafts = reuse?.drafts ?? newBatch?.tickets;
        const batchAcceptance = reuse?.batchAcceptance ?? newBatch?.batchAcceptance;
        const items = selection === "new" ? [] : selection;
        if (!drafts && frozen && !issues.length && eligible.length) {
          throw Error("工单校验未通过：候选 Issue 已变化，请按最新资料开启新一轮规划。");
        }
        abort.signal.throwIfAborted();
        if (!(drafts?.length || items.length)) {
          if (!save({ ...p, status: "empty" })) throw Error("无法保存选单结果。");
          return;
        }
        const sourceReview = drafts && planned?.sourceReview;
        draft = { ...p, items, ...(drafts ? { drafts } : {}), ...(sourceReview ? { sourceReviewRequired: true, sourceHandoff: true } : {}),
          ...(batchAcceptance?.length ? { batchAcceptance } : {}), status: "reviewing" };
        if (drafts) {
          const connection = planned?.connection(actor);
          if (!connection?.creation) throw Error("工单校验未通过：当前 GitHub 连接不支持创建 Issue。");
          preparePlannedIssues(publicationBatch(draft, drafts), connection.repo);
        }
        if (!save(draft)) throw Error("无法保存待复核工单。");
        for (;;) {
          const { quality, sourceFailure } = await reviewProposal(draft, snapshot, planText, (sourceFindings, sourceError) => {
            draft = { ...draft, sourceFindings, ...(sourceError ? { sourceError } : {}) };
            if (!save(draft)) throw Error("无法保存逐单源码复核意见。");
          });
          const { sourceFindings: _complete, ...reviewed } = draft;
          draft = { ...reviewed, quality };
          if (sourceFailure) throw sourceFailure.reason;
          if (quality.flowDigest !== planningDigest(flow)) throw Error("工单校验未通过：规划版本已变化，请重新选单。");
          const error = qualityBlock(quality);
          if (!error || !draft.drafts || !sourceReview || !planned || draft.corrected || quality.checks.scope.status === "block") {
            if (!save(error ? { ...draft, status: "blocked", error } : { ...draft, status: "pending" })) throw Error("无法保存质量复核结果。");
            break;
          }
          // 只修正技术核对与验证缺项。产品范围变化要回到原对话，任何修正版都重新复核。
          draft = { ...draft, corrected: true };
          if (!save(draft)) throw Error("无法保存首轮复核结果。");
          const corrected = await planned.draft(snapshot, draft.id, {
            findings: error, tickets: draft.drafts ?? [], batchAcceptance: draft.batchAcceptance ?? [],
          });
          const connection = planned.connection(actor);
          if (!connection?.creation) throw Error("工单校验未通过：当前 GitHub 连接不支持创建 Issue。");
          const { quality: _prior, batchAcceptance: _priorAcceptance, sourceFindings: _priorFindings, sourceError: _priorError, ...proposal } = draft;
          draft = { ...proposal, drafts: corrected.tickets, ...(corrected.batchAcceptance.length ? { batchAcceptance: corrected.batchAcceptance } : {}) };
          preparePlannedIssues(publicationBatch(draft, corrected.tickets), connection.repo);
          if (!save(draft)) throw Error("无法保存修订工单。");
        }
      } catch (error) {
        if (error instanceof IssueCoverageGap) {
          save({ ...draft, status: "blocked", error: error.message });
          return;
        }
        const message = reviewError(error, "无法完成 GitHub 选单或质量复核，可以重试。");
        save({ ...draft, status: "uncertain", error: message });
      }
    })();
    active.add(task);
    void task.finally(() => active.delete(task));
    return true;
  }
  const verificationText = (validation: QualityTicket["validation"]) =>
    validation.map(({ criterion, procedure, expected }) => `${criterion}：${procedure} → ${expected}`);
  const acceptanceText = (item: BatchAcceptance) =>
    `${item.criterion} · ${item.owner === "batch" ? "整批验收" : `关联 Issue #${item.issue}`} · ${item.procedure} → ${item.expected}`;
  const draftInstructions = (draft: QualityTicket) => [
    ...(draft.delivery ? ticketDeliveryLines(draft.delivery) : []), draft.instructions,
  ].join("\n");
  const draftText = (p: IssueProposal, draft: QualityTicket) => [draftInstructions(draft), "", `允许修改：${draft.paths.join("、")}`,
    ...sourceProducers(p, draft).map(({ path, parent }) => `只读交接：${parent} 合并后重新核对 ${path}`),
    ...verificationText(draft.validation)].join("\n");
  const publicationBatch = (proposal: IssueProposal, drafts: readonly QualityTicket[]): PlannedIssueBatch => ({
    ...proposal, drafts: drafts.map(draft => ({ id: draft.id, title: draft.title, body: draftText(proposal, draft), dependsOn: draft.dependsOn })),
  });

  async function deliver(p: IssueProposal, flow: Flow | undefined, actor: string) {
    const quality = p.quality;
    if (!quality || !validated(p, flow)) return 409;
    const basePlanPath = flow?.project?.plan.status === "read" ? flow.project.plan.path : undefined;
    let publication = p;
    try {
      let items = p.items;
      const handoffs = new Map<number, NonNullable<DeliverySpec["sourceFrom"]>>();
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
          const sourceFrom = sourceProducers(p, draft).map(({ path, parent }) => ({ path, issue: numberFor(parent) }));
          if (sourceFrom.length) handoffs.set(issue.number, sourceFrom);
          return { number: issue.number, title: issue.title, reason: "", revision: issueRevision(issue),
            files: [...draft.paths], instructions: draftInstructions(draft), dependsOn: draft.dependsOn.map(numberFor),
            criteria: [...draft.criteria], validation: [...draft.validation], issueText: issue.body,
            ...(draft.sources ? { sourcePaths: [...draft.sources] } : {}) };
        });
        publication = { ...p, published: items.map(item => item.number) };
        if (!save(publication, actor)) throw Error("无法保存本轮创建的 Issue。");
      }
      const specs = new Map(items.map(({ number, instructions, files, dependsOn, revision, validation, sourcePaths }): [number, DeliverySpec & { issueRevision: string }] => {
        const sourceFrom = handoffs.get(number);
        return [number, { instructions: [instructions, ...verificationText(validation)].join("\n"),
          files, dependsOn, baseRevision: p.base, ...(basePlanPath ? { basePlanPath } : {}),
          ...(sourceFrom ? { sourceFrom } : {}),
          ...(sourcePaths?.length ? { sourcePaths } : {}), issueRevision: revision }];
      }));
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
        prompt: p.drafts ? [...p.drafts.map(draft => [`${draft.id} · ${draft.title}`,
          `依赖：${draft.dependsOn.join("、") || "无"}`, draftText(p, draft)].join("\n")),
          ...(p.batchAcceptance?.length ? [["另行待验收（不建 Issue）", ...p.batchAcceptance.map(acceptanceText)].join("\n")] : [])].join("\n\n") : p.items.map(item => [
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
      return [...latest.values()].map(({ flowId, status, items, approvedAt, error, quality, drafts, published, batchAcceptance, sourceFindings, sourceError }) => ({
        flowId, status, approved: approvedAt !== undefined, issues: published ?? items.map(item => item.number), error, quality,
        ...(drafts ? { createsIssues: true } : {}),
        ...(batchAcceptance?.length ? { batchAcceptance } : {}),
        ...(!quality && sourceFindings?.length ? { sourceFindings } : {}),
        ...(sourceError && sourceError !== error ? { sourceError } : {}),
      }));
    },
    has(id: string) { return proposals.has(id); },
    reviewScope(claim: Pick<Claim, "number" | "requestId" | "claimedBy" | "approval">, flow: Flow | undefined): DeliveryReviewScope | undefined {
      const p = boundProposal(claim, flow);
      if (!p || !flow) return;
      const selected = p.items.find(issue => issue.number === claim.number && issue.revision === claim.approval?.issueRevision);
      const draft = p.drafts && p.published ? p.drafts[p.published.indexOf(claim.number)] : undefined;
      const issue = draft ?? selected;
      if (!issue) return;
      const criteria = new Map(acceptanceCriteria(flow).map(({ id, text }) => [id, text]));
      const mapped = issue.validation.flatMap(row => {
        const text = criteria.get(row.criterion);
        return text ? [{ ...row, text }] : [];
      });
      if (!mapped.length || mapped.length !== issue.validation.length) return;
      return { request: flow.prompt, criteria: mapped, files: draft?.paths ?? selected?.files ?? [] };
    },
    async reviewHandoff(claim: Claim, flow: Flow | undefined, proof: SourceHandoff, sources: Record<string, string>, signal: AbortSignal) {
      const p = boundProposal(claim, flow);
      const reviewer = planned?.sourceReview?.reviewer;
      const draft = p?.published ? p.drafts?.[p.published.indexOf(claim.number)] : undefined;
      if (!p?.sourceHandoff || !p.drafts || !p.published || p.status !== "submitted" || !flow || !reviewer || !draft
        || proof.original !== p.base) throw new IssueDeliverySourcesChanged();
      const expected = sourceProducers(p, draft).map(({ path, parent }) =>
        `${p.published?.[p.drafts?.findIndex(ticket => ticket.id === parent) ?? -1]}:${path}`).sort();
      const actual = proof.producers.flatMap(producer => producer.sources.map(path => `${producer.issue}:${path}`)).sort();
      if (!proof.changedPaths.length || !expected.length || JSON.stringify(expected) !== JSON.stringify(actual)
        || (proof.refreshed ? claim.sourceRefresh?.revision !== proof.execution || proof.changedPaths.some(path => !ticketPaths(draft).includes(path))
          : proof.changedPaths.some(path => !proof.producers.some(producer => producer.sources.includes(path))))) throw new IssueDeliverySourcesChanged();
      const packet = qualityPacket(flow, p.base, p.id, p.drafts, {}, p.batchAcceptance);
      return reviewTicketSources({ ...packet, revision: proof.execution }, draft, sources, reviewer, signal,
        { original: p.base, changedPaths: proof.changedPaths });
    },
    publicationNeedsCheck(id: string, actor: string) {
      const p = proposals.get(id);
      return p?.actor === actor && !!p.drafts && p.status === "uncertain" && p.approvedAt !== undefined;
    },
    replanFeedback(flow: Flow, actor: string) {
      const p = [...proposals.values()].reverse().find(item => item.flowId === flow.id && item.actor === actor && valid(item, flow));
      if (!p || p.approvedAt !== undefined || !p.error) return;
      const partialBlocks = p.status === "uncertain" && p.sourceReviewRequired && p.sourceError
        && flow.project?.repository?.revision === p.base
        ? (p.quality?.sourceChecks ?? p.sourceFindings ?? []).filter(check => check.status === "block" && check.revision === p.base
          && p.drafts?.some(ticket => ticket.id === check.ticket && JSON.stringify(ticketPaths(ticket)) === JSON.stringify(check.paths)))
        : [];
      if (p.status !== "blocked" && !partialBlocks.length) return;
      const checks = p.status === "blocked" ? p.quality?.sourceChecks ?? [] : partialBlocks;
      const sourcePaths = [...new Set(checks.flatMap(check =>
        check.evidence.flatMap(({ ref }) => ref.startsWith("repo:") && check.paths.includes(ref.slice(5)) ? [ref.slice(5)] : [])))];
      const findings = [p.error, ...partialBlocks.map(check => `${check.ticket} 源码：${check.summary}`)].join("\n");
      return { batchId: p.id, findings, ...(sourcePaths.length ? { sourcePaths } : {}) };
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
