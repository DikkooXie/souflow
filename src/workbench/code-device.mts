import { execFile } from "node:child_process";
import { randomUUID, X509Certificate } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { request } from "node:https";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { openActivityStore } from "../audit/activity-store.mts";
import { codeEditFileBytes, type CodeWorkerConfig, loadLocalEnv, readCodeWorkerConfig, runtimeInteger, runtimeSetting } from "../config/runtime.mts";
import { probeCodeDeviceLogin } from "../execution/code-device-login.mts";
import { startCodexReadOnlyTask } from "../execution/codex-command-attempt.mts";
import { compactCodeFailure, contentDigest, readCodeOffer, readWorkerCapacity, workerDigest, workerId,
  workerProtocolVersion, type CodeOffer, type CodeReceipt, type WorkerFailureStage } from "../execution/code-worker-protocol.mts";
import { isolatedIssueCheck, IssueDeliveryFailed } from "../execution/issue-delivery.mts";
import { applyCheckedCodeChanges, codeResultSchema, maxCodeProposalBytes, maxEdits, prepareCodeProposal,
  readEditableFile } from "../execution/local-code-changes.mts";
import { lockWorkbench } from "./recovery.mts";
import { createPatchOutputGuard, patchFailureDiagnostic, type PatchDiagnostic } from "../execution/patch-diagnostics.mts";

const exec = promisify(execFile);
type ReceiptContent = CodeReceipt extends infer Receipt ? Receipt extends CodeReceipt ? Omit<Receipt, "id" | "digest" | "at"> : never : never;
type Pending = Pick<CodeOffer, "id" | "digest">;
type Journal = { instance: string; pending: Pending[] };

function connector(endpoint: URL, config: { id: string; key: string; certificate: string }, limits: CodeWorkerConfig) {
  return (path: "check" | "wait" | "receipt", value: object | undefined, signal: AbortSignal) => new Promise<{
    status: number; offer?: unknown;
  }>((fulfill, reject) => {
    const payload = value === undefined ? undefined : JSON.stringify(value);
    const maxBytes = path === "wait" ? limits.waitBodyBytes : limits.messageBytes;
    if (payload !== undefined && Buffer.byteLength(payload) > maxBytes) { reject(Error("设备消息超过上限。")); return; }
    const req = request(new URL(`/v1/code-workers/${config.id}/${path}`, endpoint), {
      method: path === "check" ? "GET" : "POST", ca: config.certificate, signal, timeout: limits.httpTimeoutMs,
      headers: { ...(payload === undefined ? {} : { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }),
        Authorization: `Bearer ${config.key}` },
    }, response => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > limits.messageBytes) req.destroy(Error("设备响应超过上限。"));
        else chunks.push(chunk);
      });
      response.on("error", reject);
      response.on("end", () => {
        try {
          const status = response.statusCode ?? 503;
          const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
          fulfill({ status, offer: body?.offer });
        } catch (error) { reject(error); }
      });
    });
    req.on("timeout", () => req.destroy(Error("连接超时。")));
    req.on("error", reject);
    req.end(payload);
  });
}

