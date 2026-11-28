import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { BusinessEvent, Checkpoint } from "../audit/activity-store.mts";

const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const sha256 = /^[0-9a-f]{64}$/;
const keyFormat = /^[a-f0-9]{64}$/;
export const remotePath = /^docs\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+\.md$/;
export const remoteMaxFiles = 4;
export const remoteMaxFileBytes = 65_536;
export type RemoteFile = { path: string; sha256: string; bytes: number; text: string };
type Receipt = { sha256: string; bytes: number; headings: number };
export type RemoteDevice = { id: string; name: string; keyHash: string; instance?: string; lastSeen?: number; revoked?: true; owner?: string };
export type RemoteJob = {
  id: string; deviceId: string; revision: string;
  files: Array<Omit<RemoteFile, "text"> & { text?: string }>;
  receipts: Receipt[]; status: "queued" | "running" | "ready" | "failed";
  queuedAt?: number; finishedAt?: number;
};
type Store<T extends object> = Checkpoint<T>;
const historyLimit = 24;
const unfinished = (status: string) => status === "queued" || status === "running";
const digest = (text: string) => createHash("sha256").update(text).digest("hex");

function object(value: unknown) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function readReceipts(value: unknown): Receipt[] | undefined {
  if (!Array.isArray(value) || value.length > remoteMaxFiles) return;
  const records: Receipt[] = [];
  for (const raw of value) {
    const { sha256: hash, bytes, headings } = object(raw);
    if (typeof hash !== "string" || !sha256.test(hash) || typeof bytes !== "number" || !Number.isSafeInteger(bytes)
      || bytes < 0 || bytes > remoteMaxFileBytes || typeof headings !== "number" || !Number.isSafeInteger(headings)
      || headings < 0 || headings > bytes) return;
    records.push({ sha256: hash, bytes, headings });
  }
  return records;
}

