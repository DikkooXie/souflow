import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";

// 从随源码交付的环境模板读取缺省值，兼容尚未补齐新字段的本地 .env。
const defaults = parseEnv(readFileSync(new URL("../../.env.example", import.meta.url), "utf8"));

export function loadLocalEnv() {
  try { process.loadEnvFile(); }
  catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
}

export function runtimeSetting(name: string, env: NodeJS.ProcessEnv = process.env) {
  return env[name]?.trim() || defaults[name]?.trim();
}

export function runtimeInteger(name: string, min: number, max: number, env?: NodeJS.ProcessEnv) {
  const raw = runtimeSetting(name, env);
  const value = Number(raw);
  if (!raw || !/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < min || value > max) {
    throw Error(`${name} 必须为 ${min} 到 ${max} 之间的整数。`);
  }
  return value;
}

export const dispatchTicketOutputBytes = (env?: NodeJS.ProcessEnv) =>
  runtimeInteger("SOULFLOW_DISPATCH_TICKET_OUTPUT_MAX_BYTES", 1, 2 * 1024 * 1024, env);

export const qualitySourceInputBytes = (env?: NodeJS.ProcessEnv) =>
  runtimeInteger("SOULFLOW_QUALITY_SOURCE_INPUT_MAX_BYTES", 1, 512 * 1024, env);

// 编辑范围的单文件上限与复核可读取的最大普通文件保持一致。
export const codeEditFileHardLimit = 65_536;
export const legacyCodeEditFileBytes = 36_000;
export const codeEditFileBytes = (env?: NodeJS.ProcessEnv) =>
  runtimeInteger("SOULFLOW_CODE_EDIT_FILE_MAX_BYTES", 1, codeEditFileHardLimit, env);

export function readCodeWorkerConfig(env?: NodeJS.ProcessEnv) {
  const waitMs = runtimeInteger("SOULFLOW_CODE_WORKER_WAIT_MS", 100, 300_000, env);
  const httpTimeoutMs = runtimeInteger("SOULFLOW_CODE_WORKER_HTTP_TIMEOUT_MS", waitMs + 1, 600_000, env);
  const offlineMs = runtimeInteger("SOULFLOW_CODE_WORKER_OFFLINE_MS", waitMs + 1, 600_000, env);
  const messageBytes = runtimeInteger("SOULFLOW_CODE_WORKER_MESSAGE_MAX_BYTES", 1024, 8 * 1024 * 1024, env);
  return {
    waitMs, httpTimeoutMs, offlineMs, messageBytes,
    waitBodyBytes: runtimeInteger("SOULFLOW_CODE_WORKER_WAIT_BODY_MAX_BYTES", 256, messageBytes, env),
    maxSlots: runtimeInteger("SOULFLOW_CODE_WORKER_MAX_SLOTS", 1, 64, env),
    retryMs: runtimeInteger("SOULFLOW_CODE_WORKER_RETRY_MS", 100, 60_000, env),
    recentAttempts: runtimeInteger("SOULFLOW_CODE_WORKER_RECENT_ATTEMPTS", 1, 256, env),
    activityMs: runtimeInteger("SOULFLOW_CODE_WORKER_ACTIVITY_MS", 100, 60_000, env),
    maxUpstream: runtimeInteger("SOULFLOW_CODE_WORKER_MAX_UPSTREAM", 0, 256, env),
    maxFiles: runtimeInteger("SOULFLOW_CODE_WORKER_MAX_FILES", 1, 16, env),
    maxInstructions: runtimeInteger("SOULFLOW_CODE_WORKER_INSTRUCTIONS_MAX_LENGTH", 1, messageBytes, env),
    maxContextBytes: runtimeInteger("SOULFLOW_CODE_WORKER_CONTEXT_MAX_BYTES", 1, messageBytes, env),
    diagnosticMaxBytes: runtimeInteger("SOULFLOW_CODE_WORKER_DIAGNOSTIC_MAX_BYTES", 256, 32 * 1024, env),
    receiptGraceMs: runtimeInteger("SOULFLOW_CODE_WORKER_RECEIPT_GRACE_MS", 1_000, 300_000, env),
  };
}

export type CodeWorkerConfig = ReturnType<typeof readCodeWorkerConfig>;
