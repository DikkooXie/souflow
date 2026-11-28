import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { promisify } from "node:util";
import { codeEditFileBytes } from "../config/runtime.mts";

const exec = promisify(execFile);
export const maxEdits = 16;
export const deliveryPath = /^(src|tests)\/(?:[a-z\d_-]+\/)*[a-z\d_.-]+\.(?:mjs|mts|ts|js|css|html)$/i;
const maxPatchBytes = 160_000;
// JSON 同时携带替换前后文本和转义，按独立的传输体积限制接收。
export const maxCodeProposalBytes = 320_000;

const digest = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
// Git 对普通文件只追踪可执行位，回放重建文件时其他权限位可随 umask 变化。
const gitFileMode = (mode: number) => (mode & 0o100) ? 0o100755 : 0o100644;
type PatchFile = { path: string; before: string; after: string; mode: number };
export type LocalCodePatch = { patchSha256: string; changes: PatchFile[] };
type PatchRejectionReason = "format" | "scope" | "redacted" | "match" | "size" | "empty" | "apply";
export type PatchIssue = {
  code: "output-missing" | "output-too-large" | "json" | "envelope" | "edit-count" | "edit-fields"
    | "unauthorized-file" | "redaction-marker" | "anchor-missing" | "anchor-ambiguous" | "file-size" | "patch-size" | "no-change"
    | "workspace-changed" | "apply-failed" | "prepare-failed";
  edit?: number;
  count?: number;
  bytes?: number;
};

export class PatchRejection extends Error {
  readonly reason: PatchRejectionReason;
  readonly issue: PatchIssue;
  constructor(reason: PatchRejectionReason, issue: PatchIssue, message: string) {
    super(message);
    this.reason = reason;
    this.issue = issue;
  }
}

export const codeResultSchema = {
  type: "object", additionalProperties: false, required: ["report", "edits"], properties: {
    report: { type: "string" }, edits: { type: "array", items: {
      type: "object", additionalProperties: false, required: ["path", "before", "after"], properties: {
        path: { type: "string" }, before: { type: "string" }, after: { type: "string" },
      },
    } },
  },
};

function codeEdits(output: string | undefined, sources: EditableSources) {
  if (!output?.trim()) throw new PatchRejection("format", { code: "output-missing" }, "未收到结构化补丁。");
  if (Buffer.byteLength(output) > maxCodeProposalBytes) {
    throw new PatchRejection("size", { code: "output-too-large" }, "补丁回复超过接收容量。");
  }
  // 仅解开完整的单个 JSON 代码块，禁止从任意说明文字提取局部补丁。
  const fenced = /^\s*```(?:json)?[ \t]*\r?\n([\s\S]+)\r?\n```[ \t]*\s*$/i.exec(output);
  let parsed: unknown;
  try { parsed = JSON.parse(fenced?.[1] ?? output); }
  catch { throw new PatchRejection("format", { code: "json" }, "补丁回复不是有效 JSON。"); }
  if (parsed && typeof parsed === "object" && "edits" in parsed) checkEditScope(sources, parsed.edits);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || Object.keys(parsed).length !== 2
    || !("report" in parsed) || typeof parsed.report !== "string" || !("edits" in parsed)) {
    throw new PatchRejection("format", { code: "envelope" }, "补丁需要 report 和 edits 两个字段。");
  }
  return parsed.edits;
}

export async function readEditableFile(workspace: string, path: string) {
  const root = await realpath(workspace);
  const file = join(root, path);
  const info = await lstat(file);
  // 只允许批准的快照普通文件。路径内的链接也可能把写入导向其他工作区。
  if (!info.isFile() || info.size > codeEditFileBytes() || relative(root, await realpath(file)) !== path) {
    throw Error("编辑目标必须是工作目录内的普通文本文件。");
  }
  const bytes = await readFile(file);
  const content = bytes.toString("utf8");
  if (content.includes("\0") || !bytes.equals(Buffer.from(content))) throw Error("编辑目标必须是 UTF-8 文本。");
  return { content, mode: info.mode & 0o777 };
}

type EditableSources = ReadonlyMap<string, Awaited<ReturnType<typeof readEditableFile>>>;

function checkEditScope(sources: EditableSources, edits: unknown) {
  if (!Array.isArray(edits)) return;
  // 先扫描完整提案，确保前面的可纠正错误不会掩盖后面的暂停条件。
  for (const [index, edit] of edits.entries()) {
    const ordinal = index + 1;
    if (!edit || typeof edit !== "object") continue;
    if (typeof edit.path === "string" && !sources.has(edit.path)) {
      throw new PatchRejection("scope", { code: "unauthorized-file", edit: ordinal }, "改动包含未获批准的文件。");
    }
    if ([edit.before, edit.after].some(value => typeof value === "string" && /\[已隐藏(?:凭据|私钥)\]/.test(value))) {
      throw new PatchRejection("redacted", { code: "redaction-marker", edit: ordinal }, "改动涉及已脱敏内容，请缩小编辑范围。");
    }
  }
}

