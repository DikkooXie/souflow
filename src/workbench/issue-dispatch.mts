import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { scrubAuditText } from "../audit/activity-store.mts";
import type { FailedReviewDraft } from "../execution/failed-review-draft.mts";
import type { BusinessEvent, Checkpoint } from "../audit/activity-store.mts";
import { issueRevision, type DeliveryTracker, type IssueDetail, type IssuePull, type IssueSummary, type IssueTracker } from "../connections/issue-tracker.mts";
import type { AccountAssignment } from "../execution/codex-account-dispatch.mts";
import type { WorkerFailureScope } from "../execution/code-worker-pool.mts";
import type { WorkerFailureStage } from "../execution/code-worker-protocol.mts";
import { describeIsolationEvidence } from "../execution/isolation-evidence.mts";
import { describePatchDiagnostics, type PatchDiagnostic } from "../execution/patch-diagnostics.mts";
import type { SourceHandoff, SourceProducer } from "../execution/dependency-source-handoff.mts";
import { IssueDeliveryFailed, IssueDeliverySourcesChanged, type CheckedIssue, type DeliveryFailure, type DeliverySpec, type DeliveryTarget, type PreparedDelivery, type PrepareIssue } from "../execution/issue-delivery.mts";
import { IssueVerificationUncertain, type VerifyIssue } from "../execution/issue-verification.mts";
import type { PatchIssue } from "../execution/local-code-changes.mts";
import type { DeliveryReviewReceipt } from "../planning/delivery-review.mts";
import { qualityBindingCurrent, type QualityBinding, type TicketSourceFinding } from "../planning/dispatch-quality.mts";
import type { ApprovedReviewFix } from "./approved-review-fix.mts";
import { selectApprovedRepairReplay } from "./approved-repair-replay.mts";
import { continuationBinding, createRepairContinuation, failureFingerprint, type PreparedRepairContinuation,
  type RepairContinuation } from "./repair-continuation.mts";
import type { InspectRepairCandidate } from "../execution/repair-candidate-inspection.mts";
import { matchesSourceRefresh, type ApprovedSourceRefresh } from "./approved-source-refresh.mts";
import { activePrePrAmendment, amendedSpec, amendmentRecoveryBound, type ApprovedPrePrAmendment } from "./pre-pr-amendment.mts";
import { createPrePrAmendmentAuthorization } from "./pre-pr-amendment-authorization.mts";
import { queueWorkerRecovery } from "./worker-recovery.mts";
import { canWaitForDevice, deviceWaitBinding, restoreDeviceWait, type DeviceWait, type LegacyDeviceWait } from "./device-wait.mts";
import { approvedRepairFiles, readRepairDecision, repairDecisionCard, repairFromApproval, repairFromReceipt } from "./delivery-review-repair.mts";
import type { ReviewIssueDelivery } from "./github-delivery-review.mts";
import { type createPlannedIssuePublication, hasPublicationMarker, readPublishedRepair } from "./planned-issue-publication.mts";

export type IssueDeliveryOptions = { specs: ReadonlyMap<number, DeliverySpec>; prepare: PrepareIssue; pollMs: number; conversation?: boolean;
  inspectRepairCandidate?: InspectRepairCandidate;
  executionMode?: "device" | "local";
  hasAnyWorkerAttempt?: (repo: string, issue: number) => boolean;
  hasIssueExecutionHistory?: (subject: string) => boolean;
  recoverDeviceWait?: LegacyDeviceWait;
  requireQuality?: boolean; recoverFailedIssue?: number; reviewFix?: ApprovedReviewFix; review?: ReviewIssueDelivery;
  reviewFixes?: readonly ApprovedReviewFix[];
  sourceRefresh?: ApprovedSourceRefresh;
  hasWorkerAttempt?: (repo: string, issue: number) => boolean;
  publishRepair?: ReturnType<typeof createPlannedIssuePublication>;
  reviewScopeCurrent?: (claim: Claim) => boolean;
  failedWorkerAttempt?: (scope: WorkerFailureScope) => { id: string; failureStage?: WorkerFailureStage;
    patchDiagnostics?: PatchDiagnostic[];
    isolation?: import("../execution/isolation-evidence.mts").IsolationEvidence; candidateDigest?: string;
    candidateFiles?: import("../execution/code-worker-protocol.mts").CandidateFile[]; candidatePatch?: string;
    candidatePatchDigest?: string } | undefined;
  recoverDeviceTestAttempts?: ReadonlySet<string>;
  recoverCheckedHeads?: Readonly<Record<string, string>>;
  legacyReviewTestFailure?: (subject: string, head: string, repairId: string) => boolean;
  reviewSourceHandoff?: (claim: Claim, proof: SourceHandoff, sources: Record<string, string>, signal: AbortSignal) => Promise<TicketSourceFinding> };

function publisher(tracker: IssueTracker) {
  return (tracker as Partial<DeliveryTracker>).delivery;
}

type Remote = IssueSummary & Pick<IssueDetail, "pulls"> & { syncedAt: number };
type ReviewRepairDecision = { id: string; head: string; decision: "approved" | "declined"; at: number; issue?: number; completedHead?: string };
export type Claim = Remote & {
  requestId: string; claimedBy: string; account: string; phase: keyof typeof phases;
  sessionId?: string; report?: string;
  accountAssignment?: AccountAssignment;
  delivery?: DeliverySpec; approval?: { flowId: string; planId: string; version: number; issueRevision: string; quality?: QualityBinding };
  target?: DeliveryTarget; pull?: IssuePull; prepared?: PreparedDelivery; attemptedCheckedRecovery?: boolean;
  checked?: CheckedIssue;
  observedIssueRevision?: string;
  observedReviewLink?: boolean;
  deliveryReviews?: { observed: string; receipt: DeliveryReviewReceipt; recordedAt?: number }[];
  claimUncertain?: boolean;
  failure?: DeliveryFailure; retryCount?: number; retriedWorkerAttempt?: string; pendingWorkerAttempt?: string;
  recoveryDispatchAttempt?: string; interruptedDevelopment?: boolean;
  recoveredWorkerAttempts?: string[];
  repairContinuation?: RepairContinuation;
  deviceWait?: DeviceWait;
  reviewFix?: { from: string; state: "running" | "publishing" | "complete" | "failed"; pendingHead?: string; base?: string; repairId?: string;
    testFiles?: string[]; retriedTests?: boolean; testFailureNote?: string; testCheckFailed?: boolean; replayedDraft?: FailedReviewDraft;
    replayedCandidate?: { sha256: string; digest: string; files: import("../execution/code-worker-protocol.mts").CandidateFile[] } };
  reviewTestFiles?: string[];
  reviewRepairs?: ReviewRepairDecision[];
  sourceHandoff?: { proof: SourceHandoff; finding: TicketSourceFinding };
  sourceRefresh?: { revision: string; state: "reviewing" | "blocked" | "passed"; woken?: true; amendmentId?: string };
  prePrAmendments?: ApprovedPrePrAmendment[];
};
const phases = { claiming: "正在认领", waiting: "等待上游 PR 合并", checkingSources: "正在核对上游源码",
  waitingDevice: "等待可用的授权设备", deviceOffered: "工单已派发，等待设备开工",
  developing: "Codex 正在开发与测试", readyToPublish: "本地检查通过，等待 GitHub 核对",
  publishing: "正在推送并创建 PR", submitted: "已提交 PR", deliveryFailed: "开发或测试失败",
  running: "Codex 正在核验", done: "核验完成", conflict: "认领冲突", uncertain: "待核对", failed: "核验失败" };
const stageNames = { preflight: "工单状态核对", checkout: "工作区准备", codex: "Codex 运行", dependencies: "依赖安装",
  patch: "补丁校验与应用", tests: "隔离检查", commit: "生成本地提交", publish: "远端发布", legacy: "旧版执行", device: "设备执行" };
const reasonNames = { unavailable: "暂无更细的失败记录", format: "替换格式无效", scope: "涉及未授权文件", redacted: "涉及已脱敏字段",
  apply: "补丁应用失败",
  match: "替换原文无法唯一定位", size: "文件大小超出边界", empty: "没有实际代码差异", "check-failed": "质量命令退出失败",
  "device-failed": "执行设备已确认失败" };

function workerScope(repo: string, c: Claim): WorkerFailureScope | undefined {
  const approved = c.approval;
  if (approved?.quality) return { repo, issue: c.number, issueRevision: approved.issueRevision,
    plan: { flowId: approved.flowId, version: approved.version, flowDigest: approved.quality.flowDigest,
      batchDigest: approved.quality.batchDigest } };
}

