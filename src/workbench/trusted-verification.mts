import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { scrubAuditText } from "../audit/activity-store.mts";
import { contentDigest, workerCommit, workerDigest } from "../execution/code-worker-protocol.mts";
import { qualityBindingCurrent } from "../planning/dispatch-quality.mts";
import type { DeliveryCriterion, DeliveryEvidence, DeliveryReviewKey, DeliveryReviewScope } from "../planning/delivery-review.mts";
import type { Claim } from "./issue-dispatch.mts";

export type TrustedVerificationConfig = { path: string; sha256: string };
export type VerificationBundle = {
  version: 1; repo: string; issue: number; issueRevision: string; pull: number; head: string;
  plan: DeliveryReviewKey["plan"]; integration: string; observedAt: string; expiresAt: string;
  verifiedBy: string; environment: string; publicSafe: true;
  files: { path: string; sha256: string }[];
  results: { criterion: string; criterionDigest: string; outcome: "pass" | "partial" | "fail"; facts: string; files: string[] }[];
};
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const exactKeys = (value: object, keys: string[]) => Object.keys(value).sort().join() === [...keys].sort().join();
const text = (value: unknown, max: number): value is string => typeof value === "string" && !!value.trim() && value.length <= max;
const positive = (value: unknown) => Number.isSafeInteger(value) && Number(value) > 0;
const safePath = /^(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9][A-Za-z0-9_.-]*\.(?:md|txt|json|png|jpg|jpeg|webp)$/;
const invalid = () => Error("运行验收包无效：需要受信配置、固定版本、公开安全材料和完整摘要。");

export const verificationCriterionDigest = ({ criterion, text, procedure, expected }: DeliveryCriterion) =>
  contentDigest(JSON.stringify({ criterion, text, procedure, expected }));

export function readTrustedVerificationConfig(raw: string): TrustedVerificationConfig {
  try {
    const value = JSON.parse(raw) as TrustedVerificationConfig;
    if (!value || !exactKeys(value, ["path", "sha256"]) || !text(value.path, 4096) || !isAbsolute(value.path)
      || !workerDigest.test(value.sha256)) throw invalid();
    return value;
  } catch { throw invalid(); }
}

function readOrdinaryFile(path: string, bytes: number) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.size < 1 || stat.size > bytes || realpathSync(path) !== path) throw invalid();
  const result = readFileSync(path);
  if (result.length !== stat.size) throw invalid();
  return result;
}

function parseBundle(bytes: Buffer): VerificationBundle {
  try {
    const bundle = JSON.parse(bytes.toString("utf8")) as VerificationBundle;
    if (!exactKeys(bundle, ["version", "repo", "issue", "issueRevision", "pull", "head", "plan", "integration", "observedAt", "expiresAt",
      "verifiedBy", "environment", "publicSafe", "files", "results"]) || bundle.version !== 1 || bundle.publicSafe !== true
      || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(bundle.repo) || !positive(bundle.issue) || !positive(bundle.pull)
      || !workerDigest.test(bundle.issueRevision) || !workerCommit.test(bundle.head) || !workerCommit.test(bundle.integration)
      || !exactKeys(bundle.plan, ["id", "version", "quality"]) || !text(bundle.plan.id, 200) || !positive(bundle.plan.version)
      || !qualityBindingCurrent(bundle.plan.quality) || !text(bundle.verifiedBy, 120) || !text(bundle.environment, 1000)
      || !text(bundle.observedAt, 64) || !text(bundle.expiresAt, 64)
      || !Number.isFinite(Date.parse(bundle.observedAt)) || !(Date.parse(bundle.expiresAt) > Date.parse(bundle.observedAt))
      || !Array.isArray(bundle.files) || !bundle.files.length || bundle.files.length > 16
      || new Set(bundle.files.map(file => file.path)).size !== bundle.files.length
      || bundle.files.some(file => !exactKeys(file, ["path", "sha256"]) || !safePath.test(file.path) || !workerDigest.test(file.sha256))
      || !Array.isArray(bundle.results) || !bundle.results.length || bundle.results.length > 32
      || new Set(bundle.results.map(row => row.criterion)).size !== bundle.results.length
      || bundle.results.some(row => !exactKeys(row, ["criterion", "criterionDigest", "outcome", "facts", "files"])
        || !/^AC-\d+$/.test(row.criterion) || !workerDigest.test(row.criterionDigest)
        || !["pass", "partial", "fail"].includes(row.outcome) || !text(row.facts, 4000)
        || !Array.isArray(row.files) || !row.files.length || new Set(row.files).size !== row.files.length
        || row.files.some(path => !bundle.files.some(file => file.path === path)))) throw invalid();
    return bundle;
  } catch { throw invalid(); }
}

