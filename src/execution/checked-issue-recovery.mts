import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { contentDigest, workerCommit, workerDigest } from "./code-worker-protocol.mts";
import { deliveryPath, readEditableFile } from "./local-code-changes.mts";

const exec = promisify(execFile);

export async function recoverCheckedWorkspace(root: string, workspace: string, issue: number, head: string, revision: string,
  patch: string, allowed: readonly string[], timeout: number, signal: AbortSignal) {
  if (!workerCommit.test(head) || !workerCommit.test(revision) || !workerDigest.test(patch)) throw Error("交付回执无效。");
  const git = (repo: string, ...args: string[]) => exec("git", ["-C", repo, "-c", "core.hooksPath=/dev/null",
    ...args], { timeout, signal, env: { ...process.env, GIT_NO_REPLACE_OBJECTS: "1" } }).then(result => result.stdout);
  const candidates = (await readdir(root, { withFileTypes: true })).filter(item => item.isDirectory() && item.name.startsWith(`issue-${issue}-`));
  for (const candidate of candidates) {
    const source = join(root, candidate.name, "source");
    const parents = await git(source, "show", "-s", "--format=%P", head).catch(() => "");
    if (parents.trim() !== revision) continue;
    signal.throwIfAborted();
    await git(workspace, "fetch", "--no-tags", "--no-recurse-submodules", source, head);
    const diff = await git(workspace, "diff", "--name-status", "--no-renames", "--no-ext-diff", "-z", revision, head, "--");
    const entries = diff.split("\0").slice(0, -1);
    if (!entries.length) throw Error("交付提交没有改动。");
    const files: string[] = [];
    for (let index = 0; index < entries.length; index += 2) {
      const path = entries[index + 1];
      if (entries[index] !== "M" || !path || !deliveryPath.test(path) || !allowed.includes(path)) {
        throw Error("交付提交修改超出原工单范围。");
      }
      files.push(path);
    }
    const originals = new Map(await Promise.all(files.map(async path => [path, await readEditableFile(workspace, path)] as const)));
    await git(workspace, "switch", "--detach", head);
    const changes = await Promise.all(files.sort().map(async path => {
      const entry = await git(workspace, "ls-tree", head, "--", path);
      const original = originals.get(path);
      const mode = original && (original.mode & 0o100 ? 0o100755 : 0o100644);
      if (!original || !mode || !entry.startsWith(`${mode.toString(8)} blob `)) throw Error("交付提交改变了文件类型或执行权限。");
      const current = await readEditableFile(workspace, path);
      return { path, before: contentDigest(original.content), after: contentDigest(current.content), mode };
    }));
    if (contentDigest(JSON.stringify(changes)) !== patch) throw Error("交付提交与设备测试补丁不一致。");
    return;
  }
  throw Error("未找到已核对的交付提交。");
}
