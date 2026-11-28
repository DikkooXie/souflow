import { isDeepStrictEqual } from "node:util";
import { repairContinuationLimit } from "../config/runtime.mts";
import { contentDigest } from "../execution/code-worker-protocol.mts";
import type { CandidateSnapshot } from "../execution/candidate-snapshot.mts";
import { blockingTestDiagnostic, readIsolationEvidence } from "../execution/isolation-evidence.mts";
import { RepairInspectionBlocked, type InspectRepairCandidate } from "../execution/repair-candidate-inspection.mts";
import { issueRevision, type DeliveryTracker } from "../connections/issue-tracker.mts";
import type { ApprovedReviewFix } from "./approved-review-fix.mts";
import type { Claim } from "./issue-dispatch.mts";
import type { ReviewRepair } from "./delivery-review-repair.mts";
import { PublishedRepairChanged, readPublishedRepair } from "./planned-issue-publication.mts";

export type RepairContinuation = { repairId: string; head: string; rounds: { failure: string; diagnostics: string[]; candidate: string }[];
  stopped?: string };
export type PreparedRepairContinuation = { repair: ReviewRepair; issue: number; candidate: CandidateSnapshot;
  failure: string; diagnostics: string[]; previous: RepairContinuation };
export const failureFingerprint = (claim: Claim) => contentDigest(JSON.stringify(claim.failure));

export function continuationBinding(claim: Claim, repair: ReviewRepair | undefined) {
  const state = claim.reviewFix;
  const record = repair && claim.reviewRepairs?.find(row => row.id === repair.id && row.decision === "approved");
  return repair && claim.phase === "submitted" && state?.state === "failed" && state.repairId === repair.id
    && state.from === repair.fix.head && record?.head === repair.fix.head && !record.completedHead
    && record.issue && Number.isSafeInteger(record.issue) && record.issue > 0
    && claim.failure?.stage === "tests" && claim.failure.reason === "check-failed"
    && (claim.failure.candidateSnapshot || claim.failure.candidateFiles?.length && claim.failure.candidatePatch)
    ? { repair, issue: record.issue } : undefined;
}

