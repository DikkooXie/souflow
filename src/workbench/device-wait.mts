import { contentDigest, workerDigest } from "../execution/code-worker-protocol.mts";
import { qualityBindingCurrent } from "../planning/dispatch-quality.mts";
import type { Claim, IssueDeliveryOptions } from "./issue-dispatch.mts";

export type DeviceWait = { version: 1; binding: string; offered?: string };
export type LegacyDeviceWait = { issue: number; claimDigest: string; originalMode: "device" };

export function readLegacyDeviceWait(raw: string): LegacyDeviceWait {
  const value = JSON.parse(raw);
  if (!value || Object.keys(value).sort().join() !== "claimDigest,issue,originalMode"
    || !Number.isSafeInteger(value.issue) || value.issue < 1 || value.originalMode !== "device"
    || typeof value.claimDigest !== "string" || !workerDigest.test(value.claimDigest)) throw Error("旧设备等待恢复需要精确工单、记录摘要及原设备执行模式。");
  return value;
}

// 管理员只能选择读取时的原记录；重启转换或审批内容变化后不能套用旧摘要。
export const legacyDeviceWaitDigest = (claim: Claim) => contentDigest(JSON.stringify(claim));
export const deviceWaitBinding = (repo: string, claim: Claim) => contentDigest(JSON.stringify([
  repo.toLowerCase(), claim.number, claim.requestId, claim.claimedBy, claim.account, claim.approval, claim.delivery,
]));

export function unstartedDeviceClaim(claim: Claim) {
  return !claim.sessionId && !claim.accountAssignment && !claim.report && !claim.target && !claim.pull && !claim.pulls.length
    && !claim.prepared && !claim.checked && !claim.claimUncertain && !claim.retryCount && !claim.retriedWorkerAttempt
    && !claim.pendingWorkerAttempt && !claim.recoveryDispatchAttempt && !claim.recoveredWorkerAttempts?.length
    && !claim.reviewFix && !claim.attemptedCheckedRecovery && !claim.sourceRefresh && !claim.deviceWait?.offered;
}

export function canWaitForDevice(repo: string, claim: Claim, delivery?: IssueDeliveryOptions) {
  return delivery?.executionMode === "device" && delivery.conversation && !!claim.delivery?.baseRevision
    && qualityBindingCurrent(claim.approval?.quality) && unstartedDeviceClaim(claim)
    // cancelled 也算历史 offer，不能把曾尝试发送的记录当作零派发。
    && delivery.hasAnyWorkerAttempt?.(repo, claim.number) === false;
}

export function restoreDeviceWait(repo: string, claim: Claim, delivery?: IssueDeliveryOptions): Claim | undefined {
  const bound = claim.deviceWait?.version === 1 && claim.deviceWait.binding === deviceWaitBinding(repo, claim);
  const requested = delivery?.recoverDeviceWait;
  const legacy = !claim.deviceWait && requested?.issue === claim.number
    && requested.claimDigest === legacyDeviceWaitDigest(claim) && requested.originalMode === "device"
    && ["developing", "uncertain"].includes(claim.phase) && !claim.sourceRefresh && !claim.sourceHandoff
    && !claim.delivery?.dependsOn.length && !claim.prePrAmendments?.length
    && (!claim.failure || claim.failure.stage === "preflight" && claim.failure.reason === "unavailable")
    && delivery?.hasIssueExecutionHistory?.(`${repo}#${claim.number}`) === false;
  if (!(bound && ["waitingDevice", "checkingSources"].includes(claim.phase) || legacy) || !canWaitForDevice(repo, claim, delivery)) return;
  const { interruptedDevelopment: _interrupted, failure: _failure, ...rest } = claim;
  return { ...rest, phase: "waitingDevice", deviceWait: { version: 1, binding: deviceWaitBinding(repo, claim) } };
}
