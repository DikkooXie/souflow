import { execFile } from "node:child_process";
import { readdir, realpath } from "node:fs/promises";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { contentDigest, type CandidateFile, workerCommit, workerDigest } from "./code-worker-protocol.mts";
import { deliveryPath, maxCodeProposalBytes, readEditableFile } from "./local-code-changes.mts";
import { verifyCandidatePatch } from "./candidate-patch-evidence.mts";
import type { FailedReviewDraft } from "./failed-review-draft.mts";
import type { DeliveryFailure } from "./issue-delivery.mts";

export type CandidateSnapshot = { version: 1; artifact: string; head: string; sha256: string; files: CandidateFile[]; digest: string };
export type CandidateParent = { draft: FailedReviewDraft; files: CandidateFile[]; digest: string };
const exec = promisify(execFile);
const mode = (value: number) => value & 0o100 ? 0o100755 as const : 0o100644 as const;
const git = async (workspace: string, signal: AbortSignal, ...args: string[]) => (await exec("git",
  ["-C", workspace, "-c", "core.hooksPath=/dev/null", ...args],
  { signal, timeout: 10_000, maxBuffer: maxCodeProposalBytes, env: { ...process.env, GIT_NO_REPLACE_OBJECTS: "1" } })).stdout;

export function validCandidateFiles(files: readonly CandidateFile[], allowed: readonly string[]) {
  return files.length > 0 && files.length <= 16 && new Set(files.map(file => file.path)).size === files.length
    && files.every(file => deliveryPath.test(file.path) && allowed.includes(file.path)
      && workerDigest.test(file.before) && workerDigest.test(file.after) && file.before !== file.after
      && [0o100644, 0o100755].includes(file.mode));
}

export async function readCandidateSnapshot(workspace: string, head: string, allowed: readonly string[], signal: AbortSignal): Promise<CandidateSnapshot> {
  if (!workerCommit.test(head) || (await git(workspace, signal, "rev-parse", "HEAD")).trim() !== head) throw Error("候选基线已变化。");
  const entries = (await git(workspace, signal, "diff", "--no-ext-diff", "--no-textconv", "--name-status", "--no-renames", "-z", "HEAD", "--"))
    .split("\0").slice(0, -1);
  const files: CandidateFile[] = [];
  for (let index = 0; index < entries.length; index += 2) {
    const path = entries[index + 1];
    if (entries[index] !== "M" || !path || !deliveryPath.test(path) || !allowed.includes(path)) throw Error("候选超出原批准文件。");
    const tree = (await git(workspace, signal, "--literal-pathspecs", "ls-tree", "HEAD", "--", path)).trim();
    const match = /^(100644|100755) blob [a-f0-9]{40}\t/.exec(tree);
    const after = await readEditableFile(workspace, path);
    if (!match || Number.parseInt(match[1] as string, 8) !== mode(after.mode)) throw Error("候选文件模式已变化。");
    const before = await git(workspace, signal, "show", `HEAD:${path}`);
    files.push({ path, before: contentDigest(before), after: contentDigest(after.content), mode: mode(after.mode) });
  }
  if (!validCandidateFiles(files, allowed)) throw Error("候选文件清单无效。");
  const patch = await git(workspace, signal, "diff", "--binary", "--no-ext-diff", "--no-textconv", "--no-color", "--no-renames", "HEAD", "--");
  return { version: 1, artifact: basename(join(workspace, "..")), head, sha256: contentDigest(patch), files,
    digest: contentDigest(JSON.stringify(files)) };
}

export async function candidateWorkspace(root: string, issue: number, artifact: string) {
  if (!new RegExp(`^issue-${issue}-[A-Za-z0-9]+$`).test(artifact)) throw Error("候选产物标识无效。");
  const workspace = join(await realpath(root), artifact, "source");
  if (await realpath(workspace) !== workspace) throw Error("候选必须位于原隔离目录。");
  return workspace;
}

