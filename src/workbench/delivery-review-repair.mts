import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { scrubAuditText } from "../audit/activity-store.mts";
import { readDecisionAnswers } from "../decisions/questions.mts";
import type { DeliveryReviewReceipt } from "../planning/delivery-review.mts";
import { approvedReviewFixInstructionLimit, type ApprovedReviewFix } from "./approved-review-fix.mts";
import type { DecisionCard } from "./demo-state.mts";
import type { Claim } from "./issue-dispatch.mts";
import type { PlannedIssueBatch } from "./planned-issue-publication.mts";

const authorize = "授权创建修复 Issue 并续修";
const decline = "暂不续修";
const question = {
  id: "authorization", title: "交付修复授权", allowCustom: false,
  prompt: "允许把下方内容发布到原 GitHub 仓库，并由 Codex 在已授权的文件范围内续修原 PR？",
  options: [
    { label: authorize, description: "创建或回读一张关联 Issue，验证后更新原 PR，并复核最新提交。" },
    { label: decline, description: "保留当前复核记录与拦截状态。" },
  ],
};

export type ReviewRepair = { id: string; fix: ApprovedReviewFix; batch: PlannedIssueBatch };

export function readRepairDecision(input: unknown): "approved" | "declined" | undefined {
  const answer = readDecisionAnswers([question], input)?.authorization;
  return answer === authorize ? "approved" : answer === decline ? "declined" : undefined;
}

export function repairFromReceipt(repo: string, claim: Claim, receipt: DeliveryReviewReceipt): ReviewRepair | undefined {
  const { approval, delivery, pull, target } = claim;
  const key = receipt.key;
  if (receipt.status !== "block" || !receipt.implementation || !receipt.requirements || !/^[a-f0-9]{64}$/.test(receipt.packetId)
    || claim.phase !== "submitted" || claim.state !== "OPEN" || !approval?.quality || !delivery?.baseRevision || !delivery.files.length
    || pull?.state !== "OPEN" || !pull.baseName || !target || target.head !== pull.head
    || repo.toLowerCase() !== key.repo.toLowerCase() || claim.number !== key.issue || pull.number !== key.pull || pull.head !== key.head
    || approval.planId !== key.plan.id || approval.version !== key.plan.version || approval.issueRevision !== key.issueRevision
    || !isDeepStrictEqual(approval.quality, key.plan.quality)) return;
  const findings = [
    ...(receipt.implementation.status === "block" ? [`实现与测试质量 · ${receipt.implementation.summary}`] : []),
    ...receipt.requirements.criteria.filter(item => item.status === "block").map(item => `${item.criterion} · ${item.summary}`),
  ].map(line => scrubAuditText(line.replace(/[\r\n]+/g, " ")));
  if (!findings.length) return;
  const scope = [...delivery.files];
  const instructions = findings.join("\n").slice(0, approvedReviewFixInstructionLimit);
  const body = [
    `原工单 #${claim.number} · 原 PR #${pull.number}`,
    `固定提交 ${key.head} · 开发计划 v${approval.version}`,
    `工作台交付复核回执 ${receipt.packetId}`,
    "",
    instructions,
    "",
    `允许修改 ${scope.join("、")}`,
    "按原验收条件修复并执行测试。更新原 PR 后，重新做实现和需求两类复核。",
  ].join("\n");
  // 卡片 ID 绑定复核结论、原授权及确切公开正文。重启不重建编号或扩展范围。
  const id = createHash("sha256").update(JSON.stringify([repo.toLowerCase(), claim.requestId, key, receipt.packetId, body]))
    .digest("hex");
  const fix = { issue: claim.number, pull: pull.number, head: key.head, base: pull.baseName, files: scope, instructions };
  return { id, fix, batch: { id, actor: claim.claimedBy, flowId: approval.flowId, planId: approval.planId, version: approval.version,
    drafts: [{ id: "REPAIR", title: `修复 #${claim.number} 的交付复核问题`, body, dependsOn: [] }] } };
}

export function repairDecisionCard(repair: ReviewRepair, at: number): DecisionCard {
  return { id: repair.id, kind: "github-authorization", flowId: repair.batch.flowId, title: "授权交付修复",
    session: `PR #${repair.fix.pull} · ${repair.fix.head.slice(0, 8)}`, status: "pending",
    prompt: repair.batch.drafts[0]?.body ?? "", questions: [question],
    timeline: [{ label: "交付复核发现阻塞", at: new Date(at).toISOString() }] };
}
