import { scrubAuditText } from "../audit/activity-store.mts";
import { issueRevision, type IssuePublisher, type IssueTracker } from "../connections/issue-tracker.mts";
import { qualitySources } from "../execution/codex-quality-review.mts";
import { type DeliveryEvidence, type DeliveryReviewer, type DeliveryReviewReceipt, type DeliveryReviewScope,
  reviewDelivery } from "../planning/delivery-review.mts";
import type { Claim } from "./issue-dispatch.mts";
import type { TrustedVerification } from "./trusted-verification.mts";

export type ReviewIssueDelivery = ((claim: Claim, connection: IssueTracker, remote: IssuePublisher,
  signal: AbortSignal) => Promise<DeliveryReviewReceipt | undefined>) & { version?: (claim: Claim) => string | undefined };

export function createGitHubDeliveryReviewer(workspace: string, getScope: (claim: Claim) => DeliveryReviewScope | undefined,
  reviewer: DeliveryReviewer, trusted?: { repo: string; bundle: TrustedVerification }): ReviewIssueDelivery {
  const observe = (claim: Claim, force = false) => trusted?.bundle.observe(trusted.repo, claim, getScope(claim), force);
  const review: ReviewIssueDelivery = async (claim, connection, remote, signal) => {
    const { approval, delivery, pull } = claim;
    const scope = getScope(claim);
    if (!scope || !approval?.quality || !delivery?.baseRevision || !pull?.head || !remote.reviewChanges) return;
    const external = observe(claim, true);
    if (external && trusted?.repo.toLowerCase() !== connection.repo.toLowerCase()) return;
    const issue = await connection.read(claim.number);
    if (issueRevision(issue) !== approval.issueRevision || !issue.pulls.some(other => other.number === pull.number)) return;
    const { mergeBase, files } = await remote.reviewChanges(pull, signal);
    if (!files.length || files.some(file => !scope.files.includes(file.path))) throw Error("PR 改动超出复核的获授权文件。");
    const rules = await qualitySources(workspace, delivery.baseRevision, ["AGENTS.md", "docs/engineering-quality.md"], signal);
    const evidence: DeliveryEvidence[] = files.map(({ path, diff }) => ({ id: `change:${path}`, kind: "change", text: scrubAuditText(diff) }));
    for (const [path, text] of Object.entries(rules)) evidence.push({ id: `rule:${path}`, kind: "rule", text });
    if (external?.evidence) evidence.push(...external.evidence);
    if (claim.checked?.head === pull.head) {
      for (const [index, text] of claim.checked.passingTests.entries()) {
        const matches = new Set(text.match(/\bAC-\d+\b/g));
        const criteria = scope.criteria.map(item => item.criterion).filter(id => matches.has(id));
        if (criteria.length) evidence.push({ id: `verification:${index + 1}`, kind: "verification", criteria, text });
      }
    }
    const receipt = await reviewDelivery({
      key: { repo: connection.repo, issue: claim.number, issueRevision: approval.issueRevision, pull: pull.number,
        head: pull.head, mergeBase, plan: { id: approval.planId, version: approval.version, quality: approval.quality },
        ...(external?.verification ? { verification: external.verification } : {}) },
      request: scrubAuditText(scope.request), criteria: scope.criteria.map(({ criterion, text, procedure, expected }) => ({
        criterion, text: scrubAuditText(text), procedure: scrubAuditText(procedure), expected: scrubAuditText(expected),
      })), evidence,
    }, reviewer, signal);
    const latest = await connection.read(claim.number);
    const readBack = await remote.find(claim.target?.branch ?? "", pull.head, pull.number);
    if (issueRevision(latest) !== approval.issueRevision || !latest.pulls.some(other => other.number === pull.number)
      || readBack?.head !== pull.head || readBack.baseName !== pull.baseName || !getScope(claim)
      || observe(claim, true)?.version !== external?.version) return;
    return receipt;
  };
  if (trusted) review.version = claim => observe(claim)?.version;
  return review;
}