export async function verifyCandidateSnapshot(root: string, issue: number, snapshot: CandidateSnapshot,
  head: string, allowed: readonly string[], signal: AbortSignal) {
  if (snapshot.version !== 1 || snapshot.head !== head || !workerDigest.test(snapshot.sha256)
    || !validCandidateFiles(snapshot.files, allowed) || contentDigest(JSON.stringify(snapshot.files)) !== snapshot.digest) throw Error("候选快照绑定无效。");
  const workspace = await candidateWorkspace(root, issue, snapshot.artifact);
  const observed = await readCandidateSnapshot(workspace, head, allowed, signal);
  if (JSON.stringify(observed) !== JSON.stringify(snapshot)) throw Error("留存候选与持久化快照不符。");
  return workspace;
}

// 旧回执仅记录模型本轮增量。最多组合一次已验证的父候选，之后统一保存相对 PR 头的完整快照。
export async function locateFailedCandidate(root: string, issue: number, head: string, allowed: readonly string[],
  failure: DeliveryFailure, parent: CandidateParent | undefined, signal: AbortSignal): Promise<CandidateSnapshot> {
  if (failure.candidateSnapshot) {
    await verifyCandidateSnapshot(root, issue, failure.candidateSnapshot, head, allowed, signal);
    return failure.candidateSnapshot;
  }
  const delta = failure.candidateFiles;
  if (!delta || !validCandidateFiles(delta, allowed) || contentDigest(JSON.stringify(delta)) !== failure.candidateDigest
    || !failure.candidatePatch || contentDigest(failure.candidatePatch) !== failure.candidatePatchDigest) throw Error("失败候选证据不完整。");
  let parentWorkspace: string | undefined;
  if (parent) {
    parentWorkspace = await candidateWorkspace(root, issue, parent.draft.artifact);
    const previous = await readCandidateSnapshot(parentWorkspace, head, allowed, signal);
    if (previous.sha256 !== parent.draft.sha256 || previous.digest !== parent.digest
      || JSON.stringify(previous.files) !== JSON.stringify(parent.files)) throw Error("上一层候选已变化。");
  }
  const combined = new Map((parent?.files ?? []).map(file => [file.path, { ...file }]));
  for (const file of delta) {
    const previous = combined.get(file.path);
    if (previous && (previous.after !== file.before || previous.mode !== file.mode)) throw Error("候选增量与上一层不连续。");
    const merged = { ...file, before: previous?.before ?? file.before };
    if (merged.before === merged.after) combined.delete(file.path);
    else combined.set(file.path, merged);
  }
  const expected = [...combined.values()].sort((a, b) => a.path.localeCompare(b.path));
  const matches: CandidateSnapshot[] = [];
  const entries = (await readdir(root, { withFileTypes: true })).filter(entry => entry.isDirectory()
    && new RegExp(`^issue-${issue}-[A-Za-z0-9]+$`).test(entry.name));
  if (entries.length > 128) throw Error("候选目录过多，需先核对留存产物。");
  for (const entry of entries) {
    signal.throwIfAborted();
    try {
      const workspace = await candidateWorkspace(root, issue, entry.name);
      const snapshot = await readCandidateSnapshot(workspace, head, allowed, signal);
      if (JSON.stringify([...snapshot.files].sort((a, b) => a.path.localeCompare(b.path))) !== JSON.stringify(expected)) continue;
      const originals = new Map(await Promise.all(delta.map(async file => {
        const inherited = parent?.files.some(row => row.path === file.path);
        const source = inherited && parentWorkspace ? await readEditableFile(parentWorkspace, file.path)
          : { content: await git(workspace, signal, "show", `HEAD:${file.path}`), mode: file.mode };
        return [file.path, source] as const;
      })));
      if (!verifyCandidatePatch(originals, delta, failure.candidatePatch)) continue;
      matches.push(snapshot);
    } catch { signal.throwIfAborted(); }
  }
  // 多个字节相同的留存副本不扩大权限；稳定选择一个，摘要不同则不能猜测。
  if (!matches.length || new Set(matches.map(row => row.sha256)).size !== 1) throw Error("无法唯一证明最新完整候选。");
  return matches.sort((a, b) => a.artifact.localeCompare(b.artifact))[0] as CandidateSnapshot;
}
