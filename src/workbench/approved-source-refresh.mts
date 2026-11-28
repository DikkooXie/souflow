import { workerCommit, workerDigest, workerId } from "../execution/code-worker-protocol.mts";
import type { Claim } from "./issue-dispatch.mts";

export type ApprovedSourceRefresh = { issue: number; requestId: string; version: number; issueRevision: string; revision: string };

export function readApprovedSourceRefresh(raw: string): ApprovedSourceRefresh {
  const value = JSON.parse(raw);
  if (!value || Object.keys(value).length !== 5 || !Number.isSafeInteger(value.issue) || value.issue < 1
    || !Number.isSafeInteger(value.version) || value.version < 1 || typeof value.requestId !== "string" || !workerId.test(value.requestId)
    || typeof value.issueRevision !== "string" || !workerDigest.test(value.issueRevision)
    || typeof value.revision !== "string" || !workerCommit.test(value.revision)) throw Error("源码复核续派需要固定原批次、工单版本及当前主干提交。");
  return { issue: value.issue, requestId: value.requestId, version: value.version,
    issueRevision: value.issueRevision, revision: value.revision };
}

export function matchesSourceRefresh(claim: Claim, requested: ApprovedSourceRefresh) {
  return claim.number === requested.issue && claim.requestId === requested.requestId
    && claim.approval?.version === requested.version && claim.approval.issueRevision === requested.issueRevision
    && !!claim.approval.quality && !!claim.delivery?.baseRevision && claim.delivery.baseRevision !== requested.revision
    && !!claim.delivery.sourceFrom?.length && claim.phase === "uncertain" && !claim.claimUncertain && !claim.interruptedDevelopment
    && claim.failure?.stage === "preflight" && !claim.sessionId && !claim.target && !claim.prepared && !claim.checked
    && !claim.pull && !claim.pulls.length && !claim.retriedWorkerAttempt && !claim.retryCount && !claim.reviewFix
    && (claim.sourceRefresh?.state !== "blocked" || claim.sourceRefresh.revision !== requested.revision);
}