export function createRepairContinuation(options: {
  inspect?: InspectRepairCandidate; signal: AbortSignal;
  current: (number: number) => Claim | undefined; repair: (claim: Claim) => ReviewRepair | undefined;
  connection: (claim: Claim) => DeliveryTracker;
  save: (claim: Claim, action: string) => void;
  track: (job: Promise<void>) => void;
  start: (fix: ApprovedReviewFix, prepared: PreparedRepairContinuation) => void;
}) {
  const maxRounds = repairContinuationLimit();
  const active = new Set<number>();
  const owns = (claim: Claim) => active.has(claim.number) || !!claim.repairContinuation
    && claim.repairContinuation.repairId === claim.reviewFix?.repairId;
  return {
    owns,
    enqueue(claim: Claim) {
      const { inspect, signal } = options;
      if (!inspect || signal.aborted || active.has(claim.number)) return false;
      const bound = continuationBinding(claim, options.repair(claim));
      if (!bound) return false;
      const previous = claim.repairContinuation?.repairId === bound.repair.id ? claim.repairContinuation
        : { repairId: bound.repair.id, head: bound.repair.fix.head, rounds: [] };
      if (previous.repairId !== bound.repair.id || previous.head !== bound.repair.fix.head || previous.stopped) return false;
      const fingerprint = failureFingerprint(claim);
      const stop = (reason: string) => {
        const current = options.current(claim.number);
        if (current && failureFingerprint(current) === fingerprint && isDeepStrictEqual(current.repairContinuation, claim.repairContinuation)) {
          options.save({ ...current, repairContinuation: { ...previous, stopped: reason } }, "review-continuation-stopped");
        }
      };
      if (previous.rounds.length >= maxRounds) { stop("诊断续修预算已用完。"); return false; }
      if (previous.rounds.some(row => row.failure === fingerprint)) { stop("本轮没有新的失败回执，不能重复执行。"); return false; }
      active.add(claim.number);
      const job = (async () => {
        try {
          const connection = options.connection(claim);
          const publisher = connection.delivery;
          const target = claim.target;
          if (!publisher || !target || !claim.failure) throw new RepairInspectionBlocked("缺少原交付依据。");
          const verify = async () => {
            signal.throwIfAborted();
            const [account, issue, pull] = await Promise.all([connection.account(), connection.read(claim.number),
              publisher.find(target.branch, bound.repair.fix.head, bound.repair.fix.pull)]);
            if (account.toLowerCase() !== claim.account.toLowerCase() || issue.state !== "OPEN"
              || issueRevision(issue) !== claim.approval?.issueRevision || issue.assignees.length !== 1
              || issue.assignees[0]?.toLowerCase() !== claim.account.toLowerCase()
              || !issue.pulls.some(row => row.number === bound.repair.fix.pull)
              || pull?.state !== "OPEN" || pull.head !== bound.repair.fix.head || pull.baseName !== bound.repair.fix.base) {
              throw new RepairInspectionBlocked("原工单或 PR 已变化。");
            }
            await readPublishedRepair(bound.repair.batch, connection, bound.issue);
            signal.throwIfAborted();
            const current = options.current(claim.number);
            if (!current || failureFingerprint(current) !== fingerprint || !isDeepStrictEqual(current.reviewFix, claim.reviewFix)
              || !isDeepStrictEqual(current.repairContinuation, claim.repairContinuation)
              || !isDeepStrictEqual(continuationBinding(current, options.repair(current)), bound)) {
              throw new RepairInspectionBlocked("原修复授权或最新失败已变化。");
            }
          };
          await verify();
          const parent = claim.reviewFix?.replayedDraft && claim.reviewFix.replayedCandidate
            ? { draft: claim.reviewFix.replayedDraft, files: claim.reviewFix.replayedCandidate.files, digest: claim.reviewFix.replayedCandidate.digest }
            : undefined;
          const result = await inspect({ issue: claim.number, head: bound.repair.fix.head, branch: target.branch, base: bound.repair.fix.base,
            files: bound.repair.fix.files, failure: claim.failure, ...(parent ? { parent } : {}), publisher }, signal);
          await verify();
          const evidence = readIsolationEvidence(result.isolation);
          const diagnostics = evidence?.step === "quality" && evidence.outcome === "exit" && !evidence.diagnosticsIncomplete ? evidence.diagnostics ?? [] : [];
          const selected = diagnostics.map(blockingTestDiagnostic);
          if (!selected.length || selected.some(row => !row || !bound.repair.fix.files.includes(row.path))) {
            stop("检查没有可在原批准测试内纠正的完整诊断。"); return;
          }
          const keys = [...new Set(selected.map(row => row?.key as string))].sort();
          if (previous.rounds.some(round => round.diagnostics.some(key => keys.includes(key)))) {
            stop("同一阻断诊断再次出现，停止自动续修。"); return;
          }
          const testFiles = [...new Set(selected.map(row => row?.path as string))];
          const fix: ApprovedReviewFix = { ...bound.repair.fix, files: bound.repair.fix.files.filter(path => !testFiles.includes(path)), testFiles,
            repairId: bound.repair.id, failedDraft: { artifact: result.candidate.artifact, sha256: result.candidate.sha256 },
            testFailureNote: diagnostics.join(" · ") };
          options.start(fix, { ...bound, candidate: result.candidate, failure: fingerprint, diagnostics: keys, previous });
        } catch (error) {
          if (!signal.aborted && (error instanceof RepairInspectionBlocked || error instanceof PublishedRepairChanged)) stop(error.message);
          // 网络和隔离环境暂时失败尚未调用模型；下一轮仍从原持久回执重新核验。
        } finally { active.delete(claim.number); }
      })();
      options.track(job);
      return true;
    },
  };
}
