import { createHash } from "node:crypto";
import { codeEditFileHardLimit, type CodeWorkerConfig, readCodeWorkerConfig } from "../config/runtime.mts";
import { deliveryPath, maxCodeProposalBytes } from "./local-code-changes.mts";
import { readIsolationEvidence, type IsolationEvidence } from "./isolation-evidence.mts";
import { readPatchDiagnostics, type PatchDiagnostic } from "./patch-diagnostics.mts";

export const workerProtocolVersion = 1;
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
  files: { path: string; sha256: string; bytes?: number }[];
  instructions: string;
  context: string;
  previousCandidatePatch?: { patch: string; sha256: string };
};

export type CodeOffer = { version: number; id: string; digest: string; work: CodeWork };
export type WorkerFailureStage = "checkout" | "codex" | "patch" | "dependencies" | "tests";
export type CandidateFile = { path: string; before: string; after: string; mode: 0o100644 | 0o100755 };
export type CodeReceipt = { id: string; digest: string } & (
  | { phase: "accepted"; at: number }
  | { phase: "started"; at: number; thread: string }
  | { phase: "tested"; at: number; output: string; patch: string; patchDiagnostics?: PatchDiagnostic[] }
  | { phase: "declined" | "interrupted"; at: number }
  | { phase: "failed"; at: number; failureStage?: WorkerFailureStage; isolation?: IsolationEvidence; patchDiagnostics?: PatchDiagnostic[];
      candidateDigest?: string; candidateFiles?: CandidateFile[]; candidatePatch?: string; candidatePatchDigest?: string }
);

export function compactCodeFailure(receipt: CodeReceipt): CodeReceipt {
  return { id: receipt.id, digest: receipt.digest, at: receipt.at, phase: "failed",
    ...(receipt.phase === "tested" ? { failureStage: "patch" }
      : receipt.phase === "failed" && receipt.failureStage ? { failureStage: receipt.failureStage } : {}),
    ...("patchDiagnostics" in receipt && receipt.patchDiagnostics ? { patchDiagnostics: receipt.patchDiagnostics } : {}) };
}

function object(input: unknown): Record<string, unknown> | undefined {
  if (input && typeof input === "object" && !Array.isArray(input)) return input as Record<string, unknown>;
}

const matches = (value: unknown, format: RegExp): value is string => typeof value === "string" && format.test(value);
const positive = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const repoPattern = /^[a-z\d][a-z\d-]{0,38}\/[a-z\d_.-]{1,100}$/i;

export function readWorkerCapacity(input: unknown, maxSlots: number) {
  const value = object(input);
  if (!value || value.version !== workerProtocolVersion || !matches(value.instance, workerId)
      || !matches(value.repo, repoPattern) || !positive(value.slots) || value.slots > maxSlots || typeof value.ready !== "boolean") return;
  const bytes = value.editFileBytes;
  if (bytes !== undefined && (!positive(bytes) || bytes > codeEditFileHardLimit)) return;
  return { instance: value.instance, repo: value.repo.toLowerCase(), slots: value.slots, ready: value.ready,
    ...(bytes === undefined ? {} : { editFileBytes: bytes }) };
}

export function validCodeWork(input: unknown, config: CodeWorkerConfig): input is CodeWork {
  const work = object(input);
  const plan = object(work?.plan);
  if (!work || !plan || !matches(work.repo, repoPattern) || !positive(work.issue) || !matches(work.issueRevision, workerDigest)
      || !matches(work.revision, workerCommit) || !matches(plan.flowId, workerId) || !positive(plan.version)
      || !matches(plan.flowDigest, workerDigest) || !matches(plan.batchDigest, workerDigest)
      || !Array.isArray(work.upstream) || work.upstream.length > config.maxUpstream || !work.upstream.every(item => matches(item, workerCommit))
      || !Array.isArray(work.files) || !work.files.length || work.files.length > config.maxFiles
      || typeof work.instructions !== "string" || !work.instructions.trim() || work.instructions.length > config.maxInstructions
      || typeof work.context !== "string" || Buffer.byteLength(work.context) > config.maxContextBytes) return false;
  if (work.previousCandidatePatch !== undefined) {
    const candidate = object(work.previousCandidatePatch);
    if (!candidate || Object.keys(candidate).length !== 2 || typeof candidate.patch !== "string"
      || Buffer.byteLength(candidate.patch) > maxCodeProposalBytes || !candidate.patch.startsWith("diff --git ")
      || !matches(candidate.sha256, workerDigest) || contentDigest(candidate.patch) !== candidate.sha256) return false;
  }
  const paths = new Set<string>();
  for (const inputFile of work.files) {
    const file = object(inputFile);
    if (!file || !matches(file.path, deliveryPath) || !matches(file.sha256, workerDigest) || paths.has(file.path.toLowerCase())) return false;
    const bytes = file.bytes;
    if (bytes !== undefined && (typeof bytes !== "number" || !Number.isSafeInteger(bytes) || bytes < 0 || bytes > codeEditFileHardLimit)) return false;
    paths.add(file.path.toLowerCase());
  }
  return true;
}