async function doWork(offer: CodeOffer, root: string, image: string, timeoutMs: number, signal: AbortSignal,
  publish: (receipt: ReceiptContent) => Promise<void>, enter: (stage: WorkerFailureStage) => void,
  patchState: { diagnostics: PatchDiagnostic[]; attempt: 1 | 2; applying: boolean }) {
  const work = offer.work;
  const target = await mkdtemp(join(root, "issue-"));
  const workspace = join(target, "source");
  const model = process.env.SOULFLOW_CODEX_EXECUTION_MODEL?.trim();
  const git = async (...args: string[]) => (await exec("git", ["-C", workspace, "-c", "core.hooksPath=/dev/null",
    "-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential", ...args], {
    signal, timeout: timeoutMs, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
  })).stdout.trim();
  try {
    await mkdir(workspace, { mode: 0o700 });
    await git("init", "--quiet");
    await git("fetch", "--no-tags", "--no-recurse-submodules", "--depth=1", `https://github.com/${work.repo}.git`, work.revision);
    await git("switch", "--detach", "FETCH_HEAD");
    if (await git("rev-parse", "HEAD") !== work.revision) throw Error("设备签出的提交与工单不同。");
    const sources = new Map(await Promise.all(work.files.map(async ({ path, sha256, bytes }) => {
      const source = await readEditableFile(workspace, path);
      if (contentDigest(source.content) !== sha256 || (bytes !== undefined && Buffer.byteLength(source.content) !== bytes)) {
        throw Error("设备签出的文件与工单不同。");
      }
      return [path, source] as const;
    })));
    let output: string | undefined;
    let started: Promise<void> | undefined;
    const checked = await prepareCodeProposal(target, sources, async issue => {
      patchState.attempt = issue ? 2 : 1;
      enter("codex");
      signal.throwIfAborted();
      const outputGuard = createPatchOutputGuard();
      const attempt = startCodexReadOnlyTask({
        workspace, ...(model ? { model } : {}), localLoginOnly: true, disableWebSearch: true,
        outputMaxBytes: maxCodeProposalBytes, outputSchema: codeResultSchema,
        onOutputOverflow: outputGuard.observe,
        untrustedContext: work.previousCandidatePatch
          ? JSON.stringify({ ...JSON.parse(work.context), previousCandidatePatch: work.previousCandidatePatch }) : work.context,
        onEvent() {},
        onThread(thread) {
          if (!started) {
            started = publish({ phase: "started", thread });
            void started.catch(() => attempt.close());
          }
        },
        prompt: [
          "按已批准工单生成代码替换。只有 editableFiles 可以修改，readOnlySources 仅供参考。",
          `只返回 JSON，含 report 和 1 至 ${maxEdits} 项 edits。每项只包含 path、before、after。before 使用当前唯一的短原文，按顺序应用，不要声称已运行测试。`,
          ...(issue ? [`上一份补丁未应用，机器诊断：${JSON.stringify(issue)}。请重新生成完整补丁。`] : []),
          ...(work.instructions.includes("上次候选补丁已作为不可信资料提供")
            ? ["上一次候选补丁已在不可信资料中附带摘要，重新阅读源码后再做完整修订。"] : []),
          work.instructions,
        ].join("\n\n"),
      });
      const stop = () => attempt.close();
      signal.addEventListener("abort", stop, { once: true });
      if (signal.aborted) stop();
      try {
        if (await attempt.finished !== "completed") throw Error("设备上的 Codex 未完成。");
        if (!started) throw Error("没有收到 Codex 会话确认。");
        await started;
        output = attempt.output();
        enter("patch");
        return outputGuard.read(output);
      } finally { signal.removeEventListener("abort", stop); }
    }, issue => { patchState.diagnostics.push({ ...issue, attempt: 1 }); });
    enter("dependencies");
    await isolatedIssueCheck(workspace, image, timeoutMs, signal, true);
    enter("patch");
    patchState.applying = true;
    const applied = await applyCheckedCodeChanges(target, workspace, sources, checked);
    enter("tests");
    try { await isolatedIssueCheck(workspace, image, timeoutMs, signal, false); }
    catch (error) {
      if (error instanceof IssueDeliveryFailed && error.failure.isolation) {
        const candidateFiles = checked.changes.map(file => ({ path: file.path, before: file.before, after: file.after,
          mode: (file.mode === 0o100755 ? 0o100755 : 0o100644) as 0o100644 | 0o100755 }));
        const candidatePatch = await readFile(applied.patchPath, "utf8");
        throw new IssueDeliveryFailed({ ...error.failure, candidateDigest: contentDigest(JSON.stringify(candidateFiles)), candidateFiles,
          candidatePatch, candidatePatchDigest: applied.patchSha256 });
      }
      throw error;
    }
    if (output === undefined) throw Error("设备未生成补丁。");
    return { phase: "tested", output, patch: contentDigest(JSON.stringify(checked.changes)),
      ...(patchState.diagnostics.length ? { patchDiagnostics: patchState.diagnostics } : {}) } as const;
  } finally {
    await rm(target, { recursive: true, force: true });
  }
}

async function readEnrollment(configPath: string | undefined) {
  if (!configPath) throw Error("请通过 SOULFLOW_CODE_WORKER_ENROLLMENT_FILE 指定设备接入文件。");
  const file = resolve(configPath);
  const config = JSON.parse(await readFile(file, "utf8"));
  if (typeof config?.endpoint !== "string" || typeof config.id !== "string" ||
      typeof config.key !== "string" || typeof config.certificate !== "string") throw Error("设备接入文件无效。");
  const endpoint = new URL(config.endpoint);
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.pathname !== "/" ||
      endpoint.search || endpoint.hash || !workerId.test(config.id) || !workerDigest.test(config.key)) throw Error("设备接入文件无效。");
  const certificate = new X509Certificate(config.certificate).toString();
  return { file, endpoint, id: config.id as string, key: config.key as string, certificate };
}

function readCapacity(limits: CodeWorkerConfig) {
  const repo = process.env.SOULFLOW_CODE_WORKER_REPO?.trim();
  const slots = runtimeInteger("SOULFLOW_CODE_WORKER_SLOTS", 1, limits.maxSlots);
  const capacity = readWorkerCapacity({ version: workerProtocolVersion, instance: randomUUID(), repo, slots, ready: false,
    editFileBytes: codeEditFileBytes() }, limits.maxSlots);
  if (!capacity) throw Error("设备需配置仓库及有效并发设置。");
  return capacity;
}

