import { randomUUID } from "node:crypto";
import type { Checkpoint, RecordBusiness } from "../audit/activity-store.mts";
import { legacyCodeEditFileBytes, readCodeWorkerConfig } from "../config/runtime.mts";
import { contentDigest, type CandidateFile, type CodeOffer, type CodeReceipt, type CodeWork, type WorkerFailureStage, validCodeWork,
  workerProtocolVersion } from "./code-worker-protocol.mts";
import type { IsolationEvidence } from "./isolation-evidence.mts";
import { IssueVerificationUncertain } from "./issue-verification.mts";

type State = "offered" | CodeReceipt["phase"] | "cancelled";
export type WorkerFailureScope = Pick<CodeWork, "repo" | "issue" | "issueRevision" | "plan">;
export type WorkerAttempt = {
  id: string; device: string; name: string; instance: string; repo: string; issue: number; revision: string;
  flowId: string; digest: string; issueRevision: string; state: State; assignedAt: number; updatedAt: number;
  plan: CodeWork["plan"]; weight: number; slots: number; assignedLoad: number; files: CodeWork["files"];
  receipt?: { digest: string; at: number; thread?: string; patch?: string; failureStage?: WorkerFailureStage;
    isolation?: IsolationEvidence; candidateDigest?: string; candidateFiles?: CandidateFile[]; candidatePatch?: string; candidatePatchDigest?: string };
};
type Device = { id: string; name: string; instance: string; repo: string; slots: number; ready: boolean; local?: boolean; editFileBytes?: number };
type Ready = { device: Device; send: (offer?: CodeOffer) => void };
type Running = { offer: CodeOffer; settled: (receipt: CodeReceipt) => void; started: (thread: string) => void; interrupt: () => void;
  verifyCandidate?: (receipt: Extract<CodeReceipt, { phase: "failed" }>) => boolean };
const unfinished = (state: State) => state === "offered" || state === "accepted" || state === "started";
const supportsFiles = (device: Device, work: CodeWork) =>
  work.files.every(file => (file.bytes ?? 0) <= (device.editFileBytes ?? legacyCodeEditFileBytes));

