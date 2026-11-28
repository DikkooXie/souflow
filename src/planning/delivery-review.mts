import { createHash } from "node:crypto";
import { scrubAuditText } from "../audit/activity-store.mts";
import type { QualityBinding, Quote, Verification } from "./dispatch-quality.mts";

export type DeliveryReviewKey = {
  repo: string; issue: number; issueRevision: string; pull: number; head: string; mergeBase: string;
  plan: { id: string; version: number; quality: QualityBinding };
  verification?: { digest: string; integration: string; observedAt: string; expiresAt: string };
};
export type DeliveryCriterion = Verification & { text: string };
export type DeliveryReviewScope = {
  request: string; criteria: readonly DeliveryCriterion[]; files: readonly string[];
};
export type DeliveryEvidence = { id: string; text: string } & (
  { kind: "change" | "rule" } | { kind: "verification"; criteria: readonly string[]; outcome?: "pass" | "partial" | "fail" });
export type DeliveryReviewPacket = {
  key: DeliveryReviewKey;
  request: string;
  criteria: readonly DeliveryCriterion[];
  evidence: readonly DeliveryEvidence[];
};
type ReviewFinding = { status: "pass" | "block"; summary: string; evidence: Quote[] };
const axes = ["implementation", "requirements"] as const;
export type DeliveryReviewAxis = (typeof axes)[number];
export type DeliveryReviewer = (axis: DeliveryReviewAxis, packet: DeliveryReviewPacket, signal: AbortSignal) => Promise<string | undefined>;
type ImplementationReview = ReviewFinding;
type RequirementsReview = { criteria: (ReviewFinding & { criterion: string })[] };
export type DeliveryReviewReceipt = {
  packetId: string;
  key: DeliveryReviewKey;
  implementation?: ImplementationReview;
  requirements?: RequirementsReview;
  status: "pass" | "block" | "incomplete";
};

export const deliveryReviewLimits = { summary: 500, references: 6, quote: 240 } as const;
const findingProperties = {
  status: { type: "string", enum: ["pass", "block"] },
  summary: { type: "string" },
  evidence: { type: "array", items: { type: "object", additionalProperties: false, required: ["ref", "quote"],
    properties: { ref: { type: "string" }, quote: { type: "string" } } } },
};
function schema<T extends Record<string, object>>(properties: T) {
  return { type: "object", additionalProperties: false, required: Object.keys(properties), properties };
}
export function deliveryReviewSchema(axis: DeliveryReviewAxis) {
  return axis === "implementation" ? schema(findingProperties) : schema({
    criteria: { type: "array", items: schema({ criterion: { type: "string" }, ...findingProperties }) },
  });
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("复核记录格式无效。");
  return value as Record<string, unknown>;
}
function parseFinding(value: Record<string, unknown>, references: ReadonlyMap<string, string>) {
  const { status, summary, evidence } = value;
  if ((status !== "pass" && status !== "block") || typeof summary !== "string" || !summary.trim()
    || summary.length > deliveryReviewLimits.summary || !Array.isArray(evidence) || !evidence.length
    || evidence.length > deliveryReviewLimits.references) {
    throw Error("复核结论缺少有效说明或证据。");
  }
  const seen = new Set<string>();
  const quotes = (evidence as unknown[]).map(item => {
    const { ref, quote } = object(item);
    if (typeof ref !== "string" || typeof quote !== "string" || quote.trim().length < 2 || quote.length > deliveryReviewLimits.quote
      || !references.get(ref)?.includes(quote)) throw Error("复核引用无法在固定证据中找到。");
    const citation = JSON.stringify([ref, quote]);
    if (seen.has(citation)) throw Error("复核重复引用了同一条证据。");
    seen.add(citation);
    return { ref, quote };
  });
  return { status, summary: scrubAuditText(summary.trim()), evidence: quotes } satisfies ReviewFinding;
}

function parseReview(axis: "implementation", raw: string | undefined, packet: DeliveryReviewPacket): ImplementationReview;
function parseReview(axis: "requirements", raw: string | undefined, packet: DeliveryReviewPacket): RequirementsReview;
function parseReview(axis: DeliveryReviewAxis, raw: string | undefined, packet: DeliveryReviewPacket) {
  const value = object(JSON.parse(raw ?? "null"));
  const facts = new Map(packet.evidence.map(item => [item.id, item.text]));
  if (axis === "implementation") {
    const finding = parseFinding(value, facts);
    if (!packet.evidence.some(item => item.kind === "change" && finding.evidence.some(quote => quote.ref === item.id))) {
      throw Error("实现复核缺少当前提交的代码或测试证据。");
    }
    return finding;
  }
  const expected = new Map(packet.criteria.map(item => [item.criterion, item.text]));
  if (!Array.isArray(value.criteria) || value.criteria.length !== expected.size) throw Error("需求复核必须覆盖每项绑定验收。");
  const criteria = (value.criteria as unknown[]).map(item => {
    const row = object(item);
    const id = row.criterion;
    if (typeof id !== "string" || !expected.has(id)) throw Error("需求复核引用了未知或重复的验收项。");
    const criterionRef = `criterion:${id}`;
    const finding = parseFinding(row, new Map([...facts, [criterionRef, expected.get(id) ?? ""]]));
    expected.delete(id);
    if (!finding.evidence.some(quote => quote.ref === criterionRef)
      || (finding.status === "pass" && packet.evidence.some(evidence => evidence.kind === "verification"
        && evidence.criteria.includes(id) && (evidence.outcome === "partial" || evidence.outcome === "fail")))
      || (finding.status === "pass" && !packet.evidence.some(evidence => evidence.kind === "verification"
        && (evidence.outcome === undefined || evidence.outcome === "pass") && evidence.criteria.includes(id)
        && finding.evidence.some(quote => quote.ref === evidence.id)))) throw Error("需求复核缺少该验收项或实际验证的证据。");
    return { criterion: id, ...finding };
  });
  return { criteria };
}

export function deliveryReviewPacketId(packet: DeliveryReviewPacket) {
  return createHash("sha256").update(JSON.stringify(packet)).digest("hex");
}

export async function reviewDelivery(packet: DeliveryReviewPacket, run: DeliveryReviewer, signal: AbortSignal): Promise<DeliveryReviewReceipt> {
  // 两次调用都只收到同一份快照，任何一方的判断都不会作为另一方的输入。
  signal.throwIfAborted();
  const packetId = deliveryReviewPacketId(packet);
  if (!packet.criteria.length || new Set(packet.criteria.map(item => item.criterion)).size !== packet.criteria.length
    || new Set(packet.evidence.map(item => item.id)).size !== packet.evidence.length
    || packet.evidence.some(item => item.id.startsWith("criterion:"))) return { packetId, key: packet.key, status: "incomplete" };
  const [implementation, requirements] = await Promise.allSettled([
    Promise.resolve().then(() => run("implementation", structuredClone(packet), signal)).then(raw => parseReview("implementation", raw, packet)),
    Promise.resolve().then(() => run("requirements", structuredClone(packet), signal)).then(raw => parseReview("requirements", raw, packet)),
  ]);
  signal.throwIfAborted();
  const code = implementation.status === "fulfilled" ? implementation.value : undefined;
  const product = requirements.status === "fulfilled" ? requirements.value : undefined;
  const blocked = code?.status === "block" || product?.criteria.some(item => item.status === "block");
  return { packetId, key: packet.key, ...(code ? { implementation: code } : {}), ...(product ? { requirements: product } : {}),
    status: blocked ? "block" : code && product ? "pass" : "incomplete" };
}