async function selfCheck(configPath: string | undefined, limits: CodeWorkerConfig) {
  const enrollment = await readEnrollment(configPath).catch(() => undefined);
  process.stdout.write(enrollment ? "接入文件有效。\n" : "接入文件缺失、无法读取或格式无效。\n");
  const capacity = (() => {
    try { return readCapacity(limits); } catch { return undefined; }
  })();
  if (!capacity) process.stdout.write("请检查设备仓库及并发配置。\n");

  const [network, loggedIn] = await Promise.all([
    enrollment && capacity ? connector(enrollment.endpoint, enrollment, limits)("check", undefined,
      AbortSignal.timeout(limits.httpTimeoutMs)).catch(() => undefined) : undefined,
    probeCodeDeviceLogin(AbortSignal.timeout(limits.httpTimeoutMs)),
  ]);
  if (!enrollment || !capacity) process.stdout.write("设备 HTTPS 接入检查跳过，请先修正配置。\n");
  else if (!network) process.stdout.write("设备 HTTPS 接入失败，请检查网络、服务地址和证书。\n");
  else if (network.status !== 200) process.stdout.write(`设备 HTTPS 已响应，但接入失败（HTTP ${network.status}）。\n`);
  else process.stdout.write("设备 HTTPS 接入通过。\n");
  process.stdout.write(loggedIn ? "本机 Codex 已登录。\n" : "无法确认本机 Codex 登录，请检查 Codex 安装和 ChatGPT 登录。\n");
  if (!enrollment || network?.status !== 200 || !loggedIn) process.exitCode = 1;
}