export function readCodeOffer(input: unknown, config = readCodeWorkerConfig()): CodeOffer | undefined {
  const offer = object(input);
  if (!offer || offer.version !== workerProtocolVersion || !matches(offer.id, workerId) || !matches(offer.digest, workerDigest)
      || !validCodeWork(offer.work, config) || contentDigest(JSON.stringify(offer.work)) !== offer.digest) return;
  return { version: offer.version, id: offer.id, digest: offer.digest, work: offer.work };
}

export function readCodeReceipt(input: unknown, config = readCodeWorkerConfig()): CodeReceipt | undefined {
  const value = object(input);
  if (!value || !matches(value.id, workerId) || !matches(value.digest, workerDigest) || !positive(value.at)) return;
  const fields = { id: value.id, digest: value.digest, at: value.at };
  const phase = value.phase;
  const patchDiagnostics = value.patchDiagnostics === undefined ? undefined : readPatchDiagnostics(value.patchDiagnostics);
  if (value.patchDiagnostics !== undefined && (!patchDiagnostics || !["failed", "tested"].includes(String(phase)))) return;
  if (phase === "accepted" || phase === "declined" || phase === "interrupted") return { ...fields, phase };
  if (phase === "failed") {
    const stage = value.failureStage;
    const isolation = value.isolation === undefined ? undefined : readIsolationEvidence(value.isolation, config.diagnosticMaxBytes);
    const candidateDigest = value.candidateDigest;
    const candidateFiles = value.candidateFiles;
    const candidatePatch = value.candidatePatch;
    const candidatePatchDigest = value.candidatePatchDigest;
    const parsedCandidateFiles: CandidateFile[] | undefined = Array.isArray(candidateFiles) && candidateFiles.length > 0
      && candidateFiles.length <= config.maxFiles ? [] : undefined;
    if (parsedCandidateFiles && Array.isArray(candidateFiles)) {
      for (const [index, item] of candidateFiles.entries()) {
        const file = object(item);
        const previousPath = parsedCandidateFiles[index - 1]?.path;
        if (!file || Object.keys(file).length !== 4 || Object.keys(file).some(key => !["path", "before", "after", "mode"].includes(key))
          || !matches(file.path, deliveryPath) || !matches(file.before, workerDigest) || !matches(file.after, workerDigest)
          || file.before === file.after || (file.mode !== 0o100644 && file.mode !== 0o100755)
          || (index > 0 && (!previousPath || previousPath >= file.path))) return;
        parsedCandidateFiles.push({ path: file.path, before: file.before, after: file.after, mode: file.mode });
      }
    }
    const expectedStep = stage === "dependencies" ? "dependencies" : stage === "tests" ? "quality" : undefined;
    if ((value.isolation !== undefined && (!expectedStep || !isolation || isolation.step !== expectedStep))
      || ((candidateDigest !== undefined || candidateFiles !== undefined)
        && (stage !== "tests" || !isolation || isolation.step !== "quality" || !matches(candidateDigest, workerDigest)
          || !parsedCandidateFiles || contentDigest(JSON.stringify(parsedCandidateFiles)) !== candidateDigest))) return;
    if ((candidatePatch !== undefined || candidatePatchDigest !== undefined)
      && (stage !== "tests" || !isolation || isolation.step !== "quality" || typeof candidatePatch !== "string"
        || Buffer.byteLength(candidatePatch) > maxCodeProposalBytes || !candidatePatch.startsWith("diff --git ")
        || !matches(candidatePatchDigest, workerDigest) || contentDigest(candidatePatch) !== candidatePatchDigest
        || !candidateDigest || !candidateFiles)) return;
    if (stage === undefined) return patchDiagnostics ? undefined : { ...fields, phase };
    if (stage === "checkout" || stage === "codex" || stage === "patch" || stage === "dependencies" || stage === "tests") {
      return { ...fields, phase, failureStage: stage, ...(isolation ? { isolation } : {}),
        ...(patchDiagnostics ? { patchDiagnostics } : {}),
        ...(typeof candidateDigest === "string" && parsedCandidateFiles ? { candidateDigest, candidateFiles: parsedCandidateFiles } : {}),
        ...(typeof candidatePatch === "string" ? { candidatePatch, candidatePatchDigest: candidatePatchDigest as string } : {}) };
    }
  }
  if (phase === "started" && typeof value.thread === "string" && /^[a-z0-9_-]{1,128}$/i.test(value.thread)) {
    return { ...fields, phase, thread: value.thread };
  }
  if (phase === "tested" && typeof value.output === "string" && Buffer.byteLength(value.output) <= maxCodeProposalBytes
      && matches(value.patch, workerDigest)) return { ...fields, phase, output: value.output, patch: value.patch,
        ...(patchDiagnostics ? { patchDiagnostics } : {}) };
}
