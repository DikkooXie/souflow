import { mkdir, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import type { IssuePublisher } from "../connections/issue-tracker.mts";
import { locateFailedCandidate, readCandidateSnapshot, type CandidateParent, type CandidateSnapshot } from "./candidate-snapshot.mts";
import { restoreFailedReviewDraft } from "./failed-review-draft.mts";
import { IssueDeliveryFailed, isolatedIssueCheck, type DeliveryFailure } from "./issue-delivery.mts";
import type { IsolationEvidence } from "./isolation-evidence.mts";

export class RepairInspectionBlocked extends Error {}
export type InspectRepairCandidate = (input: { issue: number; head: string; branch: string; base: string; files: readonly string[];
  failure: DeliveryFailure; parent?: CandidateParent; publisher: IssuePublisher }, signal: AbortSignal) => Promise<{
    candidate: CandidateSnapshot; isolation?: IsolationEvidence;
  }>;

export function createRepairCandidateInspector(options: { root: string; image: string; timeoutMs: number;
  check?: typeof isolatedIssueCheck }): InspectRepairCandidate {
  const { root, image, timeoutMs, check = isolatedIssueCheck } = options;
  return async (input, signal) => {
    let candidate: CandidateSnapshot;
    try { candidate = await locateFailedCandidate(root, input.issue, input.head, input.files, input.failure, input.parent, signal); }
    catch { signal.throwIfAborted(); throw new RepairInspectionBlocked("无法证明最新候选及来源。"); }
    if (!input.publisher.checkoutPublished) throw new RepairInspectionBlocked("缺少原 PR 检出能力。");
    await mkdir(root, { recursive: true, mode: 0o700 });
    const target = await mkdtemp(join(root, `issue-${input.issue}-`));
    const workspace = join(target, "source");
    await input.publisher.checkout(workspace, signal);
    await input.publisher.checkoutPublished(workspace, { branch: input.branch, head: input.head }, signal);
    await restoreFailedReviewDraft(root, target, workspace, input.issue, input.head, candidate, input.files, timeoutMs, signal, candidate);
    await check(workspace, image, timeoutMs, signal, true);
    let isolation: IsolationEvidence | undefined;
    try { await check(workspace, image, timeoutMs, signal, false); }
    catch (error) {
      if (!(error instanceof IssueDeliveryFailed) || error.failure.stage !== "tests" || error.failure.reason !== "check-failed") throw error;
      isolation = error.failure.isolation;
    }
    const checked = await readCandidateSnapshot(workspace, input.head, input.files, signal);
    if (checked.sha256 !== candidate.sha256 || checked.digest !== candidate.digest) throw new RepairInspectionBlocked("隔离检查改变了候选。");
    return { candidate: checked, ...(isolation ? { isolation } : {}) };
  };
}
