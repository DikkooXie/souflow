import { createHash } from "node:crypto";
import { scrubAuditText } from "../audit/activity-store.mts";
import type { Flow } from "./conversation-flow.mts";
import { ticketDeliveryLines, type TicketDelivery } from "./ticket-delivery.mts";
import { type TicketDraft, validateTicketPlan } from "./validate-ticket-plan.mts";

const version = 1;
const kinds = ["research", "requirements", "technology", "prd", "development-plan"] as const;
const dimensions = ["scope", "evidence", "verification"] as const;
const details = { scope: "范围", evidence: "依据", verification: "验证" };
export const qualityReviewLimits = {
  summaryCharacters: 500,
  quoteMinCharacters: 2,
  quoteCharacters: 240,
  references: { scope: 6, evidence: 6, verification: 24 },
  breakdownReferences: 3,
} as const;
const requiredUpstream = {
  research: ["request"], requirements: ["research"], technology: ["requirements"], prd: ["requirements"],
  "development-plan": ["prd", "technology"],
} as const;

export type Verification = { criterion: string; procedure: string; expected: string };
export type QualityTicket = TicketDraft & {
  title: string; instructions: string; validation: readonly Verification[]; paths: readonly string[];
  sources?: readonly string[]; issue?: { revision: string; text: string }; delivery?: TicketDelivery;
};
export type PlannedTicket = QualityTicket & { delivery: TicketDelivery };
export type Quote = { ref: string; quote: string };
type Finding = { status: "pass" | "block"; summary: string; evidence: Quote[] };
export type QualityReceipt = {
  policy: number; flowDigest: string; batchDigest: string;
  documents: { kind: string; id: string; version: number }[];
  checks: Record<(typeof dimensions)[number], Finding>;
  breakdown?: (Finding & { ticket: string })[];
};
export type QualityBinding = Pick<QualityReceipt, "policy" | "flowDigest" | "batchDigest">;
export type QualityReviewer = (packet: QualityPacket, signal: AbortSignal) => Promise<string | undefined>;
export const verificationSchema = {
  type: "array", items: { type: "object", additionalProperties: false, required: ["criterion", "procedure", "expected"],
    properties: { criterion: { type: "string" }, procedure: { type: "string" }, expected: { type: "string" } } },
};

const hash = (item: unknown) => createHash("sha256").update(JSON.stringify(item)).digest("hex");

function object(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
}

export function acceptanceCriteria(flow: Flow) {
  const text = flow.outputs.flatMap(output => output.artifacts).find(artifact => artifact.kind === "requirements")
    ?.sections.find(section => section.title === "验收条件")?.text ?? "";
  return text.split(/\r?\n/).map(line => line.trim()).filter(Boolean).map((text, i) => ({ id: `AC-${i + 1}`, text }));
}

export function readVerification(raw: unknown, criteria: readonly string[]) {
  if (!Array.isArray(raw) || raw.length !== criteria.length || new Set(criteria).size !== criteria.length) {
    throw Error("工单校验未通过：每项验收引用需要一条验证步骤和预期结果。");
  }
  const seen = new Set(criteria);
  return raw.map(item => {
    const { criterion, procedure, expected } = object(item) ?? {};
    if (typeof criterion !== "string" || !seen.delete(criterion) || typeof procedure !== "string" || !procedure.trim()
      || procedure.length > 500 || typeof expected !== "string" || !expected.trim() || expected.length > 300) {
      throw Error(`工单校验未通过：${typeof criterion === "string" ? scrubAuditText(criterion).slice(0, 30) : "验收项"} 缺少有效验证步骤或预期结果。`);
    }
    return { criterion, procedure: scrubAuditText(procedure.trim()), expected: scrubAuditText(expected.trim()) };
  });
}