function retryable(failure: DeliveryFailure | undefined) {
  return failure?.stage === "tests" && failure.reason === "check-failed"
    || failure?.stage === "patch" && !failure.patchIssue && ["format", "match", "size", "empty"].includes(failure.reason);
}
export class IssueActionError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
function remoteIssue(item: IssueDetail): Remote {
  const { number, title, url, state, assignees, pulls } = item;
  return { number, title, url, state, assignees, pulls, syncedAt: Date.now() };
}

export function createIssueDispatch(tracker: IssueTracker, store: Checkpoint<Claim>, verify: VerifyIssue,
  log: (event: BusinessEvent) => boolean, maxActive: number, memberTrackers: ReadonlyMap<string, IssueTracker> = new Map(), delivery?: IssueDeliveryOptions) {
  // 持久化工作台独占数据库。进程内的认领门位于首个异步查询之前，已启动工单永久按仓库与编号去重。
  const claims = new Map<number, Claim>();
  const abort = new AbortController();
  const jobs = new Set<Promise<void>>();
  const deliveries = new Set<number>();
  const reviewJobs = new Map<number, Promise<void>>();
  const replayPreflights = new Set<number>();
  const reviewUnavailable = new Map<number, string>();
  let pending: { id: string; actor: string; task: Promise<void> } | undefined;
  let refreshing: Promise<void> | undefined;
  let startedSourceRefresh = false;
  let candidates: Remote[] = [];
  const allowedIssues = delivery && new Set(delivery.specs.keys());
  const subject = (number: number) => `${tracker.repo}#${number}`;
  function save(c: Claim, event?: string, patchCheck?: PatchIssue) {
    const { candidatePatch: _candidatePatch, ...safeFailure } = c.failure ?? {};
    if (!store.save(String(c.number), c, event ? { kind: "github.issue", subject: subject(c.number),
      ...(c.approval ? { flowId: c.approval.flowId } : {}), details: {
      action: event, ...c.approval, ...(c.target ? { branch: c.target.branch, head: c.target.head } : {}),
      ...(c.failure ? { failure: safeFailure } : {}), ...(c.retryCount ? { retryCount: c.retryCount } : {}),
      ...(patchCheck ? { patchCheck } : {}),
      ...(c.reviewFix ? { reviewFix: c.reviewFix } : {}),
      ...(c.repairContinuation ? { repairContinuation: c.repairContinuation } : {}),
      ...(c.deviceWait ? { deviceWait: c.deviceWait } : {}),
      ...(event?.startsWith("review-repair-") ? { repair: c.reviewRepairs?.at(-1) } : {}),
      ...(event === "account-assigned" ? { codexAccount: c.accountAssignment } : {}),
      ...(event === "worker-retry-queued" || event === "worker-test-recovery-queued" ? { workerAttempt: c.pendingWorkerAttempt ?? c.retriedWorkerAttempt } : {}),
      ...(event === "worker-redispatched" ? { recoveredAttempt: c.retriedWorkerAttempt, workerAttempt: c.recoveryDispatchAttempt } : {}),
      ...(event?.startsWith("dependency-source-") ? { sourceHandoff: c.sourceHandoff } : {}),
      ...(event === "approved-source-refresh" ? { sourceRefresh: c.sourceRefresh, original: c.delivery?.baseRevision } : {}),
      ...(event === "pre-pr-amendment-authorized" ? { amendment: activePrePrAmendment(c) } : {}),
      ...(activePrePrAmendment(c) ? { amendmentId: activePrePrAmendment(c)?.id } : {}),
      ...(c.pull ? { pull: c.pull.number, ci: c.pull.ci, merge: c.pull.mergeCommit, state: c.pull.state } : {}), actor: c.claimedBy, githubAccount: c.account, phase: c.phase, session: c.sessionId,
    } } : undefined)) throw new IssueActionError(503, "无法保存 GitHub 工单状态。");
    claims.set(c.number, c);
  }
  const reviewVersion = (c: Claim) => {
    const verification = delivery?.review?.version?.(c);
    return JSON.stringify([c.pull?.number, c.pull?.head, c.pull?.baseName, c.approval, c.observedIssueRevision,
      c.observedReviewLink, c.checked?.head === c.pull?.head ? c.checked : undefined, ...(verification ? [verification] : [])]);
  };
  const lastReview = (c: Claim, observed: string) => [...(c.deliveryReviews ?? [])].reverse().find(row => row.observed === observed);
  const activeReviewScope = (c: Claim) => c.observedIssueRevision === c.approval?.issueRevision && c.observedReviewLink === true
    && (delivery?.reviewScopeCurrent?.(c) ?? true);
  function repairProposal(c: Claim) {
    if (!delivery?.publishRepair || !activeReviewScope(c) || !permits(c.claimedBy)) return;
    const connection = memberTrackers.get(c.claimedBy) ?? tracker;
    const remote = publisher(connection);
    if (!connection.creation || !remote?.checkoutPublished || !remote.updatePublished) return;
    const observed = reviewVersion(c);
    const receipt = lastReview(c, observed)?.receipt;
    return receipt && repairFromReceipt(connection.repo, c, receipt);
  }
  function currentRepair(c: Claim) {
    const proposal = repairProposal(c);
    return proposal && "fix" in proposal ? proposal : undefined;
  }
  const continuations = createRepairContinuation({ ...(delivery?.inspectRepairCandidate ? { inspect: delivery.inspectRepairCandidate } : {}), signal: abort.signal,
    current: number => claims.get(number), repair: currentRepair,
    connection: c => (memberTrackers.get(c.claimedBy) ?? tracker) as DeliveryTracker, save,
    track(job) { jobs.add(job); void job.then(() => jobs.delete(job), () => jobs.delete(job)); },
    start: (fix, prepared) => startReviewFix(fix, false, undefined, prepared) });
  function repairDecisions(actor: string) {
    return [...claims.values()].flatMap(c => {
      if (c.claimedBy !== actor || c.reviewFix?.from === c.pull?.head) return [];
      const repair = currentRepair(c);
      if (!repair || c.reviewRepairs?.some(entry => entry.head === repair.fix.head)) return [];
      return [{ repair, claim: c }];
    });
  }
  function queueReview(c: Claim, connection: IssueTracker, remote: NonNullable<ReturnType<typeof publisher>>, retry: boolean) {
    const review = delivery?.review;
    if (!review || !remote.reviewChanges || !c.approval?.quality || !c.pull?.head || reviewJobs.size >= maxActive || reviewJobs.has(c.number)) return;
    if (!activeReviewScope(c)) return;
    const observed = reviewVersion(c);
    const prior = lastReview(c, observed)?.receipt;
    if (prior && (!retry || prior.implementation && prior.requirements)) return;
    if (reviewUnavailable.get(c.number) === observed && !retry) return;
    reviewUnavailable.delete(c.number);
    const unavailable = () => {
      const latest = claims.get(c.number);
      if (!latest || abort.signal.aborted || reviewVersion(latest) !== observed || !activeReviewScope(latest)) return;
      reviewUnavailable.set(c.number, observed);
      log({ kind: "github.issue", subject: subject(c.number), flowId: c.approval?.flowId, details: {
        action: "delivery-review-unavailable", pull: c.pull?.number, head: c.pull?.head,
      } });
    };
    const job = review(c, connection, remote, abort.signal).then(receipt => {
      const latest = claims.get(c.number);
      if (!latest || abort.signal.aborted || reviewVersion(latest) !== observed || !activeReviewScope(latest)) return;
      if (!receipt) { unavailable(); return; }
      save({ ...latest, deliveryReviews: [...(latest.deliveryReviews ?? []), { observed, receipt, recordedAt: Date.now() }] },
        `delivery-review-${receipt.status}`);
    }).catch(unavailable).finally(() => { reviewJobs.delete(c.number); });
    reviewJobs.set(c.number, job);
  }
  function queueRetry(c: Claim) {
    // 进入远端发布后的尝试只能核对回执。重试沿用原工单的持久化授权和源码版本。
    if (!delivery?.conversation || c.sourceRefresh || c.phase !== "deliveryFailed" || c.target || c.pull || c.pulls.length
      || !c.delivery?.baseRevision || !qualityBindingCurrent(c.approval?.quality)) return;
    // 远端设备一旦接过工单，主机复验失败不能隐式重新启动另一轮 Codex。
    if (delivery.hasWorkerAttempt?.(tracker.repo, c.number)) return;
    const selected = delivery.recoverFailedIssue === c.number;
    // 旧版的一次重试可能已耗尽，但当时尚未引入补丁接收与纠正。只恢复显式选中的旧记录一次。
    const oldFormat = selected && c.retryCount === 1 && c.failure?.stage === "patch" && c.failure.reason === "format" && !c.failure.patchIssue;
    if (!oldFormat && (c.retryCount || !(selected && !c.failure) && !retryable(c.failure))) return;
    save({ ...c, phase: "waiting", retryCount: oldFormat ? 2 : 1, failure: c.failure ?? { stage: "legacy", reason: "unavailable" } },
      oldFormat ? "patch-recovery-queued" : "retry-queued");
  }
  const queueWorkerRetry = (c: Claim) => queueWorkerRecovery(c, { delivery, repo: tracker.repo, workerScope, save });
  for (const c of store.load()) {
    const waiting = restoreDeviceWait(tracker.repo, c, delivery);
    if (waiting) save(waiting, c.deviceWait ? "device-wait-restored" : "legacy-device-wait-restored");
    else if (["waitingDevice", "deviceOffered"].includes(c.phase)) save({ ...c, phase: "uncertain" }, "device-wait-needs-reconciliation");
    else if (c.reviewFix?.state === "running") save({ ...c, reviewFix: { ...c.reviewFix, state: "failed" } }, "review-fix-interrupted");
    else if ((c.pendingWorkerAttempt || c.retryCount === 1 && c.retriedWorkerAttempt) && c.sourceRefresh && c.phase === "developing") {
      save({ ...c, phase: "uncertain" }, "source-refresh-restarted-before-offer");
    }
    else if (c.sourceRefresh && c.phase === "developing" && !c.sessionId && delivery?.hasWorkerAttempt?.(tracker.repo, c.number) === false) {
      save({ ...c, phase: "uncertain" }, "dependency-source-restarted");
    }
    else if (c.phase === "checkingSources") save({ ...c,
      phase: c.sourceRefresh || c.sourceHandoff?.finding.status === "block" ? "uncertain" : "waiting" }, "dependency-source-restarted");
    else if (["claiming", "running", "developing", "publishing"].includes(c.phase)) {
      save({ ...c, phase: "uncertain", ...(c.phase === "claiming" ? { claimUncertain: true } : {}),
        ...(c.phase === "developing" ? { interruptedDevelopment: true } : {}) }, "restart");
    }
    else {
      claims.set(c.number, c);
      queueRetry(c);
    }
  }
  function snapshot(canClaim: boolean) {
    return { repo: tracker.repo, canClaim: canClaim && !delivery?.conversation, ...(delivery ? { deliveryEnabled: true, conversationEnabled: delivery.conversation === true } : {}), items: [
      ...[...claims.values()].reverse().map(({ requestId: _id, account: _account, phase, delivery, pull, approval, failure,
        checked: _checked, deliveryReviews: _reviews, reviewRepairs: _repairs, sourceHandoff: _sourceHandoff, sourceRefresh: _sourceRefresh,
        observedIssueRevision: _issueRevision, observedReviewLink: _reviewLink, retriedWorkerAttempt: _retriedWorkerAttempt,
        pendingWorkerAttempt: _pendingWorkerAttempt, recoveryDispatchAttempt: _recoveryDispatchAttempt,
        recoveredWorkerAttempts: _recoveredWorkerAttempts,
        interruptedDevelopment: _interruptedDevelopment, prepared: _prepared, attemptedCheckedRecovery: _attemptedCheckedRecovery,
        reviewTestFiles: _reviewTestFiles,
        deviceWait: _deviceWait,
        ...item }) => ({ ...item,
        ...(delivery ? { dependsOn: delivery.dependsOn, mode: "delivery" } : {}),
        ...(approval ? { flowId: approval.flowId } : {}),
        ...(failure ? { failureMessage: `${stageNames[failure.workerStage ?? failure.stage]} · ${reasonNames[failure.reason]}`,
          ...(failure.isolation || failure.patchDiagnostics ? { failureEvidence: {
            summary: [failure.isolation && describeIsolationEvidence(failure.isolation),
              failure.patchDiagnostics && describePatchDiagnostics(failure.patchDiagnostics)].filter(Boolean).join("；"),
            diagnostics: failure.isolation?.diagnostics ?? [],
            ...(failure.candidateDigest ? { candidateDigest: failure.candidateDigest } : {}),
            ...(failure.candidateFiles ? { candidateFiles: failure.candidateFiles.map(file => ({ path: file.path,
              before: file.before, after: file.after, mode: file.mode })) } : {}),
          } } : {}) } : {}),
        pulls: pull ? [...item.pulls.filter(other => other.number !== pull.number), pull] : item.pulls,
        progress: item.reviewFix?.state === "running" ? "Codex 正在续修 PR"
          : item.reviewFix?.state === "publishing" ? "正在核对续修发布"
          : item.reviewFix?.state === "failed" ? "PR 续修失败"
          : phase === "waiting" && item.retryCount ? "等待自动重试" : phases[phase] })),
      ...candidates.filter(c => !claims.has(c.number)).map(c => ({ ...c, progress: "待认领" })),
    ] };
  }
  async function refresh() {
    const entries = [...claims.values()];
    const available = delivery?.conversation ? [] : await tracker.candidates(new Set(claims.keys()), allowedIssues);
    for (const prev of entries) {
      const observed = remoteIssue(await tracker.read(prev.number));
      const current = claims.get(prev.number);
      if (current && current.phase !== "claiming" && current.syncedAt <= prev.syncedAt) save({ ...current, ...observed });
    }
    candidates = available.filter(c => !delivery || delivery.specs.has(c.number)).map(c => ({ ...c, pulls: [], syncedAt: Date.now() }));
  }
  async function execute(c: Claim, item: IssueDetail) {
    const current = () => claims.get(c.number) ?? c;
    let report: string | undefined;
    try {
      report = await verify(item, id => save({ ...current(), sessionId: id }, "connected"), abort.signal,
        accountAssignment => save({ ...current(), accountAssignment }, "account-assigned"));
      save({ ...current(), phase: "done", report }, "completed");
    } catch (error) {
      const uncertain = abort.signal.aborted || error instanceof IssueVerificationUncertain || report !== undefined;
      const stopped: Claim = { ...current(), ...(report === undefined ? {} : { report }), phase: uncertain ? "uncertain" : "failed" };
      try { save(stopped, uncertain ? "reconcile" : "failed"); }
      catch { claims.set(c.number, { ...stopped, phase: "uncertain" }); }
    }
  }
  async function acquire(id: string, actor: string, connection: IssueTracker, account: string,
    issue: IssueDetail, spec?: DeliverySpec, approval?: Claim["approval"]) {
    if (claims.has(issue.number)) throw new IssueActionError(409, "Issue 已在工作台处理。");
    if (issue.state !== "OPEN" || issue.assignees.length) throw new IssueActionError(409, "Issue 已关闭或已有人负责，请刷新。");
    abort.signal.throwIfAborted();
    if (spec && !publisher(connection)) throw new IssueActionError(503, "连接不支持工单交付。");
    let c: Claim = { ...remoteIssue(issue), requestId: id, claimedBy: actor, account, phase: "claiming",
      ...(spec ? { delivery: spec } : {}), ...(approval ? { approval } : {}) };
    save(c, "reserved");
    try {
      await connection.assign(c.number, account);
      const observed = await connection.read(c.number);
      c = { ...c, ...remoteIssue(observed) };
      if (!stillAssignee(c, observed)) {
        save({ ...c, phase: "conflict" }, "conflict");
        throw new IssueActionError(409, "回读负责人冲突或 Issue 已关闭，已停止派发。");
      }
      abort.signal.throwIfAborted();
      if (spec) {
        save({ ...c, phase: "waiting" }, "queued");
        return;
      }
      c = { ...c, phase: "running" };
      save(c, "dispatched");
      const job = execute(c, observed);
      jobs.add(job);
      void job.finally(() => jobs.delete(job));
    } catch (error) {
      if (claims.get(c.number)?.phase === "conflict") throw error;
      save({ ...c, phase: "uncertain", claimUncertain: true }, "reconcile");
      throw new IssueActionError(503, "认领结果待核对，请刷新 GitHub 状态。");
    }
  }
  function stillAssignee(c: Claim, issue: IssueDetail) {
    return issue.state === "OPEN" && (!c.approval || c.approval.issueRevision === issueRevision(issue)) && issue.assignees.length === 1
      && issue.assignees[0]?.toLowerCase() === c.account.toLowerCase();
  }
  function confirmReviewFix(c: Claim, pull: IssuePull, target: DeliveryTarget) {
    const state = c.reviewFix;
    const head = pull.head;
    if (state?.state !== "publishing" || !state.pendingHead || head !== state.pendingHead
      || !state.base || pull.baseName !== state.base || pull.number !== c.pull?.number) return;
    const reviewRepairs = state.repairId ? c.reviewRepairs?.map(item => item.id === state.repairId ? { ...item, completedHead: head } : item) : c.reviewRepairs;
    const { failure: _resolvedFailure, ...resolved } = c;
    save({ ...resolved, target: { ...target, head, base: state.base }, pull, reviewFix: { ...state, state: "complete" },
      ...(state.testFiles?.length ? { reviewTestFiles: [...new Set([...(c.reviewTestFiles ?? []), ...state.testFiles])] } : {}),
      ...(reviewRepairs ? { reviewRepairs } : {}) }, "review-fix-published");
  }
  function authorizedRepair(retry: boolean) {
    for (const claim of claims.values()) {
      if (continuations.owns(claim)) continue;
      const repair = currentRepair(claim);
      const decision = repair && claim.reviewRepairs?.find(item => item.id === repair.id && item.decision === "approved");
      if (!repair || !decision) continue;
      const started = claim.reviewFix;
      // 建单回执未知时只能续办同一次发布。执行开始后沿用原有的单次续修规则。
      const recoverable = retry && started?.repairId === repair.id && started.state === "failed" && decision.issue === undefined;
      const autoCorrection = retry && started?.repairId === repair.id && started.state === "failed" && started.testCheckFailed
        && !started.retriedTests && !!claim.failure?.candidatePatch;
      if (started?.from !== repair.fix.head || recoverable || autoCorrection) return { repair, decision };
    }
  }
  function dispatchReviewFix(retry = false) {
    if (!delivery?.conversation || jobs.size >= maxActive) return;
    for (const claim of claims.values()) {
      if (jobs.size >= maxActive) break;
      continuations.enqueue(claim);
    }
    if (jobs.size >= maxActive) return;
    const authorized = authorizedRepair(retry);
    if (authorized) startReviewFix(authorized.repair.fix, retry, authorized);
    const configured = delivery.reviewFixes ?? (delivery.reviewFix ? [delivery.reviewFix] : []);
    for (const fix of configured) {
      if (jobs.size >= maxActive) break;
      startReviewFix(fix, retry);
    }
  }
  function startReviewFix(fix: ApprovedReviewFix, retry: boolean, authorized?: ReturnType<typeof authorizedRepair>, automatic?: PreparedRepairContinuation) {
    if (!delivery) return;
    const c = claims.get(fix.issue);
    if (c && !automatic && continuations.owns(c)) return;
    const target = c?.target;
    const approved = c?.delivery;
    const scope = c && approvedRepairFiles(c);
    if (c?.phase !== "submitted" || !target || target.head !== fix.head || c.pull?.number !== fix.pull
      || (target.base && target.base !== fix.base)
      || !approved?.baseRevision || !qualityBindingCurrent(c.approval?.quality)
      || !scope || !fix.files.every(path => scope.includes(path)) || !permits(c.claimedBy)) return;
    const replay = automatic ?? (fix.repairId ? selectApprovedRepairReplay(c, fix, currentRepair(c)) : undefined);
    if (fix.repairId && (!replay || replayPreflights.has(c.number))) return;
    const supplemental = !authorized && !replay && fix.testFiles?.length ? repairFromApproval(tracker.repo, c, fix) : undefined;
    if (fix.testFiles?.length && (!replay && !supplemental || !activeReviewScope(c) || !delivery.publishRepair)) return;
    const repair = authorized?.repair ?? replay?.repair ?? supplemental;
    const autoCorrection = !!(authorized && retry && c.reviewFix?.repairId === repair?.id && c.reviewFix?.state === "failed"
      && c.reviewFix?.testCheckFailed && !c.reviewFix?.retriedTests && c.failure?.candidatePatch);
    const recorded = supplemental && c.reviewRepairs?.find(item => item.id === supplemental.id);
    const repeatLink = retry && supplemental && c.reviewFix?.repairId === supplemental.id && c.reviewFix.state === "failed" && !recorded?.issue;
    const priorTestFailure = !!(fix.testFailureNote && recorded?.issue && supplemental && c.reviewFix?.from === fix.head
      && c.reviewFix.repairId === supplemental.id && c.reviewFix.state === "failed"
      && (c.reviewFix.testCheckFailed ?? delivery.legacyReviewTestFailure?.(subject(c.number), fix.head, supplemental.id)));
    const replayDraft = replay || priorTestFailure && c.reviewFix?.retriedTests && !c.reviewFix.replayedDraft ? fix.failedDraft : undefined;
    const repeatTests = priorTestFailure && !c.reviewFix?.retriedTests && !fix.failedDraft;
    if ((fix.testFailureNote && !repeatTests && !replayDraft)
      || (!authorized && c.reviewFix?.from === fix.head && !repeatLink && !repeatTests && !replayDraft)) return;
    const connection = memberTrackers.get(c.claimedBy) ?? tracker;
    const remote = publisher(connection);
    if (!remote?.checkoutPublished || !remote.updatePublished) return;
    const update = remote.updatePublished;
    const state = { from: fix.head, state: "running" as const, ...(repair ? { repairId: repair.id } : {}),
      ...(fix.testFiles ? { testFiles: fix.testFiles } : {}),
      ...(autoCorrection && c.failure?.isolation
        ? { retriedTests: true, testFailureNote: describeIsolationEvidence(c.failure.isolation) } : {}),
      ...((repeatTests || replayDraft) && fix.testFailureNote ? { retriedTests: true, testFailureNote: scrubAuditText(fix.testFailureNote) } : {}),
      ...(replay ? { replayedCandidate: { sha256: replay.candidate.sha256, digest: replay.candidate.digest, files: replay.candidate.files } } : {}),
      ...(replayDraft ? { replayedDraft: replayDraft } : {}) };
    if (supplemental && !recorded) save({ ...c, reviewRepairs: [...(c.reviewRepairs ?? []),
      { id: supplemental.id, head: fix.head, decision: "approved", at: Date.now() }] }, "review-repair-maintainer-approved");
    const markStarted = () => save({ ...(claims.get(c.number) ?? c), reviewFix: state,
      ...(automatic ? { repairContinuation: { ...automatic.previous, rounds: [...automatic.previous.rounds,
        { failure: automatic.failure, diagnostics: automatic.diagnostics, candidate: automatic.candidate.digest }] } } : {}) },
      replayDraft ? "review-fix-draft-replay-started" : repeatTests ? "review-fix-test-retry-started" : "review-fix-started");
    if (replay) replayPreflights.add(c.number);
    else markStarted();
    const current = () => claims.get(c.number) ?? c;
    let autoCorrectionNeeded = false;
    const verify = async () => {
      const [account, issue, pull] = await Promise.all([
        connection.account(), connection.read(c.number), remote.find(target.branch, fix.head, fix.pull),
      ]);
      if (account.toLowerCase() !== c.account.toLowerCase() || !stillAssignee(c, issue)
        || !issue.pulls.some(item => item.number === fix.pull) || pull?.state !== "OPEN"
        || pull.head !== fix.head || pull.baseName !== fix.base
        || ((authorized || replay) && currentRepair(current())?.id !== repair?.id)
        || (supplemental && !activeReviewScope(current()))) {
        throw Error("PR 或原工单授权已变化。");
      }
      if (replay) {
        const decision = current().reviewRepairs?.find(row => row.id === replay.repair.id && row.decision === "approved");
        if (decision?.head !== fix.head || decision.issue !== replay.issue || decision.completedHead) throw Error("原修复授权已变化。");
        await readPublishedRepair(replay.repair.batch, connection, replay.issue);
      }
      return pull.baseName;
    };
    const job = (async () => {
      try {
        const base = await verify();
        if (replay) {
          abort.signal.throwIfAborted();
          // 只读预检断连尚未开工，不消耗候选；异步期间的授权与失败回执必须仍完全一致。
          if (automatic ? failureFingerprint(current()) !== automatic.failure
            || !isDeepStrictEqual(continuationBinding(current(), currentRepair(current())), { repair: automatic.repair, issue: automatic.issue })
            : !isDeepStrictEqual(selectApprovedRepairReplay(current(), fix, currentRepair(current())), replay)) {
            throw Error("固定候选恢复授权已变化。");
          }
          markStarted();
        }
        if (repair && !replay) {
          const issued = await delivery.publishRepair?.(repair.batch, connection, abort.signal, c.account);
          const issue = issued?.get("REPAIR");
          if (issue?.state !== "OPEN") throw Error("关联修复 Issue 未确认或已关闭。");
          const latest = current();
          const reviewRepairs = latest.reviewRepairs?.map(item => item.id === repair.id ? { ...item, issue: issue.number } : item) ?? [];
          save({ ...latest, reviewRepairs }, "review-repair-linked");
          await verify();
        }
        const prepared = await delivery.prepare({
          number: c.number, spec: { ...approved, files: [...fix.files, ...(fix.testFiles ?? [])],
            instructions: [`只处理本轮评审要求。\n${fix.instructions}`,
              ...(state.testFailureNote && !autoCorrection ? [`上次同一修订的隔离检查诊断（仅供纠正）：${state.testFailureNote}`] : [])].join("\n") },
          ...(autoCorrection && c.failure?.candidatePatch && c.failure.candidatePatchDigest
            ? { previousCandidate: { patch: c.failure.candidatePatch, sha256: c.failure.candidatePatchDigest } } : {}),
          ...(autoCorrection && c.failure ? { previousFailure: c.failure } : {}),
          branch: target.branch, upstream: [], publisher: remote, reviewTarget: { ...target, base: fix.base },
          ...(replayDraft && fix.testFiles ? { failedReviewDraft: { ...replayDraft, testFiles: fix.testFiles,
            ...(replay ? { evidence: replay.candidate } : {}) } } : {}),
          ...(c.approval ? { flowId: c.approval.flowId, planVersion: c.approval.version } : {}),
          repairing: diagnostic => save(current(), "patch-repair", diagnostic),
        }, sessionId => save({ ...current(), sessionId }, "review-fix-connected"), abort.signal,
        accountAssignment => save({ ...current(), accountAssignment }, "account-assigned"));
        if (prepared.base !== base || await verify() !== base) throw Error("PR 目标已变化。");
        abort.signal.throwIfAborted();
        save({ ...current(), ...(prepared.checked ? { checked: prepared.checked } : {}),
          reviewFix: { ...state, state: "publishing", pendingHead: prepared.head, base } }, "review-fix-checked");
        const pull = await update({ workspace: prepared.workspace, branch: target.branch,
          from: fix.head, head: prepared.head, pull: fix.pull, base }, abort.signal);
        confirmReviewFix(current(), pull, target);
      } catch (error) {
        const latest = current();
        // 开始推送后只回读 GitHub，避免因响应丢失重复推送。
        if (latest.reviewFix?.state === "running") {
          const failure = error instanceof IssueDeliveryFailed ? error.failure : undefined;
          save({ ...latest, reviewFix: { ...state, state: "failed",
            testCheckFailed: failure?.stage === "tests" && failure.reason === "check-failed" },
            ...(failure ? { failure } : {}) }, "review-fix-failed");
          if (failure?.stage === "tests" && failure.reason === "check-failed" && failure.candidatePatch && (!state.retriedTests || automatic)) {
            autoCorrectionNeeded = true;
          }
        }
      }
    })();
    jobs.add(job);
    void job.then(() => {
      replayPreflights.delete(c.number);
      jobs.delete(job);
      if (autoCorrectionNeeded && !abort.signal.aborted) dispatchReviewFix(true);
    }, () => { replayPreflights.delete(c.number); jobs.delete(job); });
  }
  async function develop(c: Claim, spec: DeliverySpec, upstream: string[], recoverCheckedHead?: string) {
    const connection = memberTrackers.get(c.claimedBy) ?? tracker;
    const remote = publisher(connection);
    const current = () => claims.get(c.number) ?? c;
    const producers = async (baseName: string, signal: AbortSignal) => {
      signal.throwIfAborted();
      if (!remote || !c.approval?.quality || !delivery?.reviewScopeCurrent?.(current())) throw new IssueDeliverySourcesChanged();
      const groups = new Map<number, string[]>();
      for (const { issue, path } of spec.sourceFrom ?? []) {
        if (!spec.dependsOn.includes(issue) || !spec.sourcePaths?.includes(path)) throw new IssueDeliverySourcesChanged();
        groups.set(issue, [...(groups.get(issue) ?? []), path]);
      }
      return Promise.all([...groups].map(async ([issue, sources]): Promise<SourceProducer> => {
        const parent = claims.get(issue);
        const target = parent?.target;
        const pull = parent?.pull;
        if (!parent?.delivery || !parent.approval || parent.requestId !== c.requestId || parent.claimedBy !== c.claimedBy
          || parent.account !== c.account || !isDeepStrictEqual(parent.approval.quality, c.approval?.quality)
          || parent.delivery.baseRevision !== spec.baseRevision || !target || !pull || pull.state !== "MERGED"
          || !pull.mergeCommit || !upstream.includes(pull.mergeCommit) || pull.baseName !== baseName || pull.head !== target.head
          || sources.some(path => !parent.delivery?.files.includes(path))) throw new IssueDeliverySourcesChanged();
        const [livePull, liveIssue] = await Promise.all([remote.find(target.branch, target.head, pull.number), connection.read(issue)])
          .catch(() => { throw new IssueDeliverySourcesChanged(); });
        signal.throwIfAborted();
        if (claims.get(issue)?.target !== target || livePull?.number !== pull.number || livePull.head !== target.head
          || livePull.state !== "MERGED" || livePull.baseName !== baseName || livePull.mergeCommit !== pull.mergeCommit
          || issueRevision(liveIssue) !== parent.approval.issueRevision || !liveIssue.pulls.some(item => item.number === pull.number)) {
          throw new IssueDeliverySourcesChanged();
        }
        return { issue, pull: pull.number, head: target.head, merge: pull.mergeCommit, baseName, files: parent.delivery.files, sources };
      }));
    };
    try {
      if (!remote || !delivery || !permits(c.claimedBy)) throw new IssueDeliverySourcesChanged();
      if (!c.prepared) {
        if ((await connection.account()).toLowerCase() !== c.account.toLowerCase()) throw new IssueDeliverySourcesChanged();
        const issue = await connection.read(c.number);
        if (!stillAssignee(c, issue) || issue.pulls.length) throw new IssueDeliverySourcesChanged();
      }
      if (c.approval && delivery.reviewScopeCurrent && !delivery.reviewScopeCurrent(current())) {
        throw new IssueDeliverySourcesChanged();
      }
      const scope = workerScope(connection.repo, c);
      const branch = c.prepared?.branch ?? `feat/${c.number}-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
      const prepared = c.prepared ?? await delivery.prepare({ number: c.number, spec, branch, publisher: remote, upstream,
        ...(c.deviceWait ? { requireDevice: true as const } : {}),
        ...(recoverCheckedHead ? { recoverCheckedHead } : {}),
        ...(c.failure && (c.retryCount || c.pendingWorkerAttempt) ? { previousFailure: c.failure } : {}),
        ...(spec.sourceFrom?.length && delivery.reviewSourceHandoff ? { sourceHandoff: {
          ...(c.sourceRefresh ? { refreshRevision: c.sourceRefresh.revision } : {}),
          ...(c.pendingWorkerAttempt && c.recoveryDispatchAttempt === c.pendingWorkerAttempt && c.sourceRefresh
            && amendmentRecoveryBound(c, c.pendingWorkerAttempt, c.sourceRefresh.revision)
            ? { reuseApprovedRevision: true as const } : {}),
          current: producers,
          ready() {
            abort.signal.throwIfAborted();
            const latest = current();
            if (latest.phase !== "checkingSources" || !delivery.reviewScopeCurrent?.(latest)) throw new IssueDeliverySourcesChanged();
            const pendingAttempt = c.pendingWorkerAttempt ?? c.retriedWorkerAttempt;
            const recoveringAttempt = !!pendingAttempt && delivery.sourceRefresh?.attemptId === pendingAttempt;
            if (c.sourceRefresh && (latest.sourceHandoff?.finding.status !== "pass"
              || latest.sourceHandoff.proof.execution !== c.sourceRefresh.revision
              || (recoveringAttempt ? !delivery.hasWorkerAttempt?.(connection.repo, c.number)
                : delivery.hasWorkerAttempt?.(connection.repo, c.number) !== false))) {
              throw new IssueDeliverySourcesChanged();
            }
            if (recoveringAttempt && pendingAttempt) {
              const scope = workerScope(connection.repo, latest);
              if (!scope || delivery.failedWorkerAttempt?.(scope)?.id !== pendingAttempt
                || !delivery.recoverDeviceTestAttempts?.has(pendingAttempt)) throw new IssueDeliverySourcesChanged();
            }
            save({ ...latest, ...(c.sourceRefresh ? { sourceRefresh: { ...c.sourceRefresh, state: "passed", woken: true } } : {}),
              phase: c.deviceWait ? "waitingDevice" : "developing" }, recoveringAttempt ? "source-refresh-reviewed" : c.sourceRefresh?.woken ? "source-refresh-resumed" : "woken");
          },
          async review(proof: SourceHandoff, sources: Record<string, string>, signal: AbortSignal) {
            const finding = await delivery.reviewSourceHandoff?.(current(), proof, sources, signal);
            if (!finding || finding.revision !== proof.execution) throw new IssueDeliverySourcesChanged();
            signal.throwIfAborted();
            save({ ...current(), sourceHandoff: { proof, finding } }, `dependency-source-${finding.status}`);
            if (finding.status !== "pass") throw new IssueDeliverySourcesChanged();
          },
        } } : {}),
        repairing: diagnostic => save(current(), "patch-repair", diagnostic),
        ...(scope ? { workerProof: scope,
          async revalidateWorker(signal: AbortSignal) {
            signal.throwIfAborted();
            const latest = await connection.read(c.number);
            const account = await connection.account();
            if (account.toLowerCase() !== c.account.toLowerCase() || !permits(c.claimedBy) || !stillAssignee(c, latest) || latest.pulls.length
              || (delivery.reviewScopeCurrent && !delivery.reviewScopeCurrent(current()))) {
              throw new IssueVerificationUncertain("needs-reconciliation");
            }
            const claim = current();
            if (claim.deviceWait && (delivery.executionMode !== "device"
              || !claim.deviceWait.offered && !canWaitForDevice(connection.repo, claim, delivery)
              || claim.deviceWait.binding !== deviceWaitBinding(connection.repo, claim))) throw new IssueDeliverySourcesChanged();
            if (claim.pendingWorkerAttempt) {
              const recoveryScope = workerScope(connection.repo, claim);
              const sourceReady = claim.phase === "checkingSources" && claim.sourceRefresh?.state === "reviewing"
                && claim.sourceHandoff?.finding.status === "pass"
                || (claim.phase === "developing" || claim.phase === "waitingDevice" && !!claim.deviceWait)
                  && claim.sourceRefresh?.state === "passed";
              if (!recoveryScope || delivery.failedWorkerAttempt?.(recoveryScope)?.id !== claim.pendingWorkerAttempt
                || !delivery.recoverDeviceTestAttempts?.has(claim.pendingWorkerAttempt)
                || claim.deviceWait && claim.deviceWait.offered !== claim.pendingWorkerAttempt
                || !sourceReady) throw new IssueDeliverySourcesChanged();
            }
            signal.throwIfAborted();
          } } : {}),
        ...(c.pendingWorkerAttempt ? { workerOffered: (attemptId: string) => {
          abort.signal.throwIfAborted();
          const pendingAttempt = c.pendingWorkerAttempt;
          const latest = current();
          if (!pendingAttempt || latest.pendingWorkerAttempt !== pendingAttempt
            || (latest.phase !== "developing" && !(latest.phase === "waitingDevice" && latest.deviceWait?.offered === pendingAttempt))
            || latest.sourceRefresh?.state !== "passed") throw new IssueDeliverySourcesChanged();
          const { pendingWorkerAttempt: _pendingWorkerAttempt, ...confirmed } = latest;
          // 明确批准的失败回执沿原恢复门槛消费；新 offer 与旧回执在同次保存中交接。
          save({ ...confirmed, retriedWorkerAttempt: pendingAttempt, recoveryDispatchAttempt: attemptId,
            ...(latest.deviceWait ? { phase: "deviceOffered", deviceWait: { ...latest.deviceWait, offered: attemptId } } : {}),
            recoveredWorkerAttempts: [...new Set([...(latest.recoveredWorkerAttempts ?? []),
              ...(latest.recoveryDispatchAttempt && latest.retriedWorkerAttempt ? [latest.retriedWorkerAttempt] : []), pendingAttempt])],
            retryCount: (latest.recoveryDispatchAttempt ? latest.retryCount ?? 0 : 0) + 1 }, "worker-redispatched");
        } } : c.deviceWait ? { workerOffered: (attemptId: string) => {
          abort.signal.throwIfAborted();
          const latest = current();
          if (latest.phase !== "waitingDevice" || latest.deviceWait?.offered
            || latest.deviceWait?.binding !== deviceWaitBinding(connection.repo, latest)) throw new IssueDeliverySourcesChanged();
          save({ ...latest, phase: "deviceOffered", deviceWait: { ...latest.deviceWait, offered: attemptId } }, "device-offered");
        } } : {}),
        ...(c.approval ? { flowId: c.approval.flowId, planVersion: c.approval.version } : {}) },
        sessionId => { if (current().sessionId !== sessionId) save({ ...current(), sessionId,
          ...(current().deviceWait ? { phase: "developing" as const } : {}) }, "connected"); }, abort.signal,
        accountAssignment => save({ ...current(), accountAssignment }, "account-assigned"));
      if (!c.prepared) {
        abort.signal.throwIfAborted();
        if (current().phase !== "developing") throw new IssueDeliverySourcesChanged();
        save({ ...current(), prepared, phase: "readyToPublish" }, "local-check-complete");
      }
      // 网络读失败时保留已经测试过的提交。重试只重新读取，仍须先写入发布目标再推送。
      const observed = await Promise.all([connection.account(), connection.read(c.number)]).catch(() => undefined);
      if (!observed || abort.signal.aborted) return;
      const [account, checkedIssue] = observed;
      if (account.toLowerCase() !== c.account.toLowerCase() || !stillAssignee(c, checkedIssue)
        || checkedIssue.pulls.length || current().phase !== "readyToPublish") throw new IssueDeliverySourcesChanged();
      const handoff = current().sourceHandoff;
      if (handoff && (handoff.finding.status !== "pass" || handoff.proof.execution !== prepared.executionRevision
        || JSON.stringify(await producers(handoff.proof.producers[0]?.baseName ?? "", abort.signal))
          !== JSON.stringify(handoff.proof.producers))) throw new IssueDeliverySourcesChanged();
      if (!permits(c.claimedBy) || (c.approval && delivery.reviewScopeCurrent && !delivery.reviewScopeCurrent(current()))) {
        throw new IssueDeliverySourcesChanged();
      }
      abort.signal.throwIfAborted();
      const target = { branch, head: prepared.head, base: prepared.base };
      const { prepared: _prepared, ...local } = current();
      save({ ...local, target, ...(prepared.checked ? { checked: prepared.checked } : {}), phase: "publishing" }, "checked");
      const pull = await remote.publish({ ...prepared, branch, issue: c.number, title: `feat(issue): deliver #${c.number}` }, abort.signal);
      save({ ...current(), pull, phase: "submitted" }, "published");
    } catch (error) {
      const last = current();
      if (last.phase === "waitingDevice" && canWaitForDevice(connection.repo, last, delivery)
        && (abort.signal.aborted || error instanceof IssueVerificationUncertain && error.reason === "interrupted")) return;
      const stale = error instanceof IssueDeliverySourcesChanged;
      const refreshingSources = last.sourceRefresh?.state === "reviewing";
      const uncertain = stale || refreshingSources || !!last.target || abort.signal.aborted || error instanceof IssueVerificationUncertain;
      const failure = !refreshingSources && error instanceof IssueDeliveryFailed ? error.failure
        : { stage: last.target ? "publish" as const : "preflight" as const, reason: "unavailable" as const };
      const stopped: Claim = { ...last, phase: uncertain ? "uncertain" : "deliveryFailed", failure };
      if (last.sourceRefresh?.state === "reviewing" && last.sourceHandoff?.proof.execution === last.sourceRefresh.revision
        && last.sourceHandoff.finding.status === "block") stopped.sourceRefresh = { ...last.sourceRefresh, state: "blocked" };
      try {
        save(stopped, stale ? "quality-source-changed" : uncertain ? "reconcile" : "failed");
        queueRetry(stopped);
      }
      catch { claims.set(c.number, { ...stopped, phase: "uncertain" }); }
    }
  }
  function dispatchReady(retryRepairs = false) {
    if (!delivery || abort.signal.aborted) return;
    dispatchReviewFix(retryRepairs);
    for (const item of claims.values()) {
      if (jobs.size >= maxActive) break;
      if (deliveries.has(item.number)) continue;
      const c = queueWorkerRetry(item);
      if (!c.delivery || c.requestId === pending?.id) continue;
      const requestedRecoveryAttempt = delivery.sourceRefresh?.attemptId;
      const claimTracker = memberTrackers.get(c.claimedBy) ?? tracker;
      const recoveryScope = c.pendingWorkerAttempt ? workerScope(claimTracker.repo, c) : undefined;
      const pendingRecoveryReady = !c.pendingWorkerAttempt || (!!requestedRecoveryAttempt
        && requestedRecoveryAttempt === c.pendingWorkerAttempt
        && delivery.recoverDeviceTestAttempts?.has(c.pendingWorkerAttempt)
        && recoveryScope
        && delivery.failedWorkerAttempt?.(recoveryScope)?.id === c.pendingWorkerAttempt);
      const refresh = !startedSourceRefresh && pendingRecoveryReady && delivery.sourceRefresh && matchesSourceRefresh(c, delivery.sourceRefresh)
        && delivery.reviewScopeCurrent?.(c) && delivery.reviewSourceHandoff
        && (delivery.sourceRefresh.attemptId ? c.pendingWorkerAttempt === delivery.sourceRefresh.attemptId
          : delivery.hasWorkerAttempt?.(tracker.repo, c.number) === false) ? delivery.sourceRefresh : undefined;
      // 旧版重派记录没有单独的 pending 标记。无论当前失败阶段或重试计数如何，
      // 只要旧尝试尚未确认完成源码复核后的新派发，就不能落入普通派发路径。
      const legacyRecovery = !c.recoveryDispatchAttempt && ["waiting", "uncertain"].includes(c.phase)
        && !!c.retriedWorkerAttempt;
      if ((c.pendingWorkerAttempt || legacyRecovery) && !refresh) {
        if (c.phase !== "uncertain") save({ ...c, phase: "uncertain" }, "worker-recovery-configuration-required");
        continue;
      }
      const recoverCheckedHead = c.phase === "deliveryFailed" && !c.attemptedCheckedRecovery && !c.target && !c.pull && !c.pulls.length
        && c.failure?.stage === "preflight" && c.failure.reason === "unavailable" && !c.delivery.dependsOn.length
        && delivery.reviewScopeCurrent?.(c) ? delivery.recoverCheckedHeads?.[String(c.number)] : undefined;
      if (c.phase !== "waiting" && c.phase !== "waitingDevice" && c.phase !== "readyToPublish" && !recoverCheckedHead && !refresh) continue;
      if (c.phase === "waitingDevice" && c.deviceWait && (!canWaitForDevice(claimTracker.repo, c, delivery)
        || c.deviceWait.binding !== deviceWaitBinding(claimTracker.repo, c))) continue;
      if (c.approval && !delivery.conversation) continue;
      if (delivery.requireQuality && !qualityBindingCurrent(c.approval?.quality)) {
        save({ ...c, phase: "uncertain" }, "quality-check-required");
        continue;
      }
      if (!c.approval && !isDeepStrictEqual(delivery.specs.get(c.number), c.delivery)) {
        save({ ...c, phase: "uncertain" }, "authorization-changed");
        continue;
      }
      const upstream = c.delivery.dependsOn.map(number => claims.get(number)?.pull);
      if (!upstream.every(pull => pull?.state === "MERGED" && pull.mergeCommit)) continue;
      const checkSources = !!(c.delivery.sourceFrom?.length && delivery.reviewSourceHandoff);
      const amendment = activePrePrAmendment(c);
      const deviceWait = c.deviceWait ?? (canWaitForDevice(claimTracker.repo, c, delivery)
        ? { version: 1 as const, binding: deviceWaitBinding(claimTracker.repo, c) } : undefined);
      const selected: Claim = recoverCheckedHead ? { ...c, attemptedCheckedRecovery: true, phase: "developing" }
        : c.phase === "readyToPublish" ? c : { ...c, ...(refresh ? { sourceRefresh: { ...c.sourceRefresh, revision: refresh.revision, state: "reviewing" } } : {}),
          ...(refresh && amendment ? { sourceRefresh: { ...c.sourceRefresh, revision: refresh.revision,
            state: "reviewing", amendmentId: amendment.id } } : {}),
          ...(deviceWait ? { deviceWait } : {}), phase: checkSources ? "checkingSources" : deviceWait ? "waitingDevice" : "developing" };
      if (selected !== c) save(selected, refresh ? "approved-source-refresh" : recoverCheckedHead ? "checked-recovery-queued" : checkSources ? "dependency-source-checking"
        : c.retriedWorkerAttempt ? "worker-redispatched" : upstream.length ? "woken" : "dispatched");
      if (refresh) startedSourceRefresh = true;
      deliveries.add(c.number);
      const job = develop(selected, amendedSpec(c) ?? c.delivery, upstream.map(pull => pull?.mergeCommit ?? ""), recoverCheckedHead);
      jobs.add(job);
      void job.finally(() => {
        jobs.delete(job);
        deliveries.delete(c.number);
        const pending = claims.get(c.number)?.pendingWorkerAttempt;
        const scope = workerScope(tracker.repo, c);
        if (refresh?.attemptId && pending === refresh.attemptId && scope
          && delivery.failedWorkerAttempt?.(scope)?.id === refresh.attemptId) startedSourceRefresh = false;
      });
    }
  }
  let polling: Promise<void> | undefined;
  async function pollDelivery(retryReviews = false) {
    if (abort.signal.aborted) return;
    let unavailable = false;
    for (const prior of [...claims.values()]) {
      if (!prior.target || (prior.phase !== "uncertain" && prior.phase !== "submitted")) continue;
      if (prior.reviewFix?.state === "running") continue;
      const connection = memberTrackers.get(prior.claimedBy) ?? tracker;
      const remote = publisher(connection);
      if (!remote) continue;
      const checkIssue = delivery?.review && remote.reviewChanges && prior.approval?.quality;
      // 已合并的工单可能仍在等复核执行位，继续回读其关联。
      if (!checkIssue && prior.pull?.state === "MERGED" && prior.state === "CLOSED"
        && ["SUCCESS", "FAILURE", "ERROR"].includes(prior.pull.ci ?? "")) continue;
      const pulled = await remote.find(prior.target.branch, prior.target.head, prior.pull?.number)
        .then(pull => ({ pull, failed: false }), () => ({ pull: undefined, failed: true }));
      unavailable ||= pulled.failed;
      const { pull } = pulled;
      if (!pull) continue;
      const issue = checkIssue || (pull.state === "MERGED" && prior.state !== "CLOSED")
        ? await connection.read(prior.number).catch(() => undefined) : undefined;
      const c = claims.get(prior.number);
      if (!c || c.target !== prior.target || abort.signal.aborted) continue;
      if (c.reviewFix?.state === "publishing") {
        confirmReviewFix(c, pull, prior.target);
        continue;
      }
      const changed = JSON.stringify(c.pull) !== JSON.stringify(pull);
      const observedIssueRevision = issue && checkIssue ? issueRevision(issue) : c.observedIssueRevision;
      const observedReviewLink = issue && checkIssue ? issue.pulls.some(other => other.number === pull.number) : c.observedReviewLink;
      if (changed || c.phase !== "submitted" || (issue && issue.state !== c.state) || observedIssueRevision !== c.observedIssueRevision
        || observedReviewLink !== c.observedReviewLink) {
        save({ ...c, ...(issue ? remoteIssue(issue) : {}), pull, phase: "submitted", syncedAt: Date.now(),
          ...(observedIssueRevision ? { observedIssueRevision } : {}), ...(observedReviewLink === undefined ? {} : { observedReviewLink }) },
          changed ? "pull-sync" : undefined);
      }
      const latest = claims.get(c.number);
      if (latest?.phase === "submitted" && issue) queueReview(latest, connection, remote, retryReviews);
    }
    dispatchReady(retryReviews);
    if (unavailable) throw Error("部分 GitHub PR 暂时无法读取。");
  }
  function syncDelivery(retryReviews = false): Promise<void> {
    if (retryReviews && polling) return polling.catch(() => undefined).then(() => syncDelivery(true));
    polling ??= pollDelivery(retryReviews).finally(() => { polling = undefined; });
    return polling;
  }
  const timer = delivery && setInterval(() => {
    void syncDelivery().catch(() => undefined);
  }, delivery.pollMs);
  timer?.unref();
  function permits(actor: string) {
    return !memberTrackers.size || memberTrackers.has(actor);
  }
  const amendments = createPrePrAmendmentAuthorization({ claim: number => claims.get(number), save,
    connection: actor => memberTrackers.get(actor) ?? tracker, delivery, permits, busy: number => deliveries.has(number), dispatch: dispatchReady,
    latestFailure(c) { const scope = workerScope(tracker.repo, c); return scope && delivery?.failedWorkerAttempt?.(scope); } });
  return {
    snapshot, permits,
    amendmentClaim(number: number) { const c = claims.get(number); return c && structuredClone(c); },
    amendmentCandidate: amendments.candidate, authorizeAmendment: amendments.authorize,
    repairCards(actor: string) {
      return repairDecisions(actor).map(({ repair, claim }) => repairDecisionCard(repair, claim.syncedAt));
    },
    hasRepair(id: string) {
      return [...claims.values()].some(claim => claim.reviewRepairs?.some(item => item.id === id) || currentRepair(claim)?.id === id);
    },
    answerRepair(id: string, actor: string, input: unknown) {
      const selected = repairDecisions(actor).find(({ repair }) => repair.id === id);
      if (!selected) return 409;
      const decision = readRepairDecision(input);
      if (!decision) return 422;
      const { claim, repair } = selected;
      const record = { id, head: repair.fix.head, decision, at: Date.now() };
      try {
        save({ ...claim, reviewRepairs: [...(claim.reviewRepairs ?? []), record] }, `review-repair-${decision}`);
      } catch { return 503; }
      if (decision === "approved") void syncDelivery().catch(() => undefined);
      return 200;
    },
    reviewStatus(flowId: string, actor: string, sharedReviewer = false) {
      return [...claims.values()].filter(c => c.approval?.flowId === flowId && (sharedReviewer || c.claimedBy === actor) && c.pull?.head)
        .map(c => {
          const observed = reviewVersion(c);
          const current = activeReviewScope(c);
          const proposedRepair = repairProposal(c);
          const repairs = c.reviewRepairs?.filter(item => item.decision === "approved").map(({ head, issue, id, completedHead }) =>
            ({ head, issue, completedHead, state: c.reviewFix?.repairId === id ? c.reviewFix.state : completedHead ? "complete" : issue ? "linked" : "queued",
              ...(issue ? { url: `https://github.com/${tracker.repo}/issues/${issue}` } : {}) }));
          const latestReview = lastReview(c, observed);
          return { number: c.number, pull: c.pull?.number, head: c.pull?.head, running: reviewJobs.has(c.number),
            ...(repairs?.length ? { repairs } : {}),
            ...(proposedRepair && "reason" in proposedRepair ? { repairUnavailable: proposedRepair.reason } : {}),
            unavailable: reviewUnavailable.get(c.number) === observed
              || !!c.observedIssueRevision && !current, reviews: (c.deliveryReviews ?? [])
              .map(row => ({ ...row.receipt, ...(row.recordedAt ? { recordedAt: row.recordedAt } : {}), current: current && row === latestReview })) };
        });
    },
    async suggest() {
      if (!delivery?.conversation) return [];
      const rows = await tracker.candidates(new Set(claims.keys()));
      const available: IssueDetail[] = [];
      const limit = 8;
      let offset = 0;
      while (offset < rows.length && available.length < limit) {
        const batch = rows.slice(offset, offset + limit - available.length);
        const issues = await Promise.all(batch.map(row => tracker.read(row.number)));
        available.push(...issues.filter(issue => issue.state === "OPEN" && !issue.assignees.length && !issue.pulls.length
          && !claims.has(issue.number) && !hasPublicationMarker(issue.body)));
        offset += batch.length;
      }
      return available;
    },
    async claimApproved(id: string, actor: string, specs: ReadonlyMap<number, DeliverySpec & { issueRevision: string }>,
      approval: Omit<NonNullable<Claim["approval"]>, "issueRevision">, recovering = false) {
      if (!delivery?.conversation || !permits(actor)) throw new IssueActionError(403, "当前成员未获交付权限。");
      if (delivery.requireQuality && !qualityBindingCurrent(approval.quality)) throw new IssueActionError(409, "工单缺少当前质量校验。");
      if (pending) throw new IssueActionError(409, "已有成员正在认领，请重试。");
      const task = (async () => {
        const connection = memberTrackers.get(actor) ?? tracker;
        const account = await connection.account();
        const issues = await Promise.all([...specs.keys()].map(number => connection.read(number)));
        const ready = issues.map(issue => {
          const spec = specs.get(issue.number);
          if (!spec || issueRevision(issue) !== spec.issueRevision) throw new IssueActionError(409, "工单内容已变化，请重新规划。");
          const { issueRevision: revision, ...deliverySpec } = spec;
          const authorization = { ...approval, issueRevision: revision };
          const prior = claims.get(issue.number);
          if (prior && recovering && prior.requestId === id && prior.claimedBy === actor
            && prior.account.toLowerCase() === account.toLowerCase()
            && isDeepStrictEqual(prior.delivery, deliverySpec) && isDeepStrictEqual(prior.approval, authorization)) {
            if (prior.phase === "uncertain" && prior.claimUncertain && stillAssignee(prior, issue)) {
              return { issue, resume: prior, deliverySpec, authorization };
            }
            if (["waiting", "waitingDevice", "deviceOffered", "checkingSources", "developing", "readyToPublish", "publishing", "submitted", "deliveryFailed"].includes(prior.phase)) return undefined;
          }
          if (prior || issue.state !== "OPEN" || issue.assignees.length || issue.pulls.length) {
            throw new IssueActionError(409, "工单状态已变化，请重新规划。");
          }
          return { issue, deliverySpec, authorization };
        });
        for (const entry of ready) {
          if (!entry) continue;
          if (entry.resume) save({ ...entry.resume, ...remoteIssue(entry.issue), phase: "waiting", claimUncertain: false }, "claim-recovered");
          else await acquire(id, actor, connection, account, entry.issue, entry.deliverySpec, entry.authorization);
        }
      })().finally(() => { pending = undefined; });
      pending = { id, actor, task };
      await task;
      dispatchReady();
    },
    refresh() {
      refreshing ??= (async () => { await refresh(); await syncDelivery(true); })().finally(() => { refreshing = undefined; });
      return refreshing;
    },
    async claim(id: string, actor: string) {
      if (delivery?.conversation) throw new IssueActionError(403, "请从对话的待决策授权本轮工单。");
      if (!permits(actor)) throw new IssueActionError(403, "这位成员还未连接 GitHub 执行账号。");
      function audit(action: string) {
        if (!log({ kind: "github.issue", details: { action, actor, requestId: id } })) throw new IssueActionError(503, "无法记录认领请求。");
      }
      const prior = pending?.id === id ? pending.actor : [...claims.values()].find(c => c.requestId === id)?.claimedBy;
      if (prior) {
        if (prior !== actor) {
          audit("conflict");
          throw new IssueActionError(409, "该请求属于另一位成员。");
        }
        audit("replay");
        return pending?.id === id ? pending.task : undefined;
      }
      if (pending || jobs.size >= maxActive) {
        audit("busy");
        throw new IssueActionError(409, pending ? "已有成员正在认领，请刷新工单。" : "执行中的 GitHub 工单达到并发上限。");
      }
      audit("request");
      const task = (async () => {
        const connection = memberTrackers.get(actor) ?? tracker;
        const account = await connection.account();
        const rows = await connection.candidates(new Set(claims.keys()), allowedIssues);
        const next = rows.find(row => !claims.has(row.number) && (!delivery || delivery.specs.has(row.number)));
        if (!next) throw new IssueActionError(409, "当前没有可领取的无人负责 Issue。");
        await acquire(id, actor, connection, account, await connection.read(next.number), delivery?.specs.get(next.number));
        dispatchReady();
      })().finally(() => { pending = undefined; });
      pending = { id, actor, task };
      return task;
    },
    async close() {
      abort.abort();
      clearInterval(timer);
      await Promise.allSettled([pending?.task, refreshing, polling, ...jobs, ...reviewJobs.values(), amendments.close()]);
    },
  };
}
