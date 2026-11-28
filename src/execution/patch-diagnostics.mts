import { maxCodeProposalBytes, type PatchIssue, PatchRejection } from "./local-code-changes.mts";

export type PatchDiagnostic = PatchIssue & { attempt: 1 | 2 };
const codes: Record<PatchIssue["code"], string> = {
  "output-missing": "没有结构化回复", "output-too-large": "回复超过容量", json: "JSON 格式无效",
  envelope: "回复字段无效", "edit-count": "替换数量无效", "edit-fields": "替换字段无效",
  "unauthorized-file": "包含未授权文件", "redaction-marker": "涉及脱敏内容", "anchor-missing": "原文未匹配",
  "anchor-ambiguous": "原文匹配多处", "file-size": "文件为空或超过容量", "patch-size": "补丁超过容量",
  "no-change": "没有实际差异", "workspace-changed": "应用前工作区已变化", "apply-failed": "补丁应用失败",
  "prepare-failed": "补丁准备失败",
};

export function readPatchDiagnostics(value: unknown): PatchDiagnostic[] | undefined {
  if (!Array.isArray(value) || value.length < 1 || value.length > 2) return;
  const parsed: PatchDiagnostic[] = [];
  for (const [index, item] of value.entries()) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return;
    const { code, attempt, edit, count, bytes } = item;
    if (typeof code !== "string" || !Object.hasOwn(codes, code) || attempt !== index + 1
      || Object.keys(item).some(key => !["code", "attempt", "edit", "count", "bytes"].includes(key))
      || [edit, count, bytes].some(number => number !== undefined
        && (!Number.isSafeInteger(number) || number < 0 || number > maxCodeProposalBytes))
      || (edit !== undefined && edit < 1)) return;
    parsed.push({ code: code as PatchIssue["code"], attempt: attempt as 1 | 2,
      ...(edit === undefined ? {} : { edit }), ...(count === undefined ? {} : { count }), ...(bytes === undefined ? {} : { bytes }) });
  }
  return parsed;
}

// 仅允许固定分类和数字进入设备回执；子进程异常可能携带源码、路径或凭据。
export function patchFailureDiagnostic(error: unknown, attempt: 1 | 2, applying: boolean): PatchDiagnostic {
  const issue = error instanceof PatchRejection ? error.issue : { code: applying ? "apply-failed" : "prepare-failed" } as const;
  return { ...issue, attempt };
}

export function createPatchOutputGuard() {
  let overflow = false;
  return {
    observe(bytes: number | undefined) { overflow = bytes !== undefined; },
    read(output: string | undefined) {
      if (overflow) throw new PatchRejection("size", { code: "output-too-large" }, "补丁回复超过接收容量。");
      return output;
    },
  };
}

export function describePatchDiagnostics(diagnostics: readonly PatchDiagnostic[]) {
  return diagnostics.map(item => [item.attempt === 1 ? "首次补丁" : "自动修正补丁", codes[item.code], item.code,
    ...(item.edit === undefined ? [] : [`第 ${item.edit} 项替换`]),
    ...(item.count === undefined ? [] : [`${item.count} 项`]), ...(item.bytes === undefined ? [] : [`${item.bytes} 字节`])].join(" · ")).join("；");
}
