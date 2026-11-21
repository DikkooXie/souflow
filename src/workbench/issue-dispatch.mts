import type { BusinessEvent, Checkpoint } from "../audit/activity-store.mts";
import type { IssueDetail, IssueSummary, IssueTracker } from "../connections/issue-tracker.mts";
import { IssueVerificationUncertain, type VerifyIssue } from "../execution/issue-verification.mts";

type Remote = IssueSummary & Pick<IssueDetail, "pulls"> & { syncedAt: number };
export type Claim = Remote & {
  requestId: string; claimedBy: string; account: string; phase: keyof typeof phases;
  sessionId?: string; report?: string;
};
const phases = { claiming: "正在认领", running: "Codex 正在核验", done: "核验完成", conflict: "认领冲突", uncertain: "待核对", failed: "核验失败" };
export class IssueActionError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
function remote(item: IssueDetail): Remote {
  const { number, title, url, state, assignees, pulls } = item;
  return { number, title, url, state, assignees, pulls, syncedAt: Date.now() };
}

export function createIssueDispatch(tracker: IssueTracker, store: Checkpoint<Claim>, verify: VerifyIssue,
  log: (event: BusinessEvent) => boolean, maxActive: number, memberTrackers: ReadonlyMap<string, IssueTracker> = new Map()) {
  // 持久化工作台独占数据库。进程内的认领门位于首个异步查询之前，已启动工单永久按仓库与编号去重。
  const claims = new Map<number, Claim>();
  const abort = new AbortController();
  const jobs = new Set<Promise<void>>();
  let pending: { id: string; actor: string; task: Promise<void> } | undefined;
  let refreshing: Promise<void> | undefined;
  let candidates: Remote[] = [];
  const subject = (number: number) => `${tracker.repo}#${number}`;
  function save(c: Claim, event?: string) {
    if (!store.save(String(c.number), c, event ? { kind: "github.issue", subject: subject(c.number), details: {
      action: event, actor: c.claimedBy, githubAccount: c.account, phase: c.phase, session: c.sessionId,
    } } : undefined)) throw new IssueActionError(503, "无法保存 GitHub 工单状态。");
    claims.set(c.number, c);
  }
  for (const c of store.load()) {
    if (c.phase === "claiming" || c.phase === "running") save({ ...c, phase: "uncertain" }, "restart");
    else claims.set(c.number, c);
  }
  function snapshot(canClaim: boolean) {
    return { repo: tracker.repo, canClaim, items: [
      ...[...claims.values()].reverse().map(({ requestId: _id, account: _account, phase, ...item }) => ({ ...item, progress: phases[phase] })),
      ...candidates.filter(c => !claims.has(c.number)).map(c => ({ ...c, progress: "待认领" })),
    ] };
  }
  async function refresh() {
    const entries = [...claims.values()];
    const available = await tracker.candidates(new Set(claims.keys()));
    for (const prev of entries) {
      const observed = remote(await tracker.read(prev.number));
      const current = claims.get(prev.number);
      if (current && current.phase !== "claiming" && current.syncedAt <= prev.syncedAt) save({ ...current, ...observed });
    }
    candidates = available.map(c => ({ ...c, pulls: [], syncedAt: Date.now() }));
  }
  async function execute(c: Claim, item: IssueDetail) {
    const current = () => claims.get(c.number) ?? c;
    let report: string | undefined;
    try {
      report = await verify(item, id => save({ ...current(), sessionId: id }, "connected"), abort.signal);
      save({ ...current(), phase: "done", report }, "completed");
    } catch (error) {
      const uncertain = abort.signal.aborted || error instanceof IssueVerificationUncertain || report !== undefined;
      const stopped: Claim = { ...current(), ...(report === undefined ? {} : { report }), phase: uncertain ? "uncertain" : "failed" };
      try { save(stopped, uncertain ? "reconcile" : "failed"); }
      catch { claims.set(c.number, { ...stopped, phase: "uncertain" }); }
    }
  }
  async function acquire(id: string, actor: string) {
    const connection = memberTrackers.get(actor) ?? tracker;
    const account = await connection.account();
    const rows = await connection.candidates(new Set(claims.keys()));
    const next = rows.find(row => !claims.has(row.number));
    if (!next) throw new IssueActionError(409, "当前没有可领取的无人负责 Issue。");
    const issue = await connection.read(next.number);
    if (issue.state !== "OPEN" || issue.assignees.length) throw new IssueActionError(409, "Issue 已关闭或已有人负责，请刷新。");
    abort.signal.throwIfAborted();
    let c: Claim = { ...remote(issue), requestId: id, claimedBy: actor, account, phase: "claiming" };
    save(c, "reserved");
    try {
      await connection.assign(c.number, account);
      const observed = await connection.read(c.number);
      c = { ...c, ...remote(observed) };
      if (observed.state !== "OPEN" || observed.assignees.length !== 1 || observed.assignees[0]?.toLowerCase() !== account.toLowerCase()) {
        save({ ...c, phase: "conflict" }, "conflict");
        throw new IssueActionError(409, "回读负责人冲突或 Issue 已关闭，已停止派发。");
      }
      abort.signal.throwIfAborted();
      c = { ...c, phase: "running" };
      save(c, "dispatched");
      const job = execute(c, observed);
      jobs.add(job);
      void job.finally(() => jobs.delete(job));
    } catch (error) {
      if (claims.get(c.number)?.phase === "conflict") throw error;
      save({ ...c, phase: "uncertain" }, "reconcile");
      throw new IssueActionError(503, "认领结果待核对，请刷新 GitHub 状态。");
    }
  }
  function permits(actor: string) {
    return !memberTrackers.size || memberTrackers.has(actor);
  }
  return {
    snapshot, permits,
    refresh() {
      refreshing ??= refresh().finally(() => { refreshing = undefined; });
      return refreshing;
    },
    async claim(id: string, actor: string) {
      if (!permits(actor)) throw new IssueActionError(403, "这位成员还未连接 GitHub 执行账号。");
      function audit(action: string) {
        if (!log({ kind: "github.issue", details: { action, actor, requestId: id } })) throw new IssueActionError(503, "无法记录认领请求。");
      }
      const prior = pending?.id === id ? pending.actor : [...claims.values()].find(c => c.requestId === id)?.claimedBy;
      if (prior) {
        if (prior !== actor) {
          audit("conflict");
          throw new IssueActionError(409, "该请求属于另一位成员。");
        }
        audit("replay");
        return pending?.id === id ? pending.task : undefined;
      }
      if (pending || jobs.size >= maxActive) {
        audit("busy");
        throw new IssueActionError(409, pending ? "已有成员正在认领，请刷新工单。" : "执行中的 GitHub 工单达到并发上限。");
      }
      audit("request");
      const task = acquire(id, actor).finally(() => { pending = undefined; });
      pending = { id, actor, task };
      return task;
    },
    async close() {
      abort.abort();
      await Promise.allSettled([pending?.task, refreshing, ...jobs]);
    },
  };
}
