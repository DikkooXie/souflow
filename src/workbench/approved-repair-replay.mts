import { contentDigest, workerDigest } from "../execution/code-worker-protocol.mts";
import type { FailedReviewDraftEvidence } from "../execution/failed-review-draft.mts";
import { readIsolationEvidence } from "../execution/isolation-evidence.mts";
import { deliveryPath } from "../execution/local-code-changes.mts";
import type { ApprovedReviewFix } from "./approved-review-fix.mts";
import type { ReviewRepair } from "./delivery-review-repair.mts";
import type { Claim } from "./issue-dispatch.mts";

export function selectApprovedRepairReplay(claim: Claim, fix: ApprovedReviewFix, repair: ReviewRepair | undefined) {
  const state = claim.reviewFix;
  const failure = claim.failure;
  const record = claim.reviewRepairs?.find(row => row.id === fix.repairId && row.decision === "approved");
  if (!fix.repairId || !fix.failedDraft || !fix.testFiles?.length || !repair || repair.id !== fix.repairId
    || !record?.issue || !Number.isSafeInteger(record.issue) || record.issue < 1 || record.head !== fix.head || record.completedHead
    || state?.repairId !== repair.id || state.from !== fix.head || state.state !== "failed"
    || !state.retriedTests || !state.testCheckFailed || state.replayedDraft
    || failure?.stage !== "tests" || failure.reason !== "check-failed"
    || fix.pull !== repair.fix.pull || fix.base !== repair.fix.base || fix.head !== repair.fix.head
    || fix.instructions !== repair.fix.instructions) return;
  const scope = [...fix.files, ...fix.testFiles];
  if (new Set(scope).size !== scope.length || scope.length !== repair.fix.files.length
    || scope.some(path => !repair.fix.files.includes(path))) return;
  const evidence = readIsolationEvidence(failure.isolation);
  const diagnosticTests = evidence?.step === "quality" && evidence.outcome === "exit"
    ? evidence.diagnostics?.map(line => line.split(":")[0]) ?? [] : [];
  if (fix.testFiles.some(path => !/^tests\/[\w./-]+\.test\.[cm]?[jt]s$/.test(path) || !diagnosticTests.includes(path))) return;
  const { candidateFiles: files, candidatePatch: patch, candidatePatchDigest: sha256, candidateDigest: digest } = failure;
  if (!files?.length || !patch || !sha256 || !digest || !workerDigest.test(sha256) || !workerDigest.test(digest)
    || contentDigest(patch) !== sha256 || contentDigest(JSON.stringify(files)) !== digest
    || new Set(files.map(file => file.path)).size !== files.length
    || files.some(file => !deliveryPath.test(file.path) || !scope.includes(file.path)
      || !workerDigest.test(file.before) || !workerDigest.test(file.after) || file.before === file.after
      || ![0o100644, 0o100755].includes(file.mode))) return;
  // 两种补丁格式各自保留摘要；执行器再以原提交和完整 before/after 清单证明是同一候选。
  const candidate: FailedReviewDraftEvidence = structuredClone({ files, patch, sha256, digest });
  return { repair, issue: record.issue, candidate };
}
