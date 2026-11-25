import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { basename } from "node:path";
import { promisify } from "node:util";
import { qualitySourceInputBytes, runtimeInteger } from "../config/runtime.mts";
import type { ProjectEvidence, PlanningSourceFile } from "../planning/project-context.mts";
import { qualitySourcePath, qualitySources } from "./codex-quality-review.mts";

const git = promisify(execFile);
const sourceName = /(?<![\w./\\])(?:[a-z\d_.-]+\/)*(?:AGENTS\.md|[a-z\d_-][a-z\d_.-]*\.(?:mts|mjs|md|html|css|ts|js|json))(?![\w./\\])/gi;
const digest = (text: string) => createHash("sha256").update(text).digest("hex");

export async function freezePlanningSources(workspace: string, revision: string, material: readonly string[],
  limit = runtimeInteger("SOULFLOW_PLANNING_SOURCE_MAX_FILES", 1, 12)) {
  const references = [...new Set(material.flatMap(text => [...text.matchAll(sourceName)].map(match => match[0])))];
  if (!references.length || !/^[a-f0-9]{40,64}$/.test(revision)) return;
  const { stdout } = await git("git", ["-C", workspace, "ls-tree", "-r", "--name-only", revision], {
    timeout: 5000, env: { ...process.env, GIT_NO_REPLACE_OBJECTS: "1" },
  });
  const catalog = new Set(stdout.split("\n").filter(qualitySourcePath));
  const simple = new Map<string, string | null>();
  for (const path of catalog) {
    const name = basename(path);
    simple.set(name, simple.has(name) ? null : path);
  }
  const paths = [...new Set(references.flatMap(reference => {
    if (catalog.has(reference)) return [reference];
    // 对缩写只在文件名唯一时补全。明确路径找不到时仍标出缺证。
    const path = reference.includes("/") ? (qualitySourcePath(reference) ? reference : undefined) : simple.get(reference);
    return path ? [path] : [];
  }))];
  if (!paths.length) return;
  const requested = paths.slice(0, limit);
  const contents = await qualitySources(workspace, revision, requested, AbortSignal.timeout(12_000));
  return { files: requested.map((path): PlanningSourceFile => {
    const text = contents[path];
    return typeof text === "string" ? { path, status: "read", bytes: Buffer.byteLength(text), sha256: digest(text) }
      : { path, status: "unavailable" };
  }), omitted: paths.length - requested.length };
}

export async function frozenPlanningInput(workspace: string, evidence: ProjectEvidence | undefined) {
  const revision = evidence?.repository?.revision;
  const manifest = evidence?.planningSources?.files.filter(entry => entry.status === "read");
  if (!revision || !manifest?.length) return;
  const contents = await qualitySources(workspace, revision, manifest.map(entry => entry.path), AbortSignal.timeout(12_000),
    Math.min(qualitySourceInputBytes(), manifest.reduce((sum, entry) => sum + entry.bytes, 0)));
  if (!manifest.every(entry => typeof contents[entry.path] === "string" && digest(contents[entry.path] ?? "") === entry.sha256)) {
    throw Error("固定规划源码资料已不可读，请重新绑定项目资料。");
  }
  return JSON.stringify({ kind: "frozen-planning-sources", revision, files: contents });
}
