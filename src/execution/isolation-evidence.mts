import { readCodeWorkerConfig } from "../config/runtime.mts";
import { deliveryPath } from "./local-code-changes.mts";

export type IsolationEvidence = {
  step: "dependencies" | "quality";
  outcome: "exit" | "timeout" | "cancelled" | "infrastructure";
  exitCode?: number;
  diagnostics?: readonly string[];
  diagnosticsIncomplete?: true;
};

const diagnosticCode = /^(src\/[^\s]+|tests\/[^\s]+):(\d+):(\d+) (TS\d{4,5}|BIOME:(?:error|warning|info):lint\/[a-zA-Z0-9/]+)$/;

export function blockingTestDiagnostic(value: string) {
  const match = diagnosticCode.exec(value);
  return match && validDiagnostic(value) && /^tests\/.+\.test\.[cm]?[jt]s$/.test(match[1] ?? "")
    && !value.includes(" BIOME:info:") ? { path: match[1] as string, key: `${match[1]} ${match[4]}` } : undefined;
}

function normalizedDiagnostic(value: string) {
  if (value.includes("\n") || value.includes("\r")) return;
  const match = /^((?:src|tests)\/[^\s(]+)\((\d+),(\d+)\): error (TS\d{4,5}):/.exec(value);
  if (!match?.[1] || !match[2] || !match[3] || !match[4] || !deliveryPath.test(match[1])) return;
  const line = Number(match[2]);
  const column = Number(match[3]);
  if (!Number.isSafeInteger(line) || line < 1 || !Number.isSafeInteger(column) || column < 1) return;
  return `${match[1]}:${line}:${column} ${match[4]}`;
}

function validDiagnostic(value: unknown): value is string {
  if (typeof value !== "string" || value.includes("\n") || value.includes("\r")) return false;
  const match = diagnosticCode.exec(value);
  if (!match?.[1] || !match[2] || !match[3] || !match[4] || !deliveryPath.test(match[1])) return false;
  return Number.isSafeInteger(Number(match[2])) && Number(match[2]) > 0
    && Number.isSafeInteger(Number(match[3])) && Number(match[3]) > 0;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function readIsolationEvidence(value: unknown, maxBytes = readCodeWorkerConfig().diagnosticMaxBytes): IsolationEvidence | undefined {
  const { step, outcome, exitCode, diagnostics, diagnosticsIncomplete } = record(value);
  if ((step !== "dependencies" && step !== "quality")
    || (outcome !== "exit" && outcome !== "timeout" && outcome !== "cancelled" && outcome !== "infrastructure")
    || (exitCode !== undefined && (typeof exitCode !== "number" || !Number.isInteger(exitCode) || exitCode < 1 || exitCode > 255))
    || (outcome === "exit" && (exitCode === undefined || exitCode >= 125))
    || (exitCode !== undefined && outcome !== "exit" && outcome !== "infrastructure")
    || (diagnosticsIncomplete !== undefined && diagnosticsIncomplete !== true)
    || (diagnostics !== undefined && (step !== "quality" || outcome !== "exit" || !Array.isArray(diagnostics)
      || diagnostics.length < 1 || diagnostics.length > 16 || new Set(diagnostics).size !== diagnostics.length
      || !diagnostics.every(line => typeof line === "string" && Buffer.byteLength(line) <= maxBytes && validDiagnostic(line))
      || Buffer.byteLength(JSON.stringify(diagnostics)) > maxBytes))) return;
  return { step, outcome, ...(exitCode === undefined ? {} : { exitCode }), ...(diagnostics ? { diagnostics: [...diagnostics] as string[] } : {}),
    ...(diagnosticsIncomplete ? { diagnosticsIncomplete: true } : {}) };
}

export function diagnoseIsolationFailure(error: unknown, install: boolean, signal: AbortSignal,
  maxBytes = readCodeWorkerConfig().diagnosticMaxBytes): IsolationEvidence {
  const { code, killed, stdout, stderr } = record(error);
  const step = install ? "dependencies" : "quality";
  if (signal.aborted) return { step, outcome: signal.reason?.name === "TimeoutError" ? "timeout" : "cancelled" };
  const exitCode = typeof code === "number" && Number.isInteger(code) && code >= 1 && code <= 255 ? code : undefined;
  if (killed === true || exitCode === undefined || exitCode >= 125) {
    return { step, outcome: "infrastructure", ...(exitCode ? { exitCode } : {}) };
  }
  // 只提取受控的路径、位置和编译器编号，拒绝错误消息、源码行与命令参数。
  const lines = new Set<string>();
  let incomplete = false;
  if (!install) for (const output of [stdout, stderr]) {
    if (typeof output !== "string") continue;
    for (const raw of output.split(/\r?\n/)) {
      if (raw === "SOUFLOW_DIAGNOSTICS_INCOMPLETE") incomplete = true;
      const safe = normalizedDiagnostic(raw.trim());
      const structured = raw.startsWith("SOUFLOW_DIAGNOSTIC ") ? raw.slice("SOUFLOW_DIAGNOSTIC ".length) : undefined;
      const selected = safe ?? (structured && validDiagnostic(structured) && !structured.includes(" BIOME:info:") ? structured : undefined);
      if (!selected || lines.has(selected)) continue;
      if (lines.size >= 16 || Buffer.byteLength(JSON.stringify([...lines, selected])) > maxBytes) { incomplete = true; continue; }
      lines.add(selected);
    }
  }
  const diagnostics = [...lines];
  return { step, outcome: "exit", exitCode, ...(diagnostics.length ? { diagnostics } : {}), ...(incomplete ? { diagnosticsIncomplete: true } : {}) };
}

export function describeIsolationEvidence(evidence: IsolationEvidence) {
  const step = evidence.step === "dependencies" ? "安装依赖" : "隔离质量检查";
  const outcome = { exit: "命令失败", timeout: "超时", cancelled: "已取消", infrastructure: "执行环境错误" }[evidence.outcome];
  return [step, outcome, ...(evidence.exitCode ? [`退出码 ${evidence.exitCode}`] : []), ...(evidence.diagnostics ?? [])].join(" · ");
}