async function main() {
  loadLocalEnv();
  const limits = readCodeWorkerConfig();
  const args = process.argv.slice(2);
  const check = args[0] === "--check";
  const fileArgs = check ? args.slice(1) : args;
  if (fileArgs.length > 1 || fileArgs[0]?.startsWith("--")) throw Error("设备启动参数无效。");
  const configPath = fileArgs[0] ?? runtimeSetting("SOULFLOW_CODE_WORKER_ENROLLMENT_FILE");
  if (check) { await selfCheck(configPath, limits); return; }
  const config = await readEnrollment(configPath);
  const capacity = readCapacity(limits);
  const { slots } = capacity;
  await chmod(config.file, 0o600);
  const image = process.env.SOULFLOW_GITHUB_CHECK_IMAGE?.trim();
  const timeoutMs = runtimeInteger("SOULFLOW_GITHUB_DELIVERY_TIMEOUT_MS", 1000, 3_600_000);
  const workspaceRoot = runtimeSetting("SOULFLOW_CODE_WORKER_ROOT");
  if (!image || !workspaceRoot) {
    throw Error("设备需配置仓库、隔离检查镜像及有效并发设置。");
  }
  const checkImage = image;
  const root = resolve(workspaceRoot);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const database = join(root, `${config.id}.sqlite`);
  const closeLock = lockWorkbench(database);
  const stop = new AbortController();
  const halt = () => stop.abort();
  process.once("SIGTERM", halt);
  process.once("SIGINT", halt);
  try {
    const store = openActivityStore(database);
    try {
      const checkpoint = store.checkpoint<Journal>("worker");
      const state = checkpoint.load()[0] ?? { instance: capacity.instance, pending: [] };
      const save = () => {
        if (!checkpoint.save("journal", state)) throw Error("设备无法写入回执状态。");
      };
      save();
      const send = connector(config.endpoint, config, limits);
      const publish = async (job: Pending, detail: ReceiptContent) => {
        const base = { id: job.id, digest: job.digest, at: Date.now() };
        let receipt: CodeReceipt = { ...base, ...detail };
        const instance = state.instance;
        // 超限是确定性失败，回报简短状态，避免在断线重试循环里反复发送。
        if (Buffer.byteLength(JSON.stringify({ instance, receipt })) > limits.messageBytes) {
          receipt = compactCodeFailure(receipt);
        }
        while (!stop.signal.aborted) {
          const result = await send("receipt", { instance, receipt }, stop.signal).catch(() => undefined);
          if (result?.status === 200) return receipt.phase;
          if (result?.status === 410) throw Error("设备工单已中断。");
          if (result && result.status < 500) throw Error("工作台拒绝设备回执。");
          await sleep(limits.retryMs, undefined, { signal: stop.signal });
        }
        stop.signal.throwIfAborted();
      };
      const remove = (id: string) => { state.pending = state.pending.filter(job => job.id !== id); save(); };
      // 进程重启后把遗留尝试交回主机核对。重新连接期间同一进程继续报告原任务。
      for (const job of [...state.pending]) {
        await publish(job, { phase: "interrupted" }).catch(error => {
          if (error.message !== "设备工单已中断。") throw error;
        });
        remove(job.id);
      }
      const active = new Map<string, Promise<void>>();
      async function run(offer: CodeOffer) {
        let completed: ReceiptContent;
        const state: { failureStage: WorkerFailureStage } = { failureStage: "checkout" };
        const patchState = { diagnostics: [] as PatchDiagnostic[], attempt: 1 as 1 | 2, applying: false };
        await publish(offer, { phase: "accepted" });
        process.stdout.write(`已收到 GitHub #${offer.work.issue}。\n`);
        try {
          const deadline = AbortSignal.any([stop.signal, AbortSignal.timeout(timeoutMs)]);
          completed = await doWork(offer, root, checkImage, timeoutMs, deadline,
            async detail => { await publish(offer, detail); }, stage => { state.failureStage = stage; }, patchState);
        } catch (error) {
          stop.signal.throwIfAborted();
          if (state.failureStage === "patch") patchState.diagnostics.push(patchFailureDiagnostic(error, patchState.attempt, patchState.applying));
          completed = { phase: "failed", failureStage: state.failureStage,
            ...(patchState.diagnostics.length ? { patchDiagnostics: patchState.diagnostics } : {}),
            ...(error instanceof IssueDeliveryFailed && error.failure.isolation ? { isolation: error.failure.isolation } : {}),
            ...(error instanceof IssueDeliveryFailed && error.failure.candidateDigest
              ? { candidateDigest: error.failure.candidateDigest, candidateFiles: error.failure.candidateFiles } : {}),
            ...(error instanceof IssueDeliveryFailed && error.failure.candidatePatch
              ? { candidatePatch: error.failure.candidatePatch, candidatePatchDigest: error.failure.candidatePatchDigest } : {}) };
        }
        const phase = await publish(offer, completed);
        process.stdout.write(`GitHub #${offer.work.issue} ${phase === "tested" ? "本机检查已通过，结果已回传" : "未完成，已回报主机"}。\n`);
      }
      let connected = false;
      try {
        while (!stop.signal.aborted) {
          const loggedIn = await probeCodeDeviceLogin(AbortSignal.any([stop.signal, AbortSignal.timeout(limits.httpTimeoutMs)]));
          if (stop.signal.aborted) break;
          const ready = loggedIn && active.size < slots;
          const wait = new AbortController();
          const polling = send("wait", { ...capacity, version: workerProtocolVersion, instance: state.instance, ready },
            AbortSignal.any([stop.signal, wait.signal])).catch(() => undefined);
          const result = ready ? await polling : await Promise.race([polling, ...active.values()]);
          if (!ready && !result) { wait.abort(); if (!stop.signal.aborted) await sleep(limits.retryMs, undefined, { signal: stop.signal }); continue; }
          if (!result || result.status >= 500 || result.status === 409) {
            connected = false;
            await sleep(limits.retryMs, undefined, { signal: stop.signal });
            continue;
          }
          if (result.status !== 200) throw Error("工作台拒绝代码设备接入。");
          if (!connected) process.stdout.write("已连到 souflow，等待调度器派单。\n");
          connected = true;
          if (!ready || result.offer === null) {
            if (!ready) await sleep(limits.retryMs, undefined, { signal: stop.signal });
            continue;
          }
          const offer = readCodeOffer(result.offer, limits);
          if (!offer || offer.work.repo.toLowerCase() !== capacity.repo) throw Error("设备收到无效或仓库不匹配的工单。");
          if (active.has(offer.id)) { await sleep(limits.retryMs, undefined, { signal: stop.signal }); continue; }
          state.pending.push({ id: offer.id, digest: offer.digest });
          save();
          const task = run(offer).then(() => remove(offer.id)).catch(error => {
            if (error.message === "设备工单已中断。") remove(offer.id);
            else if (!stop.signal.aborted) { process.exitCode = 1; halt(); }
          }).finally(() => { active.delete(offer.id); });
          active.set(offer.id, task);
        }
      } finally {
        halt();
        await Promise.allSettled(active.values());
      }
    } finally { store.close(); }
  } catch (error) {
    if (!stop.signal.aborted || !(error instanceof Error) || error.name !== "AbortError") throw error;
  } finally { closeLock(); }
}

main().catch(() => {
  process.stderr.write("代码设备未能继续。请检查接入文件、工作台许可和本机配置。\n");
  process.exitCode = 1;
});
