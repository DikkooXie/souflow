import { isDeepStrictEqual } from "node:util";
import { scrubAuditText, type Checkpoint } from "../audit/activity-store.mts";
import { workerId } from "../execution/code-worker-protocol.mts";
import type { DeliverySpec } from "../execution/issue-delivery.mts";
import type { DeliveryReviewScope } from "../planning/delivery-review.mts";
import type { QualityTicket } from "../planning/dispatch-quality.mts";
import type { DecisionCard } from "./demo-state.mts";
import type { Claim } from "./issue-dispatch.mts";

export type PrePrAmendment = {
  id: string; flowId: string; actor: string; requestId: string; issue: number; version: number;
  issueRevision: string; attemptId: string; blockedRevision: string; revision: string;
  testFiles: string[]; validation: QualityTicket["validation"];
};
export type ApprovedPrePrAmendment = PrePrAmendment & { approvedAt: number };
export type PrePrAmendmentEvent = { kind: "request"; amendment: PrePrAmendment; at: number }
  | { kind: "decision"; id: string; actor: string; decision: "approved" | "declined"; at: number };
type AmendmentClaim = Pick<Claim, "number" | "claimedBy" | "requestId" | "approval" | "sourceRefresh" | "prePrAmendments">;

export function amendmentBound(c: AmendmentClaim, a: PrePrAmendment) {
  return a.issue === c.number && a.actor === c.claimedBy && a.flowId === c.approval?.flowId
    && a.requestId === c.requestId && a.version === c.approval.version && a.issueRevision === c.approval.issueRevision
    && [a.revision, a.blockedRevision].includes(c.sourceRefresh?.revision ?? "");
}
export function activePrePrAmendment(c: AmendmentClaim) {
  const a = c.prePrAmendments?.at(-1);
  return a && amendmentBound(c, a) ? a : undefined;
}
export function amendedSpec(c: Claim): DeliverySpec | undefined {
  if (!c.delivery) return;
  const a = activePrePrAmendment(c);
  return !a ? c.delivery : { ...c.delivery, files: [...new Set([...c.delivery.files, ...a.testFiles])],
    instructions: [c.delivery.instructions, `追加修订 ${a.id}（原批次 ${a.requestId}，失败派发 ${a.attemptId}）`,
      ...a.validation.map(v => `${v.criterion}：${v.procedure} → ${v.expected}`)].join("\n") };
}
export function amendedScope(c: AmendmentClaim, scope: DeliveryReviewScope): DeliveryReviewScope {
  const a = activePrePrAmendment(c);
  return !a ? scope : { ...scope, files: [...new Set([...scope.files, ...a.testFiles])],
    criteria: scope.criteria.map(row => {
      const extra = a.validation.find(v => v.criterion === row.criterion);
      return !extra ? row : { ...row, procedure: `${row.procedure}\n追加：${extra.procedure}`,
        expected: `${row.expected}\n追加：${extra.expected}` };
    }) };
}

function readAmendment(input: unknown, flowId: string, actor: string): PrePrAmendment | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return;
  const v = input as PrePrAmendment;
  const keys = Object.keys(v).sort().join(",");
  if (keys !== "attemptId,blockedRevision,id,issue,issueRevision,requestId,revision,testFiles,validation,version"
    || ![v.id, v.requestId, v.attemptId].every(id => typeof id === "string" && workerId.test(id))
    || !Number.isSafeInteger(v.issue) || v.issue < 1 || !Number.isSafeInteger(v.version) || v.version < 1
    || typeof v.issueRevision !== "string" || !/^[a-f0-9]{64}$/.test(v.issueRevision)
    || typeof v.revision !== "string" || !/^[a-f0-9]{40}$/.test(v.revision)
    || typeof v.blockedRevision !== "string" || !/^[a-f0-9]{40}$/.test(v.blockedRevision)
    || !Array.isArray(v.testFiles) || !v.testFiles.length || v.testFiles.length > 8
    || v.testFiles.some(path => typeof path !== "string" || !/^tests\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+\.test\.mts$/.test(path))
    || new Set(v.testFiles).size !== v.testFiles.length
    || !Array.isArray(v.validation) || !v.validation.length || v.validation.length > 16
    || v.validation.some(row => !row || Object.keys(row).sort().join(",") !== "criterion,expected,procedure"
      || typeof row.criterion !== "string" || !/^AC-\d+$/.test(row.criterion)
      || [row.procedure, row.expected].some(text => typeof text !== "string" || !text.trim() || text.length > 4000
        || scrubAuditText(text) !== text))
    || new Set(v.validation.map(row => row.criterion)).size !== v.validation.length) return;
  return structuredClone({ ...v, flowId, actor });
}