function planningDocuments(flow: Flow) {
  if (flow.status !== "ready" || flow.source.kind !== "request" || !flow.source.id || !Number.isSafeInteger(flow.source.version) || flow.source.version < 1
    || flow.source.upstream.length || !flow.prompt.trim()) throw Error("工单校验未通过：缺少有效原始需求。");
  const artifacts = flow.outputs.flatMap(output => output.artifacts);
  const byKind = new Map<string, { id: string; version: number }>([["request", flow.source]]);
  const ids = new Set([flow.source.id]);
  const documents = kinds.map(kind => {
    const found = artifacts.filter(item => item.kind === kind);
    const artifact = found[0];
    const upstream = requiredUpstream[kind].map(input => byKind.get(input));
    if (found.length !== 1 || !artifact || !artifact.id || ids.has(artifact.id) || !Number.isSafeInteger(artifact.version)
      || artifact.version < 1 || !artifact.sections.length || artifact.sections.some(section => !section.text.trim())
      || artifact.upstream.length !== upstream.length
      || upstream.some(parent => !parent || artifact.upstream.filter(item => item.id === parent.id && item.version === parent.version).length !== 1)) {
      throw Error(`工单校验未通过：${kind} 的当前版本、正文或上游引用不完整。`);
    }
    byKind.set(kind, artifact);
    ids.add(artifact.id);
    return artifact;
  });
  const drafts = artifacts.filter(item => item.kind === "ticket-drafts");
  const plan = byKind.get("development-plan");
  if (drafts.length > 1 || drafts.some(draft => !draft.id || ids.has(draft.id) || !Number.isSafeInteger(draft.version) || draft.version < 1
    || draft.upstream.length !== 1 || draft.upstream[0]?.id !== plan?.id || draft.upstream[0]?.version !== plan?.version)) {
    throw Error("工单校验未通过：草稿引用的开发计划已经变化。");
  }
  return { source: flow.source, request: flow.prompt, clarifications: flow.clarifications, documents: [...documents, ...drafts],
    criteria: acceptanceCriteria(flow), project: flow.project };
}

export function planningDigest(flow: Flow) {
  try { return hash(planningDocuments(flow)); } catch { return undefined; }
}

export function qualityPacket(flow: Flow, revision: string, id: string, tickets: readonly QualityTicket[],
  sources: Readonly<Record<string, string>> = {}) {
  const planning = planningDocuments(flow);
  const errors = validateTicketPlan(planning.criteria.map(item => item.id), tickets);
  if (errors.length || planning.criteria.length > 24 || !/^[a-f0-9]{40,64}$/.test(revision)
    || (flow.project?.repository && flow.project.repository.revision !== revision)) {
    throw Error(`工单校验未通过：${errors.join("、") || "验收项或仓库版本不匹配"}。`);
  }
  for (const ticket of tickets) readVerification(ticket.validation, ticket.criteria);
  // 批次中的结构工单引用当前计划，即使改版后旧的文字草稿已移入历史。
  const references = Object.fromEntries([
    ["request", planning.request],
    ...(planning.clarifications ?? []).map(({ cardId, questionId, question, answer }) =>
      [`clarification:${cardId}:${questionId}`, `${question}\n${answer}`]),
    ...planning.documents.map(artifact => [artifact.kind, artifact.sections.map(section => section.text).join("\n")]),
    ...planning.criteria.map(({ id, text }) => [`criterion:${id}`, text]),
    ...tickets.flatMap(ticket => [
      [`ticket:${ticket.id}`, [ticket.title, ticket.instructions, ...(ticket.delivery ? ticketDeliveryLines(ticket.delivery) : [])].join("\n")],
      ...ticket.validation.map(({ criterion, procedure, expected }) => [`test:${ticket.id}:${criterion}`, `${procedure}\n${expected}`]),
      ...(ticket.issue ? [[`issue:${ticket.id}`, ticket.issue.text]] : []),
    ]),
    ...Object.entries(sources).map(([path, text]) => [`repo:${path}`, text]),
  ]);
  return { planning, references, revision, id, tickets };
}

export type QualityPacket = ReturnType<typeof qualityPacket>;

const findingFields = {
  status: { type: "string", enum: ["pass", "block"] }, summary: { type: "string" },
  evidence: { type: "array", items: { type: "object", additionalProperties: false, required: ["ref", "quote"],
    properties: { ref: { type: "string" }, quote: { type: "string" } } } },
};

export function qualityReviewSchema(ticketBreakdown: boolean) {
  const finding = { type: "object", additionalProperties: false, required: Object.keys(findingFields), properties: findingFields };
  const properties = {
    ...Object.fromEntries(dimensions.map(key => [key, finding])),
    ...(ticketBreakdown ? { breakdown: { type: "array", items: { ...finding,
      required: ["ticket", ...finding.required], properties: { ticket: { type: "string" }, ...findingFields } } } } : {}),
  };
  return { type: "object", additionalProperties: false, required: Object.keys(properties), properties };
}

export function qualityReviewOutputBytes(packet: QualityPacket) {
  const longest = Object.keys(packet.references).reduce((key, next) =>
    Buffer.byteLength(JSON.stringify(next)) > Buffer.byteLength(JSON.stringify(key)) ? next : key, "");
  // 用需要六字节转义的字符估算上限，并为模型输出的缩进留出空间。
  const finding = (count: number) => ({ status: "block", summary: "\0".repeat(qualityReviewLimits.summaryCharacters),
    evidence: Array.from({ length: count }, () => ({ ref: longest, quote: "\0".repeat(qualityReviewLimits.quoteCharacters) })) });
  const documents = Object.fromEntries(dimensions.map(dimension => [dimension, finding(qualityReviewLimits.references[dimension])]));
  const breakdown = packet.tickets.some(ticket => ticket.delivery)
    ? packet.tickets.map(ticket => ({ ticket: ticket.id, ...finding(qualityReviewLimits.breakdownReferences) })) : undefined;
  return Buffer.byteLength(JSON.stringify({ ...documents, breakdown }, undefined, 2));
}

