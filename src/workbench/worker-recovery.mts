import { isDeepStrictEqual } from "node:util";
import { qualityBindingCurrent } from "../planning/dispatch-quality.mts";
import type { WorkerFailureScope } from "../execution/code-worker-pool.mts";
import type { DeliveryFailure } from "../execution/issue-delivery.mts";
import type { Claim, IssueDeliveryOptions } from "./issue-dispatch.mts";
import { matchesSourceRefresh } from "./approved-source-refresh.mts";
import { activePrePrAmendment } from "./pre-pr-amendment.mts";

type RecoveryOptions = {
  delivery: IssueDeliveryOptions | undefined; repo: string;
  workerScope: (repo: string, claim: Claim) => WorkerFailureScope | undefined;
  save: (claim: Claim, action: string) => void;
};

export function queueWorkerRecovery(c: Claim, { delivery, repo, workerScope, save }: RecoveryOptions) {
  const requested = delivery?.sourceRefresh;
  const recoveringPending = !!c.pendingWorkerAttempt;
  const recoveringLegacy = !recoveringPending && !c.recoveryDispatchAttempt && c.retryCount === 1 && !!c.retriedWorkerAttempt
    && requested?.attemptId === c.retriedWorkerAttempt && ["waiting", "uncertain"].includes(c.phase)
    && c.failure?.stage === "device" && c.failure.reason === "device-failed"
    && ["tests", "dependencies"].includes(c.failure.workerStage ?? "");
  const needsReceipt = c.phase === "uncertain"
    && (c.interruptedDevelopment || c.failure?.stage === "preflight" && c.failure.reason === "unavailable"
      || c.failure?.stage === "device" && c.failure.reason === "device-failed");
  const recordedFailure = c.phase === "deliveryFailed" && c.failure?.stage === "device" && c.failure.reason === "device-failed";
  if ((!recoveringPending && !recoveringLegacy && !needsReceipt && !recordedFailure) || !delivery?.conversation || !delivery.failedWorkerAttempt
    || c.claimUncertain || c.target || c.pull || c.pulls.length || !c.delivery?.baseRevision
    || !qualityBindingCurrent(c.approval?.quality) || !delivery.reviewScopeCurrent?.(c)) return c;
  const scope = workerScope(repo, c);
  const attempt = scope && delivery.failedWorkerAttempt(scope);
  if (!attempt) return c;
  const failure: DeliveryFailure = { stage: "device", reason: "device-failed",
    ...(attempt.patchDiagnostics ? { patchDiagnostics: attempt.patchDiagnostics } : {}),
    ...(attempt.failureStage ? { workerStage: attempt.failureStage } : {}), ...(attempt.isolation ? { isolation: attempt.isolation } : {}),
    ...(attempt.candidateDigest ? { candidateDigest: attempt.candidateDigest, candidateFiles: attempt.candidateFiles } : {}),
    ...(attempt.candidatePatch ? { candidatePatch: attempt.candidatePatch, candidatePatchDigest: attempt.candidatePatchDigest } : {}) };
  const { interruptedDevelopment: _interruptedDevelopment, ...resumable } = c;
  const evidenceClaim = isDeepStrictEqual(c.failure, failure) && !c.interruptedDevelopment ? c : { ...resumable, failure };
  const configMatches = requested?.attemptId === attempt.id && requested.issue === c.number
    && requested.requestId === c.requestId && requested.version === c.approval?.version
    && requested.issueRevision === c.approval?.issueRevision;
  const amendment = activePrePrAmendment(c);
  const sourceAlreadyBlocked = c.sourceRefresh?.state === "blocked"
    && (c.sourceRefresh.revision === requested?.revision || requested?.requireAmendment)
    && (!amendment || c.sourceRefresh.amendmentId === amendment.id);
  const queuedCandidate: Claim = { ...evidenceClaim, phase: "waiting", pendingWorkerAttempt: attempt.id };
  const canRefreshSources = !!requested && matchesSourceRefresh(queuedCandidate, requested);
  if (c.recoveredWorkerAttempts?.includes(attempt.id) || (!recoveringLegacy && c.retriedWorkerAttempt === attempt.id)
    || (!recoveringPending && !recoveringLegacy && (c.retryCount ?? 0) >= 1 && c.recoveryDispatchAttempt !== attempt.id)
    || (recoveringPending && c.pendingWorkerAttempt !== attempt.id)
    || !delivery.recoverDeviceTestAttempts?.has(attempt.id) || !configMatches || sourceAlreadyBlocked
    || !["tests", "dependencies", "patch"].includes(attempt.failureStage ?? "") || !canRefreshSources) {
    if (evidenceClaim !== c) save(evidenceClaim, "worker-failure-restored");
    return evidenceClaim;
  }
  // 先持久化待恢复回执。源码复核真正通过并即将交给执行器时，才消耗唯一恢复机会。
  const queued = queuedCandidate;
  if (!recoveringPending) save(queued, recoveringLegacy ? "worker-recovery-migrated" : "worker-retry-queued");
  else if (evidenceClaim !== c || c.phase !== "waiting") save(queued, "worker-retry-resumed");
  return queued;
}
