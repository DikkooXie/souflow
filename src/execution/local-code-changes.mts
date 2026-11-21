import { execFile } from "node:child_process";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const maxEdits = 16;
const maxSourceBytes = 36_000;
const maxPatchBytes = 160_000;

export const codeResultSchema = {
  type: "object", additionalProperties: false, required: ["report", "edits"], properties: {
    report: { type: "string" }, edits: { type: "array", items: {
      type: "object", additionalProperties: false, required: ["path", "before", "after"], properties: {
        path: { type: "string" }, before: { type: "string" }, after: { type: "string" },
      },
    } },
  },
};

export async function readEditableFile(workspace: string, path: string) {
  const root = await realpath(workspace);
  const file = join(root, path);
  const info = await lstat(file);
  // 只允许批准的快照普通文件。路径内的链接也可能把写入导向其他工作区。
  if (!info.isFile() || info.size > maxSourceBytes || relative(root, await realpath(file)) !== path) {
    throw Error("编辑目标必须是工作目录内的普通文本文件。");
  }
  const bytes = await readFile(file);
  const content = bytes.toString("utf8");
  if (content.includes("\0") || !bytes.equals(Buffer.from(content))) throw Error("编辑目标必须是 UTF-8 文本。");
  return { content, mode: info.mode & 0o777 };
}

export async function applyLocalCodeChanges(target: string, workspace: string, sources: ReadonlyMap<string, Awaited<ReturnType<typeof readEditableFile>>>, edits: unknown) {
  if (!Array.isArray(edits) || !edits.length || edits.length > maxEdits) throw Error("未收到有效的代码改动。");
  const proposed = new Map<string, string>();
  for (const edit of edits) {
    const { path, before, after } = edit ?? {};
    const source = typeof path === "string" && sources.get(path);
    if (!source || typeof before !== "string" || !before || typeof after !== "string" || after.includes("\0") || before === after) {
      throw Error("改动包含未获批准的文件或无效替换。");
    }
    if (/\[已隐藏(?:凭据|私钥)\]/.test(before + after)) throw Error("改动涉及已脱敏内容，请缩小编辑范围。");
    const previous = proposed.get(path) ?? source.content;
    const start = previous.indexOf(before);
    if (start < 0 || previous.indexOf(before, start + 1) >= 0) throw Error("改动的原文无法唯一匹配，未应用替换。");
    const next = previous.slice(0, start) + after + previous.slice(start + before.length);
    if (!next.trim() || Buffer.byteLength(next) > maxSourceBytes) throw Error("改动后的文件为空或过长。");
    proposed.set(path, next);
  }

  const files = [...proposed].filter(([path, content]) => content !== sources.get(path)?.content).map(([path]) => path).sort();
  if (!files.length) throw Error("未收到实际代码差异。");
  // 先验证所有替换，再在脱离原仓库的目录生成可复核的补丁。
  for (const path of files) {
    const original = sources.get(path);
    const revised = proposed.get(path);
    if (!original || revised === undefined) throw Error("未找到待归档的改动。");
    for (const [side, content] of [["before", original.content], ["after", revised]] as const) {
      const file = join(target, side, path);
      await mkdir(dirname(file), { recursive: true, mode: 0o700 });
      await writeFile(file, content, { flag: "wx", mode: original.mode });
    }
  }
  const patch = await exec("git", ["diff", "--no-index", "--no-ext-diff", "--no-textconv", "--no-color", "--binary",
    "--src-prefix=a/", "--dst-prefix=b/", "--", "before", "after"], {
    cwd: target, maxBuffer: maxPatchBytes,
  }).then(({ stdout }) => stdout, error => {
    if (error.code === 1 && typeof error.stdout === "string" && error.stdout.startsWith("diff --git ")) return error.stdout as string;
    throw error;
  });
  for (const path of files) {
    const current = await readEditableFile(workspace, path);
    if (current.content !== sources.get(path)?.content) throw Error("工作区内容在执行期间发生变化。");
  }
  for (const path of files) await writeFile(join(workspace, path), proposed.get(path) ?? "");
  const patchPath = join(target, "changes.patch");
  await writeFile(patchPath, patch, { flag: "wx", mode: 0o600 });
  return { files, patchPath };
}
