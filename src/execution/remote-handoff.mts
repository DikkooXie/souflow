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
export type RemoteDevice = { id: string; name: string; keyHash: string; instance?: string; lastSeen?: number; revoked?: true };
export type RemoteJob = {
  id: string; deviceId: string; revision: string;
  files: Array<Omit<RemoteFile, "text"> & { text?: string }>;
  receipts: Receipt[]; status: "queued" | "running" | "ready" | "failed";
};
type Store<T extends object> = Checkpoint<T>;
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
  offlineMs: number, now = Date.now) {
  const devices = new Map(deviceStore.load().map(device => [device.id, device]));
  const jobs = new Map(jobStore.load().map(job => [job.id, job]));
  // 探针存活只对当前工作台进程有效，重启后等设备重新报到。
  const online = new Map<string, number>();
  const connected = (id: string) => now() - (online.get(id) ?? -Infinity) <= offlineMs;
  function recordJob(job: RemoteJob, action: string, actor?: string) {
    const event: BusinessEvent = { kind: "remote.job", subject: job.id,
      details: { action, deviceId: job.deviceId, revision: job.revision, status: job.status, received: job.receipts.length, actor } };
    if (!jobStore.save(job.id, job, event)) return false;
    jobs.set(job.id, job);
    return true;
  }
  return {
    addDevice(name: unknown, actor: string) {
      if (typeof name !== "string" || !/^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,39}$/u.test(name)) return { status: 422 } as const;
      const registered = [...devices.values()].filter(item => !item.revoked);
      if (registered.length >= 12 || registered.some(item => item.name === name)) return { status: 409 } as const;
      const id = randomUUID();
      const key = randomBytes(32).toString("hex");
      const device = { id, name, keyHash: digest(key) };
      if (!deviceStore.save(id, device, { kind: "remote.device", subject: id,
        details: { action: "created", name, actor } })) return { status: 503 } as const;
      devices.set(id, device);
      return { status: 201, bundle: { id, key, name } } as const;
    },
    revoke(id: string, actor: string) {
      const device = devices.get(id);
      if (!device) return 404;
      if (device.revoked) return 200;
      const next = { ...device, revoked: true as const };
      if (!deviceStore.save(id, next, { kind: "remote.device", subject: id,
        details: { action: "revoked", name: device.name, actor } })) return 503;
      devices.set(id, next);
      online.delete(id);
      return 200;
    },
    enqueue(deviceId: unknown, revision: string, files: RemoteFile[], actor: string) {
      const device = typeof deviceId === "string" ? devices.get(deviceId) : undefined;
      if (!device || device.revoked) return { status: 404 } as const;
      if ([...jobs.values()].some(job => job.deviceId === device.id && (job.status === "queued" || job.status === "running"))) {
        return { status: 409 } as const;
      }
      const job: RemoteJob = { id: randomUUID(), deviceId: device.id, revision, files, receipts: [], status: "queued" };
      if (!recordJob(job, "queued", actor)) return { status: 503 } as const;
      return { status: 201, id: job.id } as const;
    },
    poll(id: string, authorization: string | undefined, input: unknown) {
      const device = devices.get(id);
      const key = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
      if (!device || device.revoked || !key || !keyFormat.test(key)
        || !timingSafeEqual(Buffer.from(device.keyHash, "hex"), Buffer.from(digest(key), "hex"))) return { status: 401 } as const;
      const { instance, update } = object(input);
      if (typeof instance !== "string" || !uuid.test(instance)) return { status: 422 } as const;
      if (device.instance && device.instance !== instance) return { status: 409 } as const;
      if (!connected(id)) {
        const next = { ...device, instance, lastSeen: now() };
        if (!deviceStore.save(id, next, { kind: "remote.device", subject: id,
          details: { action: device.instance ? "reconnected" : "connected", name: device.name } })) return { status: 503 } as const;
        devices.set(id, next);
      }
      online.set(id, now());

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
          if (!recordJob({ ...job, receipts, status, files }, status === "running" ? "progress" : "finished")) {
            return { status: 503 } as const;
          }
        }
      }
      const job = [...jobs.values()].find(item => item.deviceId === id && (item.status === "queued" || item.status === "running"));
      if (!job) return { status: 200, task: null } as const;
      if (job.status === "queued" && !recordJob({ ...job, status: "running" }, "claimed")) return { status: 503 } as const;
      // 未收到上一次领取回执时仍返回同一工单和进度。
      return { status: 200, task: { id: job.id, revision: job.revision, files: job.files, receipts: job.receipts } } as const;
    },
    snapshot() {
      return {
        devices: [...devices.values()].filter(device => !device.revoked).map(({ id, name, instance, lastSeen }) => ({
          id, name, status: connected(id) ? "online" : instance ? "offline" : "pending", lastSeen: online.get(id) ?? lastSeen,
        })),
        jobs: [...jobs.values()].slice(-24).reverse().map(({ id, deviceId, revision, status, files, receipts }) => ({
          id, deviceId, revision, deviceName: devices.get(deviceId)?.name,
          status: devices.get(deviceId)?.revoked && (status === "queued" || status === "running") ? "revoked" : status,
          files: files.map(({ path, sha256, bytes }) => ({ path, sha256, bytes })), receipts: receipts.map(receipt => ({ ...receipt })),
        })),
      };
    },
  };
}

export type RemoteHandoff = ReturnType<typeof createRemoteHandoff>;
