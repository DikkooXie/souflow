import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createCodexAccountDispatch, type AccountAssignment } from "../src/execution/codex-account-dispatch.mts";
import { codexAllowance, codexIdentity } from "../src/execution/codex-account-status.mts";
import { startCodexReadOnlyTask } from "../src/execution/codex-command-attempt.mts";

const profiles = [
  { label: "primary", directory: "/fixture/primary", concurrency: 2 },
  { label: "secondary", directory: "/fixture/secondary", concurrency: 1 },
];
const signal = new AbortController().signal;

test("优先考虑负载、已知额度和套餐，并允许同账号同时执行两张工单", async () => {
  const assigned: AccountAssignment[] = [];
  const directories: (string | undefined)[] = [];
  let release!: () => void;
  let allStarted!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { allStarted = resolve; });
  let reads = 0;
  const pool = createCodexAccountDispatch(profiles, ".", { probe: async directory => {
    reads++;
    return { ref: directory, plan: directory.endsWith("primary") ? "pro" : "plus", remaining: 90 };
  } });
  const tasks = [1, 2, 3].map(() => pool.run(signal, row => assigned.push(row), async ({ account }) => {
    directories.push(account?.directory);
    if (directories.length === 3) allStarted();
    await waiting;
  }));
  try {
    await started;
    assert.equal(reads, 2);
    assert.deepEqual(assigned.map(row => [row.label, row.active, row.capacity]), [
      ["primary", 0, 2], ["secondary", 0, 1], ["primary", 1, 2],
    ]);
    assert.match(assigned[0]?.reason ?? "", /订阅/);
    assert.match(assigned[1]?.reason ?? "", /负载/);
    assert.deepEqual(directories, ["/fixture/primary", "/fixture/secondary", "/fixture/primary"]);
  } finally {
    release();
    await Promise.all(tasks);
  }
});

test("跳过后端明确限流或重复登录的档案，下一张工单避开刚触发限流的账号", async () => {
  const pool = createCodexAccountDispatch(profiles, ".", { probe: async directory => (
    directory.endsWith("primary") ? { ref: "one", remaining: 90 } : { ref: "two" }
  ) });
  const rows: AccountAssignment[] = [];
  await pool.run(signal, row => rows.push(row), async ({ account }) => { account?.onLimited(); });
  await pool.run(signal, row => rows.push(row), async () => {});
  assert.deepEqual(rows.map(row => [row.label, row.remaining]), [["primary", 90], ["secondary", undefined]]);
  assert.match(rows[0]?.reason ?? "", /额度/);

  const duplicate = createCodexAccountDispatch(profiles, ".", { waitMs: 10, probe: async () => ({ ref: "one", limited: true }) });
  await assert.rejects(duplicate.run(signal, () => assert.fail("已限流账号不能被选择"), async () => {}), /暂不可用/);
  const aliased = createCodexAccountDispatch(profiles, ".", { probe: async () => ({ ref: "same-user" }) });
  await aliased.run(signal, row => {
    assert.equal(row.label, "primary");
    assert.match(row.reason, /唯一/);
  }, async () => {});
});

test("取消等待和执行失败释放账号路径上的并发限制", async () => {
  const one = [{ label: "primary", directory: "/fixture/primary", concurrency: 1 }];
  const pool = createCodexAccountDispatch(one, ".", { probe: async () => ({ ref: "one" }) });
  let release!: () => void;
  let leased!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { leased = resolve; });
  const task = pool.run(signal, leased, async () => { await gate; throw Error("失败"); });
  const failed = assert.rejects(task, /失败/);
  await started;
  const cancelled = new AbortController();
  const next = pool.run(cancelled.signal, () => assert.fail("满载不可预留"), async () => {});
  cancelled.abort();
  await assert.rejects(next, { name: "AbortError" });
  release();
  await failed;
  await pool.run(signal, row => assert.equal(row.active, 0), async () => {});
});

test("只公开账号标记和套餐，额度选用 Codex 窗口中最小的余量", () => {
  const identity = codexIdentity({ account: { type: "chatgpt", email: "private@example.invalid", planType: "plus" }, userId: "private-id" });
  assert.match(identity?.ref ?? "", /^[a-f0-9]{24}$/);
  assert.deepEqual(Object.keys(identity ?? {}), ["ref", "plan"]);
  assert.equal(codexIdentity({ account: { type: "apiKey" }, userId: "private-id" }), undefined);
  const rateLimits = { limitId: "codex", primary: { usedPercent: 12 }, secondary: { usedPercent: 31 } };
  assert.deepEqual(codexAllowance({ rateLimits }), { remaining: 69 });
  assert.deepEqual(codexAllowance({ rateLimits, ordinaryUsageAllowed: true }), { remaining: 69, limited: false });
  assert.deepEqual(codexAllowance({ rateLimits, ordinaryUsageAllowed: false }), { remaining: 69, limited: true });
  assert.deepEqual(codexAllowance({ rateLimits: { limitId: "unrelated", primary: { usedPercent: 100 } } }), {});
  assert.deepEqual(codexAllowance({ rateLimitsByLimitId: { codex: { primary: { usedPercent: 100 } } } }), { remaining: 0, limited: true });
});

test("冷却后等待明确的普通用量许可，未知用量不清除历史限流", async () => {
  let clock = 1000;
  let usage: boolean | null = true;
  const pool = createCodexAccountDispatch(profiles, ".", {
    now: () => clock, refreshMs: 5, cooldownMs: 10,
    probe: async directory => directory.endsWith("primary")
      ? { ref: "primary", ...codexAllowance({ordinaryUsageAllowed: usage, rateLimits: { primary: { usedPercent: 10 } }}) }
      : { ref: "secondary", remaining: 40 },
  });
  const selected: string[] = [];
  const record = (row: AccountAssignment) => selected.push(row.label);
  await pool.run(signal, record, async ({ account }) => { account?.onLimited(); });
  clock += 20;
  usage = null;
  await pool.run(signal, record, async () => {});
  clock += 10;
  usage = true;
  await pool.run(signal, record, async () => {});
  assert.deepEqual(selected, ["primary", "secondary", "primary"]);
});

test("执行进程先核对账户，身份不同时不发送工单", async t => {
  const workspace = await mkdtemp(join(tmpdir(), "souflow-account-guard-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const fixture = fileURLToPath(new URL("./fixtures/codex-app-server.mjs", import.meta.url));
  let connected = false;
  const attempt = startCodexReadOnlyTask({
    workspace, prompt: "身份核对前不得投递这段文字。",
    account: { directory: workspace, expectedRef: "different-account", onLimited() {} },
    command: [process.execPath, fixture, "question-account-primary"],
    onEvent() {}, onThread() { connected = true; },
  });
  t.after(attempt.close);
  assert.equal(await attempt.finished, "failed");
  assert.equal(connected, false);
});
