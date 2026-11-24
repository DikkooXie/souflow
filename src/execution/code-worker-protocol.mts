import { createHash } from "node:crypto";
import { deliveryPath, maxCodeProposalBytes } from "./local-code-changes.mts";

export const workerProtocolVersion = 1;
export const workerWaitMs = 20_000;
export const workerMaxSlots = 6;
export const workerMessageBytes = 2 * 1024 * 1024;
export const workerId = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
export const workerCommit = /^[a-f0-9]{40}$/;
export const workerDigest = /^[a-f0-9]{64}$/;
export const contentDigest = (value: string) => createHash("sha256").update(value).digest("hex");

export type CodeWork = {
  repo: string;
  issue: number;
  issueRevision: string;
  revision: string;
  upstream: string[];
  plan: { flowId: string; version: number; flowDigest: string; batchDigest: string };
  files: { path: string; sha256: string }[];
  instructions: string;
  context: string;
};

export type CodeOffer = { version: number; id: string; digest: string; work: CodeWork };
export type CodeReceipt = { id: string; digest: string } & (
  | { phase: "accepted"; at: number }
  | { phase: "started"; at: number; thread: string }
  | { phase: "tested"; at: number; output: string; patch: string }
  | { phase: "declined" | "interrupted" | "failed"; at: number }
);

function object(input: unknown): Record<string, unknown> | undefined {
  if (input && typeof input === "object" && !Array.isArray(input)) return input as Record<string, unknown>;
}

const matches = (value: unknown, format: RegExp): value is string => typeof value === "string" && format.test(value);
const positive = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const repoPattern = /^[a-z\d][a-z\d-]{0,38}\/[a-z\d_.-]{1,100}$/i;

export function readWorkerCapacity(input: unknown) {
  const value = object(input);
  if (!value || value.version !== workerProtocolVersion || !matches(value.instance, workerId)
      || !matches(value.repo, repoPattern) || !positive(value.slots) || value.slots > workerMaxSlots || typeof value.ready !== "boolean") return;
  return { instance: value.instance, repo: value.repo.toLowerCase(), slots: value.slots, ready: value.ready };
}

export function validCodeWork(input: unknown): input is CodeWork {
  const work = object(input);
  const plan = object(work?.plan);
  if (!work || !plan || !matches(work.repo, repoPattern) || !positive(work.issue) || !matches(work.issueRevision, workerDigest)
      || !matches(work.revision, workerCommit) || !matches(plan.flowId, workerId) || !positive(plan.version)
      || !matches(plan.flowDigest, workerDigest) || !matches(plan.batchDigest, workerDigest)
      || !Array.isArray(work.upstream) || work.upstream.length > 24 || !work.upstream.every(item => matches(item, workerCommit))
      || !Array.isArray(work.files) || !work.files.length || work.files.length > 16
      || typeof work.instructions !== "string" || !work.instructions.trim() || work.instructions.length > 12_000
      || typeof work.context !== "string" || Buffer.byteLength(work.context) > 896 * 1024) return false;
  const paths = new Set<string>();
  for (const inputFile of work.files) {
    const file = object(inputFile);
    if (!file || !matches(file.path, deliveryPath) || !matches(file.sha256, workerDigest) || paths.has(file.path.toLowerCase())) return false;
    paths.add(file.path.toLowerCase());
  }
  return true;
}

export function readCodeOffer(input: unknown): CodeOffer | undefined {
  const offer = object(input);
  if (!offer || offer.version !== workerProtocolVersion || !matches(offer.id, workerId) || !matches(offer.digest, workerDigest)
      || !validCodeWork(offer.work) || contentDigest(JSON.stringify(offer.work)) !== offer.digest) return;
  return { version: offer.version, id: offer.id, digest: offer.digest, work: offer.work };
}

export function readCodeReceipt(input: unknown): CodeReceipt | undefined {
  const value = object(input);
  if (!value || !matches(value.id, workerId) || !matches(value.digest, workerDigest) || !positive(value.at)) return;
  const fields = { id: value.id, digest: value.digest, at: value.at };
  const phase = value.phase;
  if (phase === "accepted" || phase === "declined" || phase === "interrupted" || phase === "failed") return { ...fields, phase };
  if (phase === "started" && typeof value.thread === "string" && /^[a-z0-9_-]{1,128}$/i.test(value.thread)) {
    return { ...fields, phase, thread: value.thread };
  }
  if (phase === "tested" && typeof value.output === "string" && Buffer.byteLength(value.output) <= maxCodeProposalBytes
      && matches(value.patch, workerDigest)) return { ...fields, phase, output: value.output, patch: value.patch };
}
