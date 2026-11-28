import { execFile } from "node:child_process";
import { realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { contentDigest, workerCommit, workerDigest } from "./code-worker-protocol.mts";
import { deliveryPath, maxCodeProposalBytes, readEditableFile } from "./local-code-changes.mts";

export type FailedReviewDraft = { artifact: string; sha256: string };
const exec = promisify(execFile);

export async function restoreFailedReviewDraft(root: string, target: string, workspace: string, issue: number, head: string,
  draft: FailedReviewDraft, allowed: readonly string[], timeout: number, signal: AbortSignal) {
  if (!workerCommit.test(head) || !workerDigest.test(draft.sha256)
    || !new RegExp(`^issue-${issue}-[A-Za-z0-9]+$`).test(draft.artifact)) throw Error("上一份续修产物标识无效。");
  const source = join(await realpath(root), draft.artifact, "source");
  if (await realpath(source) !== source) throw Error("上一份续修产物不在原隔离目录内。");
  const git = async (directory: string, ...args: string[]) => (await exec("git", [
    "-C", directory, "-c", "core.hooksPath=/dev/null", ...args,
  ], { timeout, signal, maxBuffer: maxCodeProposalBytes, env: { ...process.env, GIT_NO_REPLACE_OBJECTS: "1" } })).stdout;
  if ((await git(source, "rev-parse", "HEAD")).trim() !== head
    || (await git(workspace, "rev-parse", "HEAD")).trim() !== head) throw Error("续修基线已经变化。");
  const scope = await git(source, "diff", "--no-ext-diff", "--name-status", "--no-renames", "-z", "HEAD", "--");
  const entries = scope.split("\0").slice(0, -1);
  const files: string[] = [];
  for (let index = 0; index < entries.length; index += 2) {
    const path = entries[index + 1];
    if (entries[index] !== "M" || !path || !deliveryPath.test(path) || !allowed.includes(path)) {
      throw Error("上一份续修产物超出原修改范围。");
    }
    const [before, after] = await Promise.all([readEditableFile(workspace, path), readEditableFile(source, path)]);
    if ((before.mode & 0o100) !== (after.mode & 0o100)) throw Error("上一份续修产物改变了文件权限。");
    files.push(path);
  }
  const patch = await git(source, "diff", "--binary", "--no-ext-diff", "--no-textconv", "--no-color", "--no-renames", "HEAD", "--");
  if (!files.length || contentDigest(patch) !== draft.sha256) throw Error("上一份续修补丁与核对摘要不符。");
  const patchFile = join(target, "review-draft.patch");
  await writeFile(patchFile, patch, { flag: "wx", mode: 0o600 });
  await git(workspace, "apply", "--whitespace=nowarn", "--", patchFile);
  const applied = await git(workspace, "diff", "--no-ext-diff", "--name-status", "--no-renames", "-z", "HEAD", "--");
  if (scope !== applied) throw Error("恢复后的补丁文件范围不一致。");
  return files;
}