export function createRemoteHandoff(deviceStore: Store<RemoteDevice>, jobStore: Store<RemoteJob>,
  offlineMs: number, now = Date.now, record?: (event: BusinessEvent) => boolean) {
  const pairings = new Map<string, { id: string; name: string; hash: string; expiresAt: number }>();
  const validName = (name: unknown): name is string =>
    typeof name === "string" && /^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,39}$/u.test(name);
  const devices = new Map(deviceStore.load().map(device => [device.id, device]));
  const jobs = new Map(jobStore.load().map(job => [job.id, job]));
  // 探针存活只对当前工作台进程有效，重启后等设备重新报到。
  const online = new Map<string, number>();
  const heartbeatAuditedAt = new Map<string, number>();
  const connected = (id: string, at = now()) => at - (online.get(id) ?? -Infinity) <= offlineMs;
  function authenticate(id: string, authorization: string | undefined) {
    const device = devices.get(id);
    const key = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
    if (!device || device.revoked || !keyFormat.test(key)
      || !timingSafeEqual(Buffer.from(device.keyHash, "hex"), Buffer.from(digest(key), "hex"))) return;
    return device;
  }
  function recordJob(job: RemoteJob, action: string, actor?: string,
    communication?: { direction: "to-device" | "from-device"; at: number }) {
    const event: BusinessEvent = { kind: "remote.job", subject: job.id,
      details: { action, deviceId: job.deviceId, revision: job.revision, status: job.status,
        received: job.receipts.length, actor, ...communication } };
    if (!jobStore.save(job.id, job, event)) return false;
    jobs.set(job.id, job);
    return true;
  }
  function register(name: string, actor: string, id: string = randomUUID(), owner?: string) {
    const registered = [...devices.values()].filter(item => !item.revoked);
    if (registered.length >= 12 || registered.some(item => item.name === name)) return { status: 409 } as const;
    const key = randomBytes(32).toString("hex");
    const device: RemoteDevice = { id, name, keyHash: digest(key), ...(owner ? { owner } : {}) };
    if (!deviceStore.save(id, device, { kind: "remote.device", subject: id,
      details: { action: owner ? "paired" : "created", name, actor } })) return { status: 503 } as const;
    devices.set(id, device);
    return { status: 201, bundle: { id, key, name } } as const;
  }
  return {
    ownsDevice(id: string, actor: string) {
      const device = devices.get(id);
      return !!device && !device.revoked && device.owner === actor;
    },
    startPairing(name: unknown, actor: string) {
      if (!validName(name)) return { status: 422 } as const;
      const id = randomUUID();
      const code = randomBytes(32).toString("hex");
      const expiresAt = now() + 5 * 60_000;
      if (record && !record({ kind: "remote.device", subject: id,
        details: { action: "pairing-started", name, actor, expiresAt } })) return { status: 503 } as const;
      pairings.set(actor, { id, name, hash: digest(code), expiresAt });
      return { status: 201, code, expiresAt } as const;
    },
    confirmPairing(code: unknown, actor: string) {
      const pending = pairings.get(actor);
      if (!pending || pending.expiresAt <= now() || typeof code !== "string" || !keyFormat.test(code)
        || !timingSafeEqual(Buffer.from(pending.hash, "hex"), Buffer.from(digest(code), "hex"))) {
        return { status: 409 } as const;
      }
      // 工作台独占数据库。同步保存所有权后才消费配对码，写入失败时可重试。
      const result = register(pending.name, actor, pending.id, actor);
      if (result.status === 201) pairings.delete(actor);
      return result;
    },
    canAuthenticateCodeDevice: (id: string, authorization: string | undefined) => !!authenticate(id, authorization),
    identifyCodeDevice(id: string, authorization: string | undefined, instance: string) {
      const device = authenticate(id, authorization);
      if (!device) return { status: 401 } as const;
      if (!uuid.test(instance) || (device.instance && device.instance !== instance)) return { status: 409 } as const;
      if (!device.instance) {
        const bound = { ...device, instance };
        if (!deviceStore.save(id, bound)) return { status: 503 } as const;
        devices.set(id, bound);
      }
      return { status: 200, name: device.name } as const;
    },
    addDevice(name: unknown, actor: string) {
      return validName(name) ? register(name, actor) : { status: 422 } as const;
    },
    revoke(id: string, actor: string) {
      const device = devices.get(id);
      if (!device || (device.owner !== undefined && device.owner !== actor)) return 404;
      if (device.revoked) return 200;
      const next = { ...device, revoked: true as const };
      if (!deviceStore.save(id, next, { kind: "remote.device", subject: id,
        details: { action: "revoked", name: device.name, actor } })) return 503;
      devices.set(id, next);
      online.delete(id);
      heartbeatAuditedAt.delete(id);
      return 200;
    },
    enqueue(deviceId: unknown, revision: string, files: RemoteFile[], actor: string) {
      const device = typeof deviceId === "string" ? devices.get(deviceId) : undefined;
      if (!device || device.revoked) return { status: 404 } as const;
      if ([...jobs.values()].some(job => job.deviceId === device.id && unfinished(job.status))) {
        return { status: 409 } as const;
      }
      const job: RemoteJob = { id: randomUUID(), deviceId: device.id, revision, files, receipts: [], status: "queued", queuedAt: now() };
      if (!recordJob(job, "queued", actor)) return { status: 503 } as const;
      return { status: 201, id: job.id } as const;
    },
    poll(id: string, authorization: string | undefined, input: unknown) {
      const device = authenticate(id, authorization);
      if (!device) return { status: 401 } as const;
      const { instance, update } = object(input);
      if (typeof instance !== "string" || !uuid.test(instance)) return { status: 422 } as const;
      if (device.instance && device.instance !== instance) return { status: 409 } as const;
      const at = now();
      let progress: RemoteJob | undefined;

      if (update !== undefined) {
        const { id: jobId, receipts: value } = object(update);
        const job = typeof jobId === "string" ? jobs.get(jobId) : undefined;
        const receipts = readReceipts(value);
        if (!job || job.deviceId !== id || job.status === "queued" || !receipts || receipts.length > job.files.length) {
          return { status: 409 } as const;
        }
        const common = Math.min(receipts.length, job.receipts.length);
        if (!isDeepStrictEqual(receipts.slice(0, common), job.receipts.slice(0, common))) return { status: 409 } as const;
        if (receipts.length > job.receipts.length) {
          if (job.status !== "running") return { status: 409 } as const;
          const match = receipts.every((receipt, index) => receipt.sha256 === job.files[index]?.sha256
            && receipt.bytes === job.files[index]?.bytes);
          const status = !match ? "failed" : receipts.length === job.files.length ? "ready" : "running";
          const files = status === "running" ? job.files : job.files.map(({ path, sha256, bytes }) => ({ path, sha256, bytes }));
          progress = { ...job, receipts, status, files, ...(status === "running" ? {} : { finishedAt: at }) };
        }
      }
      if (progress && !recordJob(progress, progress.status === "running" ? "progress" : "finished", undefined,
        { direction: "from-device", at })) return { status: 503 } as const;

      const job = [...jobs.values()].find(item => item.deviceId === id && unfinished(item.status));
      if (job?.status === "queued" && !recordJob({ ...job, status: "running" }, "claimed", undefined,
        { direction: "to-device", at })) return { status: 503 } as const;

      // 连入或重连的审计随身份绑定和通信时间一起保存，成功后才标记在线。
      const connectionAction = connected(id, at) ? undefined : device.instance ? "reconnected" : "connected";
      // 一个离线判定窗口内，每台设备最多记录一次普通心跳审计。
      const auditHeartbeat = !connectionAction && update === undefined
        && at - (heartbeatAuditedAt.get(id) ?? -Infinity) >= offlineMs;
      const action = connectionAction ?? (auditHeartbeat ? "heartbeat" : undefined);
      const seen = { ...device, instance, lastSeen: at };
      const event: BusinessEvent | undefined = action ? { kind: "remote.device", subject: id,
        details: { action, direction: "from-device", at, ...(connectionAction ? { name: device.name } : {}) } } : undefined;
      if (!deviceStore.save(id, seen, event)) return { status: 503 } as const;
      devices.set(id, seen);
      if (auditHeartbeat) heartbeatAuditedAt.set(id, at);
      online.set(id, at);
      if (!job) return { status: 200, task: null } as const;
      // 未收到上一次领取回执时仍返回同一工单和进度。
      return { status: 200, task: { id: job.id, revision: job.revision, files: job.files, receipts: job.receipts } } as const;
    },
    snapshot() {
      const visible = [...jobs.values()].reverse().map(({ id, deviceId, revision, status, files, receipts, queuedAt, finishedAt }) => {
        const device = devices.get(deviceId);
        return { id, deviceId, revision, deviceName: device?.name,
          status: device?.revoked && unfinished(status) ? "revoked" as const : status, files, receipts,
          queuedAt, finishedAt };
      });
      const current = visible.filter(job => unfinished(job.status));
      const history = visible.filter(job => !unfinished(job.status))
        .sort((a, b) => (b.finishedAt ?? b.queuedAt ?? 0) - (a.finishedAt ?? a.queuedAt ?? 0)).slice(0, historyLimit);
      return {
        devices: [...devices.values()].filter(device => !device.revoked).map(({ id, name, instance, lastSeen }) => ({
          id, name, status: connected(id) ? "online" : instance ? "offline" : "pending", lastSeen: online.get(id) ?? lastSeen,
        })),
        jobs: [...current, ...history].map(({ files, receipts, ...job }) => ({
          ...job, files: files.map(({ path, sha256, bytes }) => ({ path, sha256, bytes })), receipts: receipts.map(receipt => ({ ...receipt })),
        })),
      };
    },
  };
}

export type RemoteHandoff = ReturnType<typeof createRemoteHandoff>;