function readFinding(value: unknown, packet: QualityPacket, referenceLimit: number): Finding {
  const row = object(value);
  if (!row || (row.status !== "pass" && row.status !== "block") || typeof row.summary !== "string"
    || !row.summary.trim() || row.summary.length > qualityReviewLimits.summaryCharacters || !Array.isArray(row.evidence)
    || !row.evidence.length || row.evidence.length > referenceLimit) {
    throw Error("质量复核结论缺少依据，可以重试。");
  }
  const evidence = row.evidence.map(entry => {
    const { ref, quote } = object(entry) ?? {};
    if (typeof ref !== "string" || typeof quote !== "string" || quote.trim().length < qualityReviewLimits.quoteMinCharacters
      || quote.length > qualityReviewLimits.quoteCharacters
      || !Object.hasOwn(packet.references, ref) || !packet.references[ref]?.includes(quote)) {
      throw Error("质量复核引用无法在本轮资料找到，可以重试。");
    }
    return { ref, quote: scrubAuditText(quote) };
  });
  return { status: row.status, summary: scrubAuditText(row.summary), evidence };
}

function readBreakdown(raw: unknown, packet: QualityPacket) {
  const remaining = new Set(packet.tickets.map(ticket => ticket.id));
  if (!Array.isArray(raw) || raw.length !== remaining.size) throw Error("质量复核缺少逐单拆分结论，可以重试。");
  return raw.map(row => {
    const ticket = object(row)?.ticket;
    if (typeof ticket !== "string" || !remaining.delete(ticket)) throw Error("质量复核的逐单结论未对应本轮工单。");
    const finding = readFinding(row, packet, qualityReviewLimits.breakdownReferences);
    if (!finding.evidence.some(({ ref }) => ref === `ticket:${ticket}`)) {
      throw Error(`质量复核未引用 ${ticket} 的拆分依据。`);
    }
    return { ticket, ...finding };
  });
}

export async function reviewQuality(packet: QualityPacket, payload: unknown, reviewer: QualityReviewer, signal: AbortSignal): Promise<QualityReceipt> {
  const flowDigest = hash(packet.planning);
  const batchDigest = hash(payload);
  const output = await reviewer(packet, signal);
  signal.throwIfAborted();
  const parsed = object(JSON.parse(output ?? "null"));
  const planned = packet.tickets.some(ticket => ticket.delivery);
  if (!parsed || Object.keys(parsed).length !== dimensions.length + Number(planned)) {
    throw Error("质量复核未返回完整结果，可以重试。");
  }
  const entries = dimensions.map(key => {
    const finding = readFinding(parsed[key], packet, qualityReviewLimits.references[key]);
    if (finding.status === "pass" && key === "verification" && packet.planning.criteria.some(({ id }) =>
      !finding.evidence.some(item => item.ref.startsWith("test:") && item.ref.endsWith(`:${id}`)))) {
      throw Error("质量复核未给出每项验收的验证依据，可以重试。");
    }
    return [key, finding] as const;
  });
  const { source, documents } = packet.planning;
  return { policy: version, flowDigest, batchDigest,
    documents: [source, ...documents].map(({ kind, id, version }) => ({ kind, id, version })),
    checks: Object.fromEntries(entries) as QualityReceipt["checks"],
    ...(planned ? { breakdown: readBreakdown(parsed.breakdown, packet) } : {}) };
}

export function qualityBlock(receipt: QualityReceipt) {
  const documents = dimensions.flatMap(key => {
    const check = receipt.checks[key];
    return check.status === "block" ? [`${details[key]}：${check.summary}`] : [];
  });
  const tickets = receipt.breakdown?.filter(finding => finding.status === "block").map(finding => `${finding.ticket}：${finding.summary}`) ?? [];
  return [...documents, ...tickets].join("\n");
}

export function qualityCurrent(receipt: QualityReceipt | undefined, flow: Flow | undefined, payload: unknown) {
  return !!receipt && qualityBindingCurrent(receipt) && !!flow && receipt.flowDigest === planningDigest(flow)
    && receipt.batchDigest === hash(payload) && dimensions.every(key => receipt.checks?.[key]?.status === "pass")
    && (receipt.breakdown?.every(finding => finding.status === "pass") ?? true);
}

export function qualityBindingCurrent(binding: QualityBinding | undefined) {
  return !!binding && binding.policy === version && /^[a-f0-9]{64}$/.test(binding.flowDigest)
    && /^[a-f0-9]{64}$/.test(binding.batchDigest);
}