const approve = "授权补充测试、重新复核并续派原工单";
const decline = "暂不修订";
export function createPrePrAmendments(store: Checkpoint<PrePrAmendmentEvent>, gateway: {
  candidate: (issue: number, actor: string) => Claim | undefined;
  claim: (issue: number) => Claim | undefined;
  scope: (claim: Claim) => DeliveryReviewScope | undefined;
  authorize: (amendment: PrePrAmendment) => Promise<number>;
}) {
  const requests = new Map<string, PrePrAmendment>();
  const decisions = new Map<string, "approved" | "declined">();
  const authorizing = new Map<string, Promise<number>>();
  for (const row of store.load()) {
    if (row.kind === "request") requests.set(row.amendment.id, row.amendment);
    else decisions.set(row.id, row.decision);
  }
  const current = (a: PrePrAmendment) => {
    const c = gateway.candidate(a.issue, a.actor);
    const scope = c && gateway.scope(c);
    return c && scope && amendmentBound(c, a) && c.sourceRefresh?.revision === a.blockedRevision && c.pendingWorkerAttempt === a.attemptId
      && a.validation.every(v => scope.criteria.some(row => row.criterion === v.criterion));
  };
  return {
    submit(flowId: string, actor: string, input: unknown) {
      const a = readAmendment(input, flowId, actor);
      if (!a) return 422;
      const prior = requests.get(a.id);
      if (prior) return isDeepStrictEqual(prior, a) ? 200 : 409;
      if (!current(a) || [...requests.values()].some(row => row.issue === a.issue && row.attemptId === a.attemptId
        && decisions.get(row.id) !== "declined")) return 409;
      const at = Date.now();
      if (!store.save(`request:${a.id}`, { kind: "request", amendment: a, at }, { kind: "github.selection", flowId,
        subject: a.id, details: { action: "pre-pr-amendment-requested", amendment: a } })) return 503;
      requests.set(a.id, a);
      return 200;
    },
    has(id: string) { return requests.has(id); },
    cards(actor: string): DecisionCard[] {
      return [...requests.values()].filter(a => a.actor === actor && decisions.get(a.id) !== "declined"
        && !gateway.claim(a.issue)?.prePrAmendments?.some(row => row.id === a.id) && current(a)).map(a => ({
        id: a.id, flowId: a.flowId, kind: "github-authorization", title: `追加修订原 Issue #${a.issue}`,
        session: `开发计划 v${a.version} · ${a.revision.slice(0, 8)}`, status: "pending",
        prompt: [`原批次：${a.requestId}`, `失败派发：${a.attemptId}`, `Issue 摘要：${a.issueRevision}`,
          `原拦截提交：${a.blockedRevision}`, `本次复核及执行提交：${a.revision}`,
          `补充可编辑测试：${a.testFiles.join("、")}`,
          ...a.validation.map(v => `${v.criterion}：${v.procedure} → ${v.expected}`)].join("\n"),
        questions: [{ id: "authorization", title: "补充测试授权", prompt: "确认追加上述测试范围与验证要求，重新独立复核后续派一次？",
          allowCustom: false, options: [{ label: approve, description: "沿用原 Issue、计划和前置；源码复核通过后才允许设备执行。" },
            { label: decline, description: "保留原拦截与修订记录。" }] }], timeline: [],
      }));
    },
    async answer(id: string, actor: string, input: unknown) {
      const a = requests.get(id);
      if (!a || a.actor !== actor) return 404;
      const answer = (input as { authorization?: unknown } | null)?.authorization;
      if (!input || typeof input !== "object" || Object.keys(input).length !== 1 || (answer !== approve && answer !== decline)) return 422;
      const decision = answer === approve ? "approved" : "declined";
      const previous = decisions.get(id);
      if (gateway.claim(a.issue)?.prePrAmendments?.some(row => row.id === id)) return decision === "approved" && previous === "approved" ? 200 : 409;
      const pending = authorizing.get(id);
      if (pending) return decision === "approved" ? pending : 409;
      if (previous === "declined") return decision === "declined" ? 200 : 409;
      if (decision === "approved" && !current(a)) return 409;
      if (previous !== decision) {
        const at = Date.now();
        if (!store.save(`decision:${id}:${decision}`, { kind: "decision", id, actor, decision, at }, { kind: "github.selection",
          flowId: a.flowId, subject: id, details: { action: `pre-pr-amendment-${decision}`, amendment: a, actor } })) return 503;
        decisions.set(id, decision);
      }
      if (decision === "declined") return 200;
      const task = gateway.authorize(a).finally(() => authorizing.delete(id));
      authorizing.set(id, task);
      return task;
    },
  };
}
