import { isDeepStrictEqual } from "node:util";
import type { DeliveryTracker, IssueDetail, IssueTracker } from "../connections/issue-tracker.mts";
import { issueRevision } from "../connections/issue-tracker.mts";
import { qualityBindingCurrent } from "../planning/dispatch-quality.mts";
import type { Claim, IssueDeliveryOptions } from "./issue-dispatch.mts";
import { amendmentBound, type PrePrAmendment } from "./pre-pr-amendment.mts";

export function createPrePrAmendmentAuthorization(input: {
  claim: (issue: number) => Claim | undefined;
  save: (claim: Claim, action: string) => void;
  connection: (actor: string) => IssueTracker;
  delivery: IssueDeliveryOptions | undefined;
  latestFailure: (claim: Claim) => { id: string; failureStage?: string } | undefined;
  busy: (issue: number) => boolean;
  permits: (actor: string) => boolean;
  dispatch: () => void;
}) {
  const jobs = new Map<number, Promise<number>>();
  const remote = (actor: string) => (input.connection(actor) as Partial<DeliveryTracker>).delivery;
  function candidate(number: number, actor: string) {
    const c = input.claim(number);
    const delivery = input.delivery;
    const requested = delivery?.sourceRefresh;
    const failure = c && input.latestFailure(c);
    if (!c || !delivery?.conversation || !requested || !input.permits(actor) || c.claimedBy !== actor
      || c.phase !== "uncertain" || c.sourceRefresh?.state !== "blocked" || !c.pendingWorkerAttempt
      || failure?.id !== c.pendingWorkerAttempt || !["tests", "dependencies"].includes(failure.failureStage ?? "")
      || !delivery.recoverDeviceTestAttempts?.has(failure.id) || input.busy(number)
      || requested.attemptId !== failure.id || !remote(actor)?.currentRevision
      || requested.requestId !== c.requestId || requested.version !== c.approval?.version
      || requested.issueRevision !== c.approval.issueRevision || requested.issue !== c.number
      || !qualityBindingCurrent(c.approval.quality) || !delivery.reviewScopeCurrent?.(c)
      || c.claimUncertain || c.interruptedDevelopment || c.target || c.prepared || c.checked || c.pull || c.pulls.length || c.reviewFix
      || c.retryCount || c.retriedWorkerAttempt || !c.delivery?.sourceFrom?.length
      || c.prePrAmendments?.some(a => a.attemptId === failure.id)) return;
    return c;
  }
  const assigned = (c: Claim, issue: IssueDetail) => issue.state === "OPEN" && c.approval?.issueRevision === issueRevision(issue)
    && issue.assignees.length === 1 && issue.assignees[0]?.toLowerCase() === c.account.toLowerCase() && !issue.pulls.length;
  return {
    candidate(number: number, actor: string) { const c = candidate(number, actor); return c && structuredClone(c); },
    authorize(a: PrePrAmendment): Promise<number> {
      const prior = input.claim(a.issue)?.prePrAmendments?.find(row => row.id === a.id);
      if (prior) {
        const { approvedAt: _at, ...record } = prior;
        return Promise.resolve(isDeepStrictEqual(record, a) ? 200 : 409);
      }
      const pending = jobs.get(a.issue);
      if (pending) return pending.then(() => input.claim(a.issue)?.prePrAmendments?.some(row => isDeepStrictEqual(
        { ...row, approvedAt: undefined }, { ...a, approvedAt: undefined })) ? 200 : 409);
      const task = (async () => {
        const c = candidate(a.issue, a.actor);
        if (!c || !amendmentBound(c, a) || c.pendingWorkerAttempt !== a.attemptId) return 409;
        const connection = input.connection(a.actor);
        const observed = await Promise.all([connection.account(), connection.read(a.issue), remote(a.actor)?.currentRevision?.()]).catch(() => undefined);
        if (!observed || input.claim(a.issue) !== c || !candidate(a.issue, a.actor)
          || input.delivery?.sourceRefresh?.revision !== a.revision || observed[2] !== a.revision || c.sourceRefresh?.revision !== a.blockedRevision
          || observed[0].toLowerCase() !== c.account.toLowerCase() || !assigned(c, observed[1])) return 409;
        try { input.save({ ...c, prePrAmendments: [...(c.prePrAmendments ?? []), { ...structuredClone(a), approvedAt: Date.now() }] },
          "pre-pr-amendment-authorized"); }
        catch { return 503; }
        input.dispatch();
        return 200;
      })().finally(() => jobs.delete(a.issue));
      jobs.set(a.issue, task);
      return task;
    },
    async close() { await Promise.allSettled(jobs.values()); },
  };
}
