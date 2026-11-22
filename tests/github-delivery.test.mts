import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { githubPull } from "../src/connections/github-delivery.mts";
import type { DeliveryTracker, IssueDetail, IssuePull } from "../src/connections/issue-tracker.mts";
import { qualitySources } from "../src/execution/codex-quality-review.mts";
import { checkoutReviewedIssueBase, IssueDeliverySourcesChanged, parseDeliveryPlan } from "../src/execution/issue-delivery.mts";
import { type Claim, createIssueDispatch } from "../src/workbench/issue-dispatch.mts";

const spec = { files: ["src/main.mts"], instructions: "修改校验逻辑。", dependsOn: [] };

test("GitHub 允许编辑的 TS 和 JS 文件使用固定提交的内容复核", async t => {
  const repo = await mkdtemp(join(tmpdir(), "souflow-quality-sources-"));
  t.after(() => rm(repo, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
  const paths = ["src/feature.ts", "tests/feature.js"];
  git("init", "-q");
  await Promise.all(paths.map(async path => {
    await mkdir(join(repo, path.split("/")[0] ?? ""), { recursive: true });
    await writeFile(join(repo, path), "export const approved = true;\n");
  }));
  git("add", "--", ...paths);
  git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--no-gpg-sign", "-qm", "fixture");
  await writeFile(join(repo, "src/feature.ts"), "未提交");
  assert.deepEqual(await qualitySources(repo, git("rev-parse", "HEAD"), paths, new AbortController().signal),
    Object.fromEntries(paths.map(path => [path, "export const approved = true;\n"])));
});

test("派发只使用已校验基线或声明的前置合并，拒绝其间变更的已审查文件", async t => {
  const repo = await mkdtemp(join(tmpdir(), "souflow-issue-base-"));
  t.after(() => rm(repo, { recursive: true, force: true }));
  const git = (args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const commit = async (path: string, text: string) => {
    await writeFile(join(repo, path), text);
    git(["add", "--", path]);
    git(["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--no-gpg-sign", "-qm", text]);
    return git(["rev-parse", "HEAD"]);
  };
  git(["init", "-q"]);
  await mkdir(join(repo, "src"));
  const approved = await commit("src/main.mts", "已审查的文件");
  const prerequisite = await commit("src/upstream.mts", "指定的前置产物");
  const pushedAfter = await commit("src/main.mts", "未经审查的源码");
  const delivery = { ...spec, baseRevision: approved };
  const runGit = async (args: string[]) => git(args);
  await checkoutReviewedIssueBase(runGit, delivery, []);
  assert.equal(git(["rev-parse", "HEAD"]), approved);
  git(["switch", "--detach", pushedAfter]);
  await checkoutReviewedIssueBase(runGit, delivery, [prerequisite]);
  assert.equal(git(["rev-parse", "HEAD"]), prerequisite);
  git(["switch", "--detach", pushedAfter]);
  await assert.rejects(checkoutReviewedIssueBase(runGit, delivery, [pushedAfter]), IssueDeliverySourcesChanged);
});

test("拒绝任何越出已批准源码的路径以及缺失、循环或重复的依赖", () => {
  const parse = (child: object = spec) => parseDeliveryPlan(JSON.stringify({ 1: spec, 2: child }));
  assert.deepEqual(parse({ ...spec, dependsOn: [1] }).get(2)?.dependsOn, [1]);
  for (const bad of [{ files: ["src/../.env"] }, { files: [".github/workflows/check.yml"] },
    { dependsOn: [2] }, { dependsOn: [3] }, { dependsOn: [1, 1] }]) {
    assert.throws(() => parse({ ...spec, ...bad }), /工单计划/);
  }
});

test("只展示 PR 当前提交的 CI，合并 SHA 独立记录", () => {
  const commit = { oid: "old", statusCheckRollup: { state: "SUCCESS" } };
  const pull = { number: 42, state: "MERGED", isDraft: false, headRefOid: "current", mergeCommit: { oid: "merged" },
    commits: { nodes: [{ commit }] } };
  assert.equal(githubPull("a/b", pull).ci, "NONE");
  commit.oid = "current";
  assert.equal(githubPull("a/b", pull).ci, "SUCCESS");
  assert.equal(githubPull("a/b", pull).mergeCommit, "merged");
});

test("开 PR 回执丢失后只做回读，指定 PR 关闭重开并合并后才唤醒一次", async () => {
  const specs = parseDeliveryPlan(JSON.stringify({ 1: spec, 2: { ...spec, dependsOn: [1] } }));
  const rows: IssueDetail[] = [1, 2, 3].map(number => ({
    number, title: `Issue ${number}`, url: `https://github.com/a/b/issues/${number}`, state: "OPEN",
    assignees: [], body: "外部正文不进入开发配置", pulls: [],
  }));
  const item = (number: number) => {
    const found = rows.find(row => row.number === number);
    assert.ok(found);
    return found;
  };
  const records = new Map<string, Claim>();
  const steps: { number: number; upstream: string[] }[] = [];
  const pulls = new Map<string, IssuePull>();
  let pushes = 0;
  const tracker: DeliveryTracker = {
    repo: "a/b",
    candidates: async () => rows.filter(row => !row.assignees.length),
    read: async number => structuredClone(item(number)),
    account: async () => "member",
    assign: async (number, login) => { item(number).assignees = [login]; },
    delivery: {
      checkout: async () => { throw Error("仅验证调度。"); },
      find: async branch => structuredClone(pulls.get(branch)),
      publish: async ({ branch, issue }) => {
        pushes++;
        const pull = { number: issue + 100, url: `https://github.com/a/b/pull/${issue + 100}`, state: "OPEN", ci: "SUCCESS" };
        pulls.set(branch, pull);
        if (issue === 1) throw Error("GitHub 回执丢失。");
        return pull;
      },
    },
  };
  const store = { load: () => [...records.values()], save(id: string, row: Claim) { records.set(id, structuredClone(row)); return true; } };
  const open = (activeSpecs = specs) => createIssueDispatch(tracker, store, async () => assert.fail("交付计划不能进入核验分支。"), () => true, 2,
    new Map([["member", tracker]]), {
      specs: activeSpecs, pollMs: 60_000, async prepare({ number, branch, upstream }, connected, _signal, assigned) {
        steps.push({ number, upstream });
        assigned?.({ label: number === 1 ? "primary" : "secondary", active: 0, capacity: 1, reason: "测试账号" });
        connected(`session-${number}`);
        return { workspace: "fixture", branch, base: "main", head: "a".repeat(40) };
      },
    });
  let first = open();
  try {
    await first.claim("a", "member");
    await first.claim("b", "member");
    await setImmediate();
    assert.equal(records.get("1")?.phase, "uncertain");
    assert.equal(records.get("1")?.accountAssignment?.label, "primary");
    assert.equal(records.get("2")?.phase, "waiting");
    await assert.rejects(first.claim("c", "member"), /没有可领取/);
  } finally { await first.close(); }

  const waiting = records.get("2");
  assert.ok(waiting);
  for (const activeSpecs of [new Map([[1, spec]]), parseDeliveryPlan(JSON.stringify({
    1: spec, 2: { ...spec, files: ["tests/only.mts"], dependsOn: [1] },
  })), parseDeliveryPlan(JSON.stringify({ 1: spec, 2: spec }))]) {
    const restarted = open(activeSpecs);
    try {
      await restarted.refresh();
      assert.equal(records.get("2")?.phase, "uncertain");
      assert.equal(steps.length, 1);
    } finally { await restarted.close(); }
    records.set("2", waiting);
  }

  first = open();
  try {
    item(1).pulls = [{ number: 999, url: "https://github.com/a/b/pull/999", state: "MERGED", mergeCommit: "b".repeat(40) }];
    await first.refresh();
    assert.equal(records.get("1")?.phase, "submitted");
    assert.equal(records.get("2")?.phase, "waiting");
    const target = records.get("1")?.target;
    assert.ok(target);
    const pull = pulls.get(target.branch);
    assert.ok(pull);
    for (const state of ["CLOSED", "OPEN"]) {
      pull.state = state;
      await first.refresh();
      assert.equal(records.get("1")?.pull?.state, state);
      assert.equal(records.get("2")?.phase, "waiting");
      assert.equal(steps.length, 1);
    }
    const mergeCommit = "c".repeat(40);
    Object.assign(pull, { state: "MERGED", mergeCommit });
    await Promise.all([first.refresh(), first.refresh()]);
    await setImmediate();
    await first.refresh();
    assert.equal(records.get("2")?.phase, "submitted");
    const items = new Map(first.snapshot(false).items.map(item => [item.number, item]));
    const firstItem = items.get(1);
    const nextItem = items.get(2);
    assert.ok(firstItem && "accountAssignment" in firstItem && firstItem.accountAssignment);
    assert.ok(nextItem && "accountAssignment" in nextItem && nextItem.accountAssignment);
    assert.partialDeepStrictEqual(firstItem.accountAssignment, { label: "primary" });
    assert.partialDeepStrictEqual(nextItem.accountAssignment, { label: "secondary" });
    assert.deepEqual(steps, [{ number: 1, upstream: [] }, { number: 2, upstream: [mergeCommit] }]);
    assert.equal(pushes, 2);
  } finally { await first.close(); }
});
