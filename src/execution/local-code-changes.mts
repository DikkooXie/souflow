import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const maxEdits = 16;
const maxSourceBytes = 36_000;
const maxPatchBytes = 160_000;

const digest = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
type PatchFile = { path: string; before: string; after: string; mode: number };
export type LocalCodePatch = { patchSha256: string; changes: PatchFile[] };

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
  const changes: PatchFile[] = [];
  // 先验证所有替换，再在脱离原仓库的目录生成可复核的补丁。
  for (const path of files) {
    const original = sources.get(path);
    const revised = proposed.get(path);
    if (!original || revised === undefined) throw Error("未找到待归档的改动。");
    changes.push({ path, before: digest(original.content), after: digest(revised), mode: original.mode });
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
  return { files, patchPath, patchSha256: digest(patch), changes };
}

export async function readLocalCodePatch(patchPath: string, sha256: string) {
  const handle = await open(patchPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  const patch = await (async () => {
    try {
      if (!(await handle.stat()).isFile()) throw Error("补丁必须是普通文件。");
      const bytes = Buffer.alloc(maxPatchBytes + 1);
      const { bytesRead } = await handle.read({ buffer: bytes });
      return bytes.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  })();
  if (patch.length > maxPatchBytes || digest(patch) !== sha256) throw Error("补丁版本已变化。");
  return patch;
}

export async function replayLocalCodePatch(workspace: string, patchPath: string, approved: LocalCodePatch) {
  const patch = await readLocalCodePatch(patchPath, approved.patchSha256);
  async function verify(side: "before" | "after") {
    for (const change of approved.changes) {
      const actual = await readEditableFile(workspace, change.path);
      if (change.mode !== actual.mode || change[side] !== digest(actual.content)) throw Error("补丁文件版本不匹配。");
    }
  }
  await verify("before");
  // Git 只接收刚校验过的字节，避免再次读取可能已更换的文件。
  await new Promise<void>((resolve, reject) => {
    const child = execFile("git", ["apply", "--whitespace=nowarn", "-p2", "-"], { cwd: workspace }, error => {
      if (error) reject(error);
      else resolve();
    });
    child.stdin?.on("error", reject);
    child.stdin?.end(patch);
  });
  await verify("after");
}
