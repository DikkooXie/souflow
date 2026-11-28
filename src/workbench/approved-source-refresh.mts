import { workerCommit, workerDigest, workerId } from "../execution/code-worker-protocol.mts";
import type { Claim } from "./issue-dispatch.mts";

export type ApprovedSourceRefresh = { issue: number; requestId: string; version: number; issueRevision: string; revision: string; attemptId?: string };

export function readApprovedSourceRefresh(raw: string): ApprovedSourceRefresh {
  const value = JSON.parse(raw);
  const keys = value && typeof value === "object" ? Object.keys(value).sort().join(",") : "";
  if (!value || !["issue,issueRevision,requestId,revision,version", "attemptId,issue,issueRevision,requestId,revision,version"].includes(keys)
    || !Number.isSafeInteger(value.issue) || value.issue < 1
    || !Number.isSafeInteger(value.version) || value.version < 1 || typeof value.requestId !== "string" || !workerId.test(value.requestId)
    || typeof value.issueRevision !== "string" || !workerDigest.test(value.issueRevision)
    || typeof value.revision !== "string" || !workerCommit.test(value.revision)
    || (value.attemptId !== undefined && (typeof value.attemptId !== "string" || !workerId.test(value.attemptId)))) {
    throw Error("源码复核续派需要固定原批次、工单版本及当前主干提交。");
  }
  return { issue: value.issue, requestId: value.requestId, version: value.version,
    issueRevision: value.issueRevision, revision: value.revision, ...(value.attemptId ? { attemptId: value.attemptId } : {}) };
}

export function matchesSourceRefresh(claim: Claim, requested: ApprovedSourceRefresh) {
  const sameApproval = claim.number === requested.issue && claim.requestId === requested.requestId
    && claim.approval?.version === requested.version && claim.approval.issueRevision === requested.issueRevision
    && !!claim.approval.quality && !!claim.delivery?.baseRevision && claim.delivery.baseRevision !== requested.revision
    && !!claim.delivery.sourceFrom?.length && !claim.claimUncertain && !claim.interruptedDevelopment
    && !claim.target && !claim.prepared && !claim.checked && !claim.pull && !claim.pulls.length && !claim.reviewFix
    && (claim.sourceRefresh?.state !== "blocked" || claim.sourceRefresh.revision !== requested.revision);
  if (!sameApproval) return false;
  if (requested.attemptId) return ["waiting", "uncertain"].includes(claim.phase) && claim.pendingWorkerAttempt === requested.attemptId
    && claim.failure?.stage === "device" && claim.failure.reason === "device-failed"
    && ["tests", "dependencies"].includes(claim.failure.workerStage ?? "");
  return claim.phase === "uncertain" && claim.failure?.stage === "preflight" && !claim.sessionId
    && !claim.retriedWorkerAttempt && !claim.retryCount;
}
