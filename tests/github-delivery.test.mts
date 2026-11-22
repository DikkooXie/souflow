import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { openActivityStore } from "../src/audit/activity-store.mts";
import { githubPull } from "../src/connections/github-delivery.mts";
import { type DeliveryTracker, issueRevision, type IssueDetail, type IssuePull } from "../src/connections/issue-tracker.mts";
import { qualitySources } from "../src/execution/codex-quality-review.mts";
import { checkoutReviewedIssueBase, type DeliveryFailure, IssueDeliveryFailed, IssueDeliverySourcesChanged, parseDeliveryPlan } from "../src/execution/issue-delivery.mts";
import { type Claim, createIssueDispatch } from "../src/workbench/issue-dispatch.mts";

const spec = { files: ["src/main.mts"], instructions: "修改校验逻辑。", dependsOn: [] };

test("GitHub 允许编辑的 TS 和 JS 文件使用固定提交的内容复核", async t => {
  const repo = await mkdtemp(join(tmpdir(), "souflow-quality-sources-"));
  t.after(() => rm(repo, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
  const paths = ["src/feature.ts", "tests/feature.js"];
  const code = `// ${"注释".repeat(1800)}\nexport const approved = true;\n`;
  git("init", "-q");
  await Promise.all(paths.map(async path => {
    await mkdir(join(repo, path.split("/")[0] ?? ""), { recursive: true });
    await writeFile(join(repo, path), code);
  }));
  git("add", "--", ...paths);
  git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--no-gpg-sign", "-qm", "fixture");
  await writeFile(join(repo, "src/feature.ts"), "未提交");
  assert.deepEqual(await qualitySources(repo, git("rev-parse", "HEAD"), paths, new AbortController().signal),
    Object.fromEntries(paths.map(path => [path, code])));
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
  await assert.rejects(checkoutReviewedIssueBase(runGit, { ...delivery, sourcePaths: ["src/upstream.mts"] },
    [prerequisite]), IssueDeliverySourcesChanged);
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

test("交付失败留存可用诊断，仅在原授权内重试一次", async t => {
  const hash = "a".repeat(64);
  const baseRevision = "b".repeat(40);
  const issue: IssueDetail = { number: 7, title: "修复回执", body: "保留批准范围。", url: "https://github.com/a/b/issues/7",
    state: "OPEN", assignees: ["member"], pulls: [] };
  const first: Claim = { ...issue, syncedAt: 0, requestId: "approval", claimedBy: "member", account: "member",
    phase: "waiting", delivery: { ...spec, baseRevision }, approval: { flowId: "flow", planId: "plan", version: 1,
      issueRevision: issueRevision(issue), quality: { policy: 1, flowDigest: hash, batchDigest: hash } } };

  for (const scenario of ["normal", "legacy", "scope", "reassigned", "changed", "linked", "published", "unconfigured"] as const) {
    await t.test(scenario, async sub => {
      const directory = await mkdtemp(join(tmpdir(), "souflow-delivery-retry-"));
      sub.after(() => rm(directory, { recursive: true, force: true }));
      const path = join(directory, "audit.sqlite");
      let stored = structuredClone(first);
      if (scenario !== "normal" && scenario !== "scope") stored.phase = "deliveryFailed";
      if (scenario === "published") stored.target = { branch: "feat/7-existing", head: baseRevision };
      const seed = openActivityStore(path);
      assert.ok(seed.checkpoint<Claim>("github-issues:a/b").save("7", stored));
      seed.close();
      const observed = structuredClone(issue);
      if (scenario === "reassigned") observed.assignees = ["another"];
      if (scenario === "changed") observed.body = "工单被重新编辑。";
      if (scenario === "linked") observed.pulls = [{ number: 8, state: "OPEN", url: "https://github.com/a/b/pull/8" }];
      let retries = 0;
      const attempts: (DeliveryFailure | undefined)[] = [];
      let published = 0;
      const tracker: DeliveryTracker = {
        repo: "a/b", candidates: async () => [], read: async () => structuredClone(observed), account: async () => "member",
        assign: async () => assert.fail("不能再次改动 GitHub 负责人"),
        delivery: {
          checkout: async () => assert.fail("调度测试不需要真实工作区"), find: async () => undefined,
          publish: async () => { published++; return { number: 9, state: "OPEN", url: "https://github.com/a/b/pull/9" }; },
        },
      };
      const run = async () => {
        const audit = openActivityStore(path);
        const checkpoint = audit.checkpoint<Claim>("github-issues:a/b");
        const dispatch = createIssueDispatch(tracker, checkpoint, async () => assert.fail("不能改走另一类派发"),
          audit.record, 1, new Map([["member", tracker]]), {
            specs: new Map(), conversation: true, requireQuality: true, pollMs: 60_000,
            ...(scenario !== "unconfigured" ? { recoverFailedIssue: 7 } : {}),
            async prepare(input) {
              attempts.push(input.previousFailure);
              assert.deepEqual(input.spec, first.delivery);
              if (scenario !== "legacy") throw new IssueDeliveryFailed({ stage: "patch", reason: scenario === "scope" ? "scope" : "match" });
              return { workspace: "fixture", branch: input.branch, base: baseRevision, head: "c".repeat(40) };
            },
          });
        try {
          for (let i = 0; i < 3; i++) {
            await dispatch.refresh();
            await setImmediate();
          }
        } finally {
          await dispatch.close();
          const [current] = checkpoint.load();
          assert.ok(current);
          stored = current;
          retries = audit.report(1).recent.filter(event => (event.details as { action?: string } | null)?.action === "retry-queued").length;
          audit.close();
        }
      };
      await run();
      await run();
      assert.deepEqual(attempts, scenario === "normal" ? [undefined, { stage: "patch", reason: "match" }]
        : scenario === "legacy" ? [{ stage: "legacy", reason: "unavailable" }] : scenario === "scope" ? [undefined] : []);
      assert.equal(published, scenario === "legacy" ? 1 : 0);
      if (scenario === "normal") assert.deepEqual(stored.failure, { stage: "patch", reason: "match" });
      assert.equal(retries, ["normal", "legacy", "reassigned", "changed", "linked"].includes(scenario) ? 1 : 0);
    });
  }
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
