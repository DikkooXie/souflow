import { realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { type CodexAccountStatus, probeCodexAccount } from "./codex-account-status.mts";

export type CodexProfile = { label: string; directory: string; concurrency: number };
export type AccountAssignment = { label: string; plan?: string; remaining?: number; active: number; capacity: number; reason: string };
export type AccountOptions = { account?: { directory: string; expectedRef: string; onLimited: () => void } };

// 套餐只在负载和可用额度打平时参与排序，避免仅凭订阅推测实际额度。
const personalPlans = new Map(["free", "go", "plus", "prolite", "pro", "promax"].map((plan, rank) => [plan, rank]));

export function readCodexProfiles(raw: string): CodexProfile[] {
  const invalid = () => Error("Codex 账号配置需要独立的本机目录、安全的账号别名和正整数并发上限。");
  let rows: unknown;
  try { rows = JSON.parse(raw); } catch { throw invalid(); }
  if (!Array.isArray(rows) || !rows.length || rows.length > 8) throw invalid();
  const labels = new Set<string>();
  const directories = new Set<string>();
  return rows.map(row => {
    const { label, directory, concurrency } = row ?? {};
    if (typeof label !== "string" || !/^[a-z][a-z0-9-]{0,31}$/.test(label) || labels.has(label)
      || typeof directory !== "string" || !isAbsolute(directory)
      || !Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 24) throw invalid();
    let resolved: string;
    try {
      resolved = realpathSync(directory);
      if (!statSync(resolved).isDirectory()) throw invalid();
    } catch { throw invalid(); }
    if (directories.has(resolved)) throw invalid();
    labels.add(label);
    directories.add(resolved);
    return { label, directory: resolved, concurrency };
  });
}

export function createCodexAccountDispatch(profiles: readonly CodexProfile[], workspace: string, {
  refreshMs = 30_000, probeMs = 10_000, waitMs = 60_000, cooldownMs = 60_000,
  probe = probeCodexAccount, now = Date.now,
} = {}) {
  let observed: { profile: CodexProfile; account: CodexAccountStatus | undefined }[] = [];
  let refreshAfter = 0;
  let reading: Promise<void> | undefined;
  const active = new Map<string, number>();
  const limitedUntil = new Map<string, number>();

  async function refresh() {
    if (now() < refreshAfter) return;
    reading ??= (async () => {
      observed = await Promise.all(profiles.map(async profile => ({
        profile, account: await probe(profile.directory, workspace, probeMs).catch(() => undefined),
      })));
      refreshAfter = now() + refreshMs;
      const blocked = new Set(observed.flatMap(({account}) => account?.limited === true ? [account.ref] : []));
      for (const ref of blocked) if (!limitedUntil.has(ref)) limitedUntil.set(ref, now());
      // 未知的普通用量状态不能解除已经明确的限流。
      for (const { account } of observed) {
        if (account?.limited === false && !blocked.has(account.ref) && (limitedUntil.get(account.ref) ?? Infinity) <= now()) {
          limitedUntil.delete(account.ref);
        }
      }
    })().finally(() => { reading = undefined; });
    await reading;
  }

  function candidates() {
    const seen = new Set<string>();
    return observed.flatMap(({profile, account}) => {
      if (!account || seen.has(account.ref)) return [];
      seen.add(account.ref);
      const count = active.get(account.ref) ?? 0;
      if (limitedUntil.has(account.ref) || count >= profile.concurrency) return [];
      return [{ profile, account, count, load: count / profile.concurrency, quota: account.remaining ?? -1,
        rank: personalPlans.get(account.plan ?? "") ?? -1 }];
    }).sort((a, b) => a.load - b.load || b.quota - a.quota || b.rank - a.rank);
  }

  return {
    async run<T>(signal: AbortSignal, assigned: (assignment: AccountAssignment) => void, execute: (options: AccountOptions) => Promise<T>): Promise<T> {
      const deadline = now() + waitMs;
      for (;;) {
        signal.throwIfAborted();
        await refresh();
        signal.throwIfAborted();
        const [first, second] = candidates();
        if (first) {
          const { profile, account, count } = first;
          const reason = !second ? "当前唯一可接单账号"
            : first.load !== second.load ? "优先分配给当前负载较低的账号"
            : first.quota !== second.quota ? "负载相同，优先选择已知可用额度较多的账号"
            : first.rank !== second.rank ? "负载和额度相同，按已知订阅档位排序"
            : "负载、额度和订阅相同，按配置顺序分配";
          // 选择和预留在同一同步步骤完成，避免同时派发共享同一空位。
          active.set(account.ref, count + 1);
          try {
            assigned({ label: profile.label, active: count, capacity: profile.concurrency, reason,
              ...(account.plan ? { plan: account.plan } : {}), ...(account.remaining === undefined ? {} : { remaining: account.remaining }) });
            return await execute({ account: { directory: profile.directory, expectedRef: account.ref,
              onLimited() { limitedUntil.set(account.ref, now() + cooldownMs); } } });
          } finally {
            const count = (active.get(account.ref) ?? 1) - 1;
            if (count) active.set(account.ref, count);
            else active.delete(account.ref);
          }
        }
        if (!observed.some(row => row.account)) throw Error("没有已确认登录的 Codex 账号。");
        if (now() >= deadline) throw Error("Codex 账号均满载或暂不可用。");
        await delay(Math.min(1000, deadline - now()), undefined, { signal });
      }
    },
  };
}

export type CodexAccountDispatch = ReturnType<typeof createCodexAccountDispatch>;

export function withCodexAccount<T>(pool: CodexAccountDispatch | undefined, signal: AbortSignal,
  assigned: (assignment: AccountAssignment) => void, execute: (options: AccountOptions) => Promise<T>) {
  return pool ? pool.run(signal, assigned, execute) : execute({});
}