function checkEdits(sources: EditableSources, edits: unknown, strict = false) {
  if (!Array.isArray(edits) || !edits.length || edits.length > maxEdits) {
    throw new PatchRejection("format", { code: "edit-count", ...(Array.isArray(edits) ? { count: edits.length } : {}) }, "未收到有效的代码改动。");
  }
  const proposed = new Map<string, string>();
  for (const [index, edit] of edits.entries()) {
    const ordinal = index + 1;
    if (!edit || typeof edit !== "object" || Array.isArray(edit) || (strict && Object.keys(edit).length !== 3)) {
      throw new PatchRejection("format", { code: "edit-fields", edit: ordinal }, "改动包含无效替换。");
    }
    const { path, before, after } = edit;
    if (typeof path !== "string" || typeof before !== "string" || !before || typeof after !== "string" || after.includes("\0")
      || (!strict && before === after)) {
      throw new PatchRejection("format", { code: "edit-fields", edit: ordinal }, "改动包含无效替换。");
    }
    const source = sources.get(path);
    if (!source) throw new PatchRejection("scope", { code: "unauthorized-file", edit: ordinal }, "改动包含未获批准的文件。");
    const previous = proposed.get(path) ?? source.content;
    const start = previous.indexOf(before);
    const mismatch = start < 0 ? "anchor-missing" : previous.indexOf(before, start + 1) >= 0 ? "anchor-ambiguous" : undefined;
    if (mismatch) throw new PatchRejection("match", { code: mismatch, edit: ordinal }, "改动的原文无法唯一匹配，未应用替换。");
    // 无效果的替换须先经过相同范围和锚点检查，丢弃后不会改变源码。
    if (before === after) continue;
    const next = previous.slice(0, start) + after + previous.slice(start + before.length);
    if (!next.trim() || Buffer.byteLength(next) > codeEditFileBytes()) {
      throw new PatchRejection("size", { code: "file-size", edit: ordinal }, "改动后的文件为空或过长。");
    }
    proposed.set(path, next);
  }
  for (const [path, content] of proposed) {
    if (content === sources.get(path)?.content) proposed.delete(path);
  }
  if (!proposed.size) throw new PatchRejection("empty", { code: "no-change" }, "未收到实际代码差异。");
  return proposed;
}

export async function prepareCodeProposal(target: string, sources: EditableSources,
  generate: (issue?: PatchIssue) => Promise<string | undefined>, repairing?: (issue: PatchIssue) => void) {
  const check = async (issue?: PatchIssue) => {
    const edits = codeEdits(await generate(issue), sources);
    return buildCodePatch(target, sources, checkEdits(sources, edits, true));
  };
  try { return await check(); }
  catch (error) {
    if (!(error instanceof PatchRejection) || error.reason === "scope" || error.reason === "redacted") throw error;
    repairing?.(error.issue);
    return check(error.issue);
  }
}

export async function applyLocalCodeChanges(target: string, workspace: string, sources: EditableSources, edits: unknown) {
  checkEditScope(sources, edits);
  const checked = await buildCodePatch(target, sources, checkEdits(sources, edits));
  return applyCheckedCodeChanges(target, workspace, sources, checked);
}

async function buildCodePatch(target: string, sources: EditableSources, proposed: ReadonlyMap<string, string>) {
  const files = [...proposed.keys()].sort();
  const changes: PatchFile[] = [];
  // 先在隔离目录生成最终差异并核对实际大小。纠正前不写入执行工作区。
  const directory = await mkdtemp(join(target, "patch-"));
  try {
    for (const path of files) {
      const original = sources.get(path);
      const revised = proposed.get(path);
      if (!original || revised === undefined) throw Error("未找到待归档的改动。");
      changes.push({ path, before: digest(original.content), after: digest(revised), mode: gitFileMode(original.mode) });
      for (const [side, content] of [["before", original.content], ["after", revised]] as const) {
        const file = join(directory, side, path);
        await mkdir(dirname(file), { recursive: true, mode: 0o700 });
        await writeFile(file, content, { flag: "wx", mode: original.mode });
      }
    }
    const patch = await exec("git", ["diff", "--no-index", "--no-ext-diff", "--no-textconv", "--no-color", "--binary",
      "--src-prefix=a/", "--dst-prefix=b/", "--", "before", "after"], { cwd: directory, maxBuffer: maxPatchBytes })
      .then(({ stdout }) => stdout, error => {
        if (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
          throw new PatchRejection("size", { code: "patch-size" }, "补丁差异超过归档容量。");
        }
        if (error.code === 1 && typeof error.stdout === "string" && error.stdout.startsWith("diff --git ")) return error.stdout as string;
        throw error;
      });
    if (Buffer.byteLength(patch) > maxPatchBytes) throw new PatchRejection("size", { code: "patch-size" }, "补丁差异超过归档容量。");
    return { proposed, files, patch, changes };
  } finally { await rm(directory, { recursive: true }); }
}

export async function applyCheckedCodeChanges(target: string, workspace: string, sources: EditableSources, checked: Awaited<ReturnType<typeof buildCodePatch>>) {
  const { files, proposed, patch, changes } = checked;
  for (const path of files) {
    const current = await readEditableFile(workspace, path);
    if (current.content !== sources.get(path)?.content) {
      throw new PatchRejection("apply", { code: "workspace-changed" }, "工作区内容在执行期间发生变化。");
    }
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
      if (change.mode !== gitFileMode(actual.mode) || change[side] !== digest(actual.content)) throw Error("补丁文件版本不匹配。");
    }
  }
  await verify("before");
  // Git 只接收刚校验过的字节，避免再次读取可能已更换的文件。
  // 持久化工作区可能位于源仓库目录内，补丁只以本次解包目录为根。
  const ceiling = dirname(await realpath(workspace));
  await new Promise<void>((resolve, reject) => {
    const child = execFile("git", ["apply", "--whitespace=nowarn", "-p2", "-"], {
      cwd: workspace, env: { ...process.env, GIT_CEILING_DIRECTORIES: ceiling },
    }, error => {
      if (error) reject(error);
      else resolve();
    });
    child.stdin?.on("error", reject);
    child.stdin?.end(patch);
  });
  await verify("after");
}