// 配置只由启动参数/.env 提供；PR、模型输出和 HTTP 请求均没有写入此入口的能力。
export function loadTrustedVerification(config: TrustedVerificationConfig, workspace: string, now = Date.now) {
  const checkedConfig = readTrustedVerificationConfig(JSON.stringify(config));
  let bundle: VerificationBundle;
  let root: string;
  try {
    const bytes = readOrdinaryFile(checkedConfig.path, 128 * 1024);
    if (digest(bytes) !== checkedConfig.sha256) throw invalid();
    bundle = parseBundle(bytes);
    root = realpathSync(dirname(checkedConfig.path));
    const git = (...args: string[]) => execFileSync("git", ["-C", workspace, "-c", "core.hooksPath=/dev/null", ...args], {
      encoding: "utf8", timeout: 10_000, maxBuffer: 4096, stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GIT_NO_REPLACE_OBJECTS: "1" },
    }).trim();
    if (git("cat-file", "-t", bundle.head) !== "commit" || git("cat-file", "-t", bundle.integration) !== "commit") throw invalid();
    git("merge-base", "--is-ancestor", bundle.head, bundle.integration);
  } catch { throw invalid(); }
  let materialCache: { signature: string; valid: boolean } | undefined;
  const materialSignature = () => JSON.stringify([checkedConfig.path, ...bundle.files.map(file => join(root, file.path))].map(path => {
    const stat = lstatSync(path, { bigint: true });
    if (!stat.isFile() || realpathSync(path) !== path) throw invalid();
    return [path, stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].map(String);
  }));
  const materialsCurrent = (force: boolean) => {
    try {
      const signature = materialSignature();
      if (!force && signature === materialCache?.signature) return materialCache.valid;
      let total = 0;
      const valid = digest(readOrdinaryFile(checkedConfig.path, 128 * 1024)) === checkedConfig.sha256 && bundle.files.every(file => {
        const path = join(root, file.path);
        if (relative(root, path) !== file.path) return false;
        const bytes = readOrdinaryFile(path, 8 * 1024 * 1024);
        total += bytes.length;
        return total <= 32 * 1024 * 1024 && digest(bytes) === file.sha256;
      }) && materialSignature() === signature;
      materialCache = { signature, valid };
      return valid;
    } catch { return false; }
  };
  if (!materialsCurrent(true)) throw invalid();
  return {
    observe(repo: string, claim: Claim, scope: DeliveryReviewScope | undefined, force = false) {
      if (bundle.repo.toLowerCase() !== repo.toLowerCase() || bundle.issue !== claim.number) return;
      const approval = claim.approval;
      const current = scope && approval && bundle.pull === claim.pull?.number && bundle.head === claim.pull.head
        && bundle.issueRevision === approval.issueRevision && isDeepStrictEqual(bundle.plan,
          { id: approval.planId, version: approval.version, quality: approval.quality })
        && now() >= Date.parse(bundle.observedAt) && now() < Date.parse(bundle.expiresAt) && materialsCurrent(force)
        && bundle.results.every(row => scope.criteria.some(criterion => criterion.criterion === row.criterion
          && verificationCriterionDigest(criterion) === row.criterionDigest));
      const version = `${current ? "verified" : "inactive"}:${checkedConfig.sha256}`;
      if (!current) return { version };
      const verification = { digest: checkedConfig.sha256, integration: bundle.integration, observedAt: bundle.observedAt, expiresAt: bundle.expiresAt };
      const evidence: DeliveryEvidence[] = bundle.results.map(row => ({ id: `verification:run:${checkedConfig.sha256}:${row.criterion}`,
        kind: "verification", criteria: [row.criterion], outcome: row.outcome,
        text: scrubAuditText([
          `维护者核验：${bundle.verifiedBy}；实际运行：${bundle.observedAt}；有效期：${bundle.expiresAt}`,
          `环境：${bundle.environment}；集成提交：${bundle.integration}（Git 祖先包含业务头 ${bundle.head}）。`,
          `验收项：${row.criterion}；结论：${row.outcome}；实际事实：${row.facts}`,
          ...row.files.map(path => `公开证据：${path}；SHA-256 ${bundle.files.find(file => file.path === path)?.sha256}`),
          "这些是集成运行事实；图片和视频原件未发送给模型，不证明单独业务提交的运行结果。",
        ].join("\n")),
      }));
      return { version, verification, evidence };
    },
  };
}
export type TrustedVerification = ReturnType<typeof loadTrustedVerification>;