export function createCodeWorkerPool(store: Checkpoint<WorkerAttempt>, allowed: ReadonlySet<string>,
  config = readCodeWorkerConfig(), now = Date.now, record?: RecordBusiness) {
  const attempts = new Map(store.load().map(attempt => [attempt.id, attempt]));
  const waiters = new Map<string, Ready>();
  const online = new Map<string, { device: Device; at: number }>();
  const running = new Map<string, Running>();
  const wakeups = new Set<() => void>();
  let closed = false;
  const changed = () => { for (const wake of wakeups) wake(); };

  function save(attempt: WorkerAttempt, fromDevice = false) {
    const { id, repo, issue, revision, state, device, digest, assignedLoad, slots, receipt } = attempt;
    if (!store.save(id, attempt, { kind: "remote.code", subject: id, flowId: attempt.flowId, attemptId: id,
      details: { action: state, repo, issue, revision, device, digest, assignedLoad, slots, at: now(),
        issueRevision: attempt.issueRevision, planVersion: attempt.plan.version, batchDigest: attempt.plan.batchDigest,
        direction: state === "offered" ? "to-device" : fromDevice ? "from-device" : "host",
        ...(fromDevice && receipt ? { deviceAt: receipt.at, thread: receipt.thread, patch: receipt.patch,
          failureStage: receipt.failureStage, isolation: receipt.isolation, candidateDigest: receipt.candidateDigest,
          candidateFiles: receipt.candidateFiles, candidatePatchDigest: receipt.candidatePatchDigest } : {}) } })) return false;
    attempts.set(id, attempt);
    return true;
  }

  for (const entry of attempts.values()) {
    if (unfinished(entry.state) && !save({ ...entry, state: "interrupted", updatedAt: now() })) {
      throw Error("无法恢复双机代码派发记录。");
    }
  }

  function capacity(device: Pick<Device, "id">) {
    const assigned = [...attempts.values()].filter(row => row.device === device.id && unfinished(row.state));
    return { load: assigned.reduce((sum, row) => sum + row.weight, 0), count: assigned.length };
  }

  async function wait(signal: AbortSignal) {
    if (signal.aborted || closed) return;
    await new Promise<void>(resolve => {
      const wake = () => {
        wakeups.delete(wake);
        signal.removeEventListener("abort", wake);
        resolve();
      };
      wakeups.add(wake);
      signal.addEventListener("abort", wake, { once: true });
    });
  }

  function latestForScope(scope: WorkerFailureScope) {
    const latest = [...attempts.values()].reverse().find(row => row.state !== "cancelled" &&
      row.repo.toLowerCase() === scope.repo.toLowerCase() && row.issue === scope.issue);
    if (latest?.receipt && latest.issueRevision === scope.issueRevision
      && latest.plan.flowId === scope.plan.flowId && latest.plan.version === scope.plan.version
      && latest.plan.flowDigest === scope.plan.flowDigest && latest.plan.batchDigest === scope.plan.batchDigest) return latest;
  }

  return {
    config,
    permits: (id: string) => allowed.has(id),
    hasAttempt: (repo: string, issue: number) => [...attempts.values()].some(row => row.state !== "cancelled"
      && row.repo.toLowerCase() === repo.toLowerCase() && row.issue === issue),
    failedAttempt(scope: WorkerFailureScope) {
      // 按持久化派发顺序检查最后一次。同一工单有更新的尝试时，不能凭旧回执再次派发。
      const latest = latestForScope(scope);
      if (latest?.state === "failed" && latest.receipt) return { id: latest.id,
        ...(latest.receipt.failureStage ? { failureStage: latest.receipt.failureStage } : {}),
        ...(latest.receipt.isolation ? { isolation: latest.receipt.isolation } : {}),
        ...(latest.receipt.candidateDigest ? { candidateDigest: latest.receipt.candidateDigest } : {}),
        ...(latest.receipt.candidateFiles ? { candidateFiles: latest.receipt.candidateFiles } : {}),
        ...(latest.receipt.candidatePatch ? { candidatePatch: latest.receipt.candidatePatch,
          candidatePatchDigest: latest.receipt.candidatePatchDigest } : {}) };
    },
    testedPatch(scope: WorkerFailureScope) {
      const latest = latestForScope(scope);
      if (latest?.state === "tested" && latest.receipt?.patch) {
        return { id: latest.id, patch: latest.receipt.patch, revision: latest.revision };
      }
    },
    async poll(device: Device, signal: AbortSignal) {
      if (!allowed.has(device.id) || closed || signal.aborted) return { status: 403 } as const;
      if (waiters.has(device.id)) return { status: 409 } as const;
      const at = now();
      const previous = online.get(device.id);
      online.set(device.id, { device, at });
      if (!previous || at - previous.at > config.offlineMs) record?.({
        kind: "remote.code", subject: device.id, details: {
          action: previous ? "reconnected" : "connected", direction: "from-device", device: device.id, repo: device.repo, slots: device.slots,
        },
      });
      const offered = [...attempts.values()].find(row => row.device === device.id && row.instance === device.instance
        && row.repo === device.repo && row.state === "offered");
      const replay = offered && running.get(offered.id);
      if (replay && device.ready && supportsFiles(device, replay.offer.work)) return { status: 200, offer: replay.offer } as const;
      const offer = await new Promise<CodeOffer | undefined>(resolve => {
        const settle = (offer?: CodeOffer) => {
          clearTimeout(timer);
          signal.removeEventListener("abort", abort);
          waiters.delete(device.id);
          resolve(offer);
        };
        const abort = () => settle();
        const timer = setTimeout(abort, config.waitMs);
        signal.addEventListener("abort", abort, { once: true });
        waiters.set(device.id, { device, send: settle });
        changed();
      });
      return { status: 200, offer: offer ?? null } as const;
    },
    receipt(device: { id: string; instance: string }, receipt: CodeReceipt) {
      const attempt = attempts.get(receipt.id);
      if (!allowed.has(device.id) || !attempt || attempt.device !== device.id ||
          attempt.instance !== device.instance || attempt.digest !== receipt.digest) return 409;
      if (attempt.state === "interrupted" || (!unfinished(attempt.state) && receipt.phase === "interrupted")
          || (unfinished(attempt.state) && !running.has(attempt.id))) return 410;
      const digest = contentDigest(JSON.stringify(receipt));
      const active = running.get(attempt.id);
      if (attempt.receipt?.digest === digest) {
        if (receipt.phase === "started") active?.started(receipt.thread);
        return 200;
      }
      const permitted = attempt.state === "offered" ? ["accepted", "declined", "interrupted"]
        : attempt.state === "accepted" ? ["started", "declined", "failed", "interrupted"]
          : attempt.state === "started" ? ["tested", "failed", "interrupted"] : [];
      if (!permitted.includes(receipt.phase) || (attempt.receipt && receipt.at < attempt.receipt.at)) return 409;
      if (receipt.phase === "failed" && receipt.candidateFiles) {
        const approved = new Map((attempt.files ?? []).map(file => [file.path, file.sha256]));
        if (receipt.candidateFiles.some(file => approved.get(file.path) !== file.before)) return 422;
      }
      if (receipt.phase === "failed" && receipt.candidatePatch
        && !active?.verifyCandidate?.(receipt)) return 422;
      if (!save({ ...attempt, state: receipt.phase, updatedAt: now(), receipt: { digest, at: receipt.at,
        ...("thread" in receipt ? { thread: receipt.thread } : attempt.receipt?.thread
          ? { thread: attempt.receipt.thread } : {}),
        ...("patch" in receipt ? { patch: receipt.patch } : {}),
        ...(receipt.phase === "failed" && receipt.failureStage ? { failureStage: receipt.failureStage } : {}),
        ...(receipt.phase === "failed" && receipt.isolation ? { isolation: receipt.isolation } : {}),
        ...(receipt.phase === "failed" && receipt.candidateDigest ? { candidateDigest: receipt.candidateDigest,
          candidateFiles: receipt.candidateFiles } : {}),
        ...(receipt.phase === "failed" && receipt.candidatePatch ? { candidatePatch: receipt.candidatePatch,
          candidatePatchDigest: receipt.candidatePatchDigest } : {}) } }, true)) return 503;
      const current = online.get(device.id);
      if (current) current.at = now();
      if (receipt.phase === "started") active?.started(receipt.thread);
      if (!unfinished(receipt.phase)) active?.settled(receipt);
      changed();
      return 200;
    },
    async execute(work: CodeWork, signal: AbortSignal, timeoutMs: number, started: (thread: string) => void,
      revalidate: (signal: AbortSignal) => Promise<void>,
      verifyCandidate?: (receipt: Extract<CodeReceipt, { phase: "failed" }>) => boolean,
      offered?: (attemptId: string) => void) {
      if (!validCodeWork(work, config)) throw Error("已批准的远端工单上下文无效。");
      const availabilityDeadline = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
      const weight = work.files.length;
      const pickTarget = () => [...waiters.values()]
          .filter(entry => entry.device.ready && entry.device.repo === work.repo.toLowerCase()
            && supportsFiles(entry.device, work))
          .map(entry => ({ ...entry, ...capacity(entry.device) }))
          .filter(entry => entry.count < entry.device.slots)
          .sort((a, b) => (a.load + weight) / a.device.slots - (b.load + weight) / b.device.slots
            || a.count - b.count || a.device.id.localeCompare(b.device.id))[0];
      // 等待设备可能跨过 Issue 改派或正文修改。只在准备发出时回读，再用最新连接分配。
      while (!availabilityDeadline.aborted && !closed) {
        if (!pickTarget()) {
          await wait(availabilityDeadline);
          continue;
        }
        await revalidate(availabilityDeadline);
        if (availabilityDeadline.aborted || closed) break;
        const target = pickTarget();
        if (!target) continue;
        const { device } = target;
        // 等待设备只消耗可用性预算；设备收到工单后重新计时，留出执行时间和回执宽限。
        const executionDeadline = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs + config.receiptGraceMs)]);
        const id = randomUUID();
        const digest = contentDigest(JSON.stringify(work));
        const offer = { id, digest, version: workerProtocolVersion, work };
        if (Buffer.byteLength(JSON.stringify({ offer })) > config.messageBytes) throw Error("工单上下文超过设备接收上限。");
        const assignedAt = now();
        const attempt: WorkerAttempt = { id, device: device.id, name: device.name, instance: device.instance, repo: work.repo, issue: work.issue,
          revision: work.revision, digest, issueRevision: work.issueRevision,
          flowId: work.plan.flowId, state: "offered", assignedAt, updatedAt: assignedAt,
          plan: work.plan, slots: device.slots, assignedLoad: target.load, weight, files: work.files };
        if (!save(attempt)) throw Error("无法保存设备派发记录。");
        try { offered?.(id); }
        catch (error) {
          // 记录派发的业务状态失败时，撤销尚未发出的 offer，避免设备执行位永久占用。
          const pending = attempts.get(id);
          if (pending && unfinished(pending.state)) {
            const cancelled: WorkerAttempt = { ...pending, state: "cancelled", updatedAt: now() };
            // SQLite 短时不可写时仍先释放本进程容量；若进程同时退出，持久化的 offered 会恢复为 uncertain。
            if (!save(cancelled)) attempts.set(id, cancelled);
          }
          throw error;
        }
        const result = await new Promise<CodeReceipt | undefined>(resolve => {
          const settle = (receipt?: CodeReceipt) => {
            executionDeadline.removeEventListener("abort", interrupted);
            running.delete(id);
            resolve(receipt);
          };
          const interrupted = () => {
            const current = attempts.get(id);
            if (current && unfinished(current.state)) save({ ...current, state: "interrupted", updatedAt: now() });
            settle();
          };
          running.set(id, { offer, settled: settle, started, interrupt: interrupted,
            ...(verifyCandidate ? { verifyCandidate } : {}) });
          executionDeadline.addEventListener("abort", interrupted, { once: true });
          target.send(offer);
        });
        if (!result || result.phase === "interrupted") throw new IssueVerificationUncertain("needs-reconciliation");
        return result;
      }
      throw new IssueVerificationUncertain("interrupted");
    },
    snapshot() {
      const at = now();
      const rows = [...attempts.values()];
      return {
        activityMs: config.activityMs,
        devices: [...online.values()].map(({ device: { instance: _instance, ...device }, at: seen }) => ({
          ...device, ...capacity(device), lastSeen: seen, online: at - seen <= config.offlineMs,
        })),
        attempts: rows.filter((attempt, index) => unfinished(attempt.state) || index >= rows.length - config.recentAttempts)
          .map(({ instance: _instance, ...attempt }) => {
            if (!attempt.receipt?.candidatePatch) return attempt;
            const { candidatePatch: _candidatePatch, ...receipt } = attempt.receipt;
            return { ...attempt, receipt };
          }),
      };
    },
    disconnect(id: string) {
      waiters.get(id)?.send();
      online.delete(id);
      for (const [attempt, active] of running) {
        if (attempts.get(attempt)?.device === id) active.interrupt();
      }
      changed();
    },
    close() {
      closed = true;
      for (const entry of waiters.values()) entry.send();
      for (const active of running.values()) active.interrupt();
      changed();
    },
  };
}

export type CodeWorkerPool = ReturnType<typeof createCodeWorkerPool>;
