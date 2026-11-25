import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { openActivityStore } from "../src/audit/activity-store.mts";
import { createGitHubDelivery, githubPull } from "../src/connections/github-delivery.mts";
import { type DeliveryTracker, issueRevision, type IssueDetail, type IssuePull } from "../src/connections/issue-tracker.mts";
import { qualitySources } from "../src/execution/codex-quality-review.mts";
import { checkoutReviewedIssueBase, type DeliveryFailure, isolatedCheckFailed, IssueDeliveryFailed, IssueDeliverySourcesChanged, parseDeliveryPlan,
  passingAcceptanceTests } from "../src/execution/issue-delivery.mts";
import { type Claim, createIssueDispatch } from "../src/workbench/issue-dispatch.mts";
import { createPlannedIssuePublication, type IssuePublication } from "../src/workbench/planned-issue-publication.mts";
import { repairFromReceipt } from "../src/workbench/delivery-review-repair.mts";

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

test("只接受直接上游合并改变的只读资料并固定实际 Git 对象", async t => {
  const repo = await mkdtemp(join(tmpdir(), "souflow-handoff-"));
  t.after(() => rm(repo, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, "-c", "user.name=Test",
    "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", ...args],
  { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const runGit = async (args: string[]) => git(...args);
  const source = "src/upstream.mts";
  const main = "src/main.mts";
  const change = async (path: string, value: string) => {
    await writeFile(join(repo, path), value);
    git("add", "--", path);
    git("commit", "-qm", value);
    return git("rev-parse", "HEAD");
  };
  git("init", "-q", "--initial-branch=main");
  await mkdir(join(repo, "src"));
  await change(main, "approved edit");
  const original = await change(source, "original source");
  const delivery = { ...spec, baseRevision: original, dependsOn: [1], sourcePaths: [source], sourceFrom: [{ path: source, issue: 1 }] };
  for (const mode of ["--no-ff", "--squash"]) {
    git("switch", "-C", "main", original);
    git("switch", "-C", "feat/upstream", original);
    const head = await change(source, "merged source");
    git("switch", "main");
    git("merge", mode, "--no-edit", "feat/upstream");
    if (mode === "--squash") git("commit", "-qm", "squash");
    const merge = git("rev-parse", "HEAD");
    const latest = await change(main, "unrelated later change");
    const producer = { issue: 1, pull: 10, head, merge, baseName: "main", files: [source], sources: [source] };
    const result = await checkoutReviewedIssueBase(runGit, delivery, [merge], async () => [producer]);
    assert.deepEqual(result?.producers, [producer]);
    assert.equal(result?.execution, merge);
    assert.equal(result?.blobs.find(blob => blob.path === source)?.sha, git("rev-parse", `${merge}:${source}`));
    assert.equal(git("rev-parse", "HEAD"), merge);
    git("switch", "--detach", latest);
    await assert.rejects(checkoutReviewedIssueBase(runGit, delivery, [latest], async () => [producer]), IssueDeliverySourcesChanged);
    git("switch", "-C", "main", original);
    await change(source, "unrelated earlier change");
    const later = await change(source, "merged source");
    await assert.rejects(checkoutReviewedIssueBase(runGit, delivery, [later],
      async () => [{ ...producer, merge: later }]), IssueDeliverySourcesChanged);
  }
  git("switch", "-C", "main", original);
  await writeFile(join(repo, main), "out of scope in the same merge");
  git("add", "--", main);
  const merge = await change(source, "merged and unapproved");
  await assert.rejects(checkoutReviewedIssueBase(runGit, delivery, [merge],
    async () => [{ issue: 1, pull: 10, head: original, merge, baseName: "main", files: [source], sources: [source] }]), IssueDeliverySourcesChanged);
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

test("同一个 PR 合并后仍能复核合并前的差异", async t => {
  const workspace = await mkdtemp(join(tmpdir(), "souflow-pr-comparison-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync("git", ["-C", workspace, "-c", "user.name=Test", "-c", "user.email=test@example.invalid",
    "-c", "commit.gpgsign=false", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-q", "--template=", "--initial-branch=main");
  await writeFile(join(workspace, "file.txt"), "开始\n");
  git("add", "file.txt");
  git("commit", "-qm", "baseline");
  const initial = git("rev-parse", "HEAD");
  git("switch", "-qc", "feat/review");
  await writeFile(join(workspace, "file.txt"), "本批交付\n");
  git("commit", "-qam", "implement feature");
  const head = git("rev-parse", "HEAD");
  git("update-ref", "refs/pull/2/head", head);
  git("switch", "-q", "main");
  await writeFile(join(workspace, "unrelated.txt"), "独立改动\n");
  git("add", "unrelated.txt");
  git("commit", "-qm", "advance target branch");
  let base = git("rev-parse", "HEAD");
  let merge: string | null = null;
  const repo = "example/repo";
  const publisher = createGitHubDelivery(repo, async ([endpoint]) => {
    assert.equal(endpoint, `repos/${repo}/pulls/2`);
    return JSON.stringify({ head: { sha: head, repo: { full_name: repo } }, base: { sha: base, repo: { full_name: repo } },
      merged: merge !== null, merge_commit_sha: merge });
  }, async () => ({ ...process.env, GIT_CONFIG_COUNT: "2", GIT_CONFIG_KEY_0: `url.${pathToFileURL(workspace)}.insteadOf`,
    GIT_CONFIG_VALUE_0: `https://github.com/${repo}.git`, GIT_CONFIG_KEY_1: "protocol.file.allow", GIT_CONFIG_VALUE_1: "always" }));
  const pull = { number: 2, state: "OPEN", head, url: `https://github.com/${repo}/pull/2` };
  assert.ok(publisher.reviewChanges);
  const signal = AbortSignal.timeout(10_000);
  const before = await publisher.reviewChanges(pull, signal);
  assert.equal(before.mergeBase, initial);
  assert.deepEqual(before.files.map(file => file.path), ["file.txt"]);
  git("merge", "--no-ff", "--no-edit", "feat/review");
  merge = git("rev-parse", "HEAD");
  git("commit", "--allow-empty", "-qm", "advance after merge");
  base = git("rev-parse", "HEAD");
  await assert.rejects(publisher.reviewChanges(pull, signal), /PR 提交或关联仓库已变化/);
  assert.deepEqual(await publisher.reviewChanges({ ...pull, state: "MERGED", mergeCommit: merge }, signal), before);
});

test("实际通过的验收测试回执去重，排除跳过的用例和汇总行", async t => {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const output = execFileSync(process.execPath, ["--test-reporter=tap", "--input-type=module", "-e", `
    import { describe, it, test } from "node:test";
    test("[AC-1] 撤销后重连被拒绝", () => {});
    test("[AC-1] 撤销后重连被拒绝", () => {});
    test.skip("[AC-2] 同一工单只创建一次", () => {});
    test.todo("[AC-3] 返回版本");
    test("普通测试", () => {});
    describe("[AC-4] 套件没有通过的子用例", () => {
      it.skip("[AC-5] 未验证的子用例", () => {});
    });
    describe("[AC-6] 套件名不能给无关用例赋予编号", () => {
      describe("嵌套套件", () => {
        it("[AC-7] 嵌套验收检查已通过", () => {});
        it("无关用例", () => {});
      });
    });
    test("[AC-8] 父测试没有通过的子用例", async t => {
      await t.test("跳过的子用例", { skip: true }, () => {});
    });
  `], { encoding: "utf8", env });
  assert.match(output, /ok \d+ - \[AC-4\] 套件没有通过的子用例/);
  assert.match(output, /ok \d+ - \[AC-8\] 父测试没有通过的子用例/);
  assert.deepEqual(passingAcceptanceTests(output), ["[AC-1] 撤销后重连被拒绝", "[AC-7] 嵌套验收检查已通过"]);
  const directory = await mkdtemp(join(tmpdir(), "souflow-test-receipt-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const empty = join(directory, "AC-9-empty.test.mjs");
  await writeFile(empty, "export const noTests = true;");
  const fileSummary = execFileSync(process.execPath, ["--test", "--test-reporter=tap", empty], { encoding: "utf8", env });
  assert.match(fileSummary, /ok \d+ - .*AC-9-empty\.test\.mjs/);
  assert.deepEqual(passingAcceptanceTests(fileSummary), []);
});

test("交付复核按当前头和工单版本保存，旧提交回执保留为历史", async () => {
  const originalHead = "a".repeat(40);
  const nextHead = "b".repeat(40);
  const hash = "c".repeat(64);
  const mergeBase = "d".repeat(40);
  const quality = { policy: 1, flowDigest: hash, batchDigest: hash };
  const initialPull: IssuePull = { number: 53, url: "https://github.com/a/b/pull/53", state: "OPEN", head: originalHead, baseName: "main" };
  const issue: IssueDetail = { number: 47, title: "核对重连", body: "保存重连状态", url: "https://github.com/a/b/issues/47",
    state: "OPEN", assignees: ["member"], pulls: [initialPull] };
  let remotePull = initialPull;
  let body = issue.body;
  let linked = true;
  let scopeCurrent = true;
  let networkFailure = false;
  let stored: Claim = { ...issue, pull: initialPull, target: { branch: "feat/47-123456789abc", head: originalHead },
    requestId: "approved", claimedBy: "member", account: "member", phase: "submitted", syncedAt: 0,
    approval: { flowId: "flow", planId: "plan", version: 1, issueRevision: issueRevision(issue), quality } };
  const tracker: DeliveryTracker = {
    repo: "a/b", candidates: async () => [], account: async () => "member", assign: async () => assert.fail(),
    read: async () => ({ ...issue, body, pulls: linked ? [remotePull] : [] }),
    delivery: { checkout: async () => assert.fail(), publish: async () => assert.fail(), find: async () => remotePull,
      reviewChanges: async () => assert.fail("测试只替换复核器") },
  };
  const seen: string[] = [];
  const open = () => createIssueDispatch(tracker, { load: () => [stored], save(_id, item) { stored = structuredClone(item); return true; } },
    async () => assert.fail(), () => true, 1, new Map(), {
      specs: new Map(), conversation: true, pollMs: 60_000, prepare: async () => assert.fail(),
      reviewScopeCurrent: () => scopeCurrent,
      async review(claim) {
        const head = claim.pull?.head;
        assert.ok(head);
        seen.push(head);
        if (networkFailure) throw Error("临时网络失败");
        return { packetId: head, key: { repo: tracker.repo, issue: issue.number, issueRevision: issueRevision(issue), pull: initialPull.number,
          head, mergeBase, plan: { id: "plan", version: 1, quality } }, ...(head === originalHead ? {
          status: "block" as const, implementation: { status: "block" as const, summary: "缺少失败测试", evidence: [] },
          requirements: { criteria: [] },
        } : { status: "incomplete" as const }) };
      },
    });
  const run = async (service: ReturnType<typeof open>) => {
    await service.refresh();
    await setImmediate();
    assert.deepEqual(service.reviewStatus("flow", "other"), []);
    return service.reviewStatus("flow", "member")[0];
  };
  const first = open();
  try { assert.deepEqual((await run(first))?.reviews.map(item => [item.status, item.current]), [["block", true]]); }
  finally { await first.close(); }
  const restored = open();
  try {
    await run(restored);
    assert.deepEqual(seen, [originalHead]);
    scopeCurrent = false;
    assert.equal(restored.reviewStatus("flow", "member")[0]?.reviews[0]?.current, false);
    scopeCurrent = true;
    linked = false;
    assert.equal((await run(restored))?.reviews[0]?.current, false);
    linked = true;
    remotePull = { ...initialPull, head: nextHead };
    networkFailure = true;
    assert.equal((await run(restored))?.unavailable, true);
    networkFailure = false;
    assert.deepEqual((await run(restored))?.reviews.map(item => [item.status, item.current]), [["block", false], ["incomplete", true]]);
    body = "已经修改过的工单";
    const updated = await run(restored);
    assert.equal(updated?.unavailable, true);
    assert.equal(updated?.reviews.some(item => item.current), false);
    assert.deepEqual(seen, [originalHead, nextHead, nextHead]);
  } finally { await restored.close(); }
});

test("超长复核阻塞保留完整结论，禁止只授权部分修复", () => {
  const head = "a".repeat(40);
  const hash = "b".repeat(64);
  const quality = { policy: 1, flowDigest: hash, batchDigest: hash };
  const pull: IssuePull = { number: 53, url: "https://github.com/a/b/pull/53", state: "OPEN", head, baseName: "main" };
  const issue: IssueDetail = { number: 47, url: "https://github.com/a/b/issues/47", title: "交付", body: "检查所有验收",
    assignees: ["member"], pulls: [pull], state: "OPEN" };
  const revision = issueRevision(issue);
  const claim: Claim = { ...issue, pull, requestId: "approved", claimedBy: "member", account: "member", phase: "submitted", syncedAt: 0,
    target: { branch: "feat/47-original", head }, delivery: { ...spec, baseRevision: head },
    approval: { flowId: "flow", planId: "plan", version: 1, issueRevision: revision, quality } };
  const finding = { status: "block" as const, summary: "独立阻塞".repeat(120), evidence: [] };
  const result = repairFromReceipt("a/b", claim, {
    packetId: hash, key: { repo: "a/b", issue: 47, issueRevision: revision, pull: 53, head,
      mergeBase: head, plan: { id: "plan", version: 1, quality } },
    status: "block", implementation: finding,
    requirements: { criteria: Array.from({ length: 10 }, (_, index) => ({ ...finding, criterion: `AC-${index + 1}` })) },
  });
  assert.deepEqual(result, { reason: "复核问题超过单次续修的内容限制。请核对完整复核记录。" });
});

test("批准关联修复后安全回读建单结果，只续修同一 PR 并复核最新提交", async () => {
  const head = "a".repeat(40);
  const revised = "b".repeat(40);
  const mergeBase = "c".repeat(40);
  const hash = "d".repeat(64);
  const quality = { policy: 1, flowDigest: hash, batchDigest: hash };
  let pull: IssuePull = { number: 53, url: "https://github.com/a/b/pull/53", state: "OPEN", head, baseName: "main" };
  const original: IssueDetail = { number: 47, url: "https://github.com/a/b/issues/47", state: "OPEN", title: "重连时保存审计",
    body: "两次存储失败后只产生一条审计。", assignees: ["member"], pulls: [pull] };
  const revision = issueRevision(original);
  const writes: string[] = [];
  let accountReads = 0;
  let publishedRepair: IssueDetail | undefined;
  const rows = new Map<string, IssuePublication>();
  let stored: Claim = { ...original, pull, requestId: "approved", claimedBy: "member", account: "member", phase: "submitted", syncedAt: 0,
    target: { branch: "feat/47-original", head, base: "main" }, delivery: { ...spec, baseRevision: mergeBase },
    approval: { flowId: "flow", planId: "plan", version: 1, issueRevision: revision, quality } };
  const tracker: DeliveryTracker = {
    repo: "a/b", candidates: async () => [],
    async account() { return ++accountReads === 2 ? "other-account" : "member"; },
    assign: async () => assert.fail("续修沿用原工单和原 PR"),
    async read(number) {
      if (number === original.number) return { ...original, pulls: [pull] };
      assert.equal(number, publishedRepair?.number);
      assert.ok(publishedRepair);
      return publishedRepair;
    },
    creation: {
      async create({ title, body }, account) {
        assert.equal(account, "member");
        writes.push("创建修复单");
        publishedRepair = { number: 66, url: "https://github.com/a/b/issues/66", title, body, state: "OPEN", assignees: [], pulls: [] };
        throw Error("GitHub 建单后响应断开。");
      },
      async findCreated(marker) { return publishedRepair?.body.split("\n").includes(marker) ? [publishedRepair.number] : []; },
    },
    delivery: {
      checkout: async () => assert.fail(), publish: async () => assert.fail("不得创建新 PR"),
      checkoutPublished: async () => assert.fail("测试使用固定工作区"),
      find: async () => pull, reviewChanges: async () => assert.fail("测试使用已核对的复核回执"),
      async updatePublished({ from, head: proposed, pull: number }) {
        assert.equal(from, head);
        assert.equal(number, 53);
        writes.push("更新原 PR");
        pull = { ...pull, head: proposed };
        return pull;
      },
    },
  };
  const reviewed: string[] = [];
  const open = () => createIssueDispatch(tracker, { load: () => [stored], save(_key, value) { stored = structuredClone(value); return true; } },
    async () => assert.fail(), () => true, 1, new Map([["member", tracker]]), {
      specs: new Map(), conversation: true, pollMs: 60_000,
      publishRepair: createPlannedIssuePublication({ load: () => [...rows.values()], save(key, value) { rows.set(key, value); return true; } }),
      async prepare({ reviewTarget, spec: fix, number, branch }) {
        assert.deepEqual(reviewTarget, { branch: "feat/47-original", head, base: "main" });
        assert.equal(number, 47);
        assert.deepEqual(fix.files, spec.files);
        assert.match(fix.instructions, /两次数据库写入失败/);
        assert.equal(stored.reviewRepairs?.[0]?.issue, 66);
        writes.push("开发并测试");
        return { workspace: "fixture", branch, base: "main", head: revised, checked: { head: revised, passingTests: ["[AC-1] 只记一条"] } };
      },
      async review(claim) {
        const current = claim.pull?.head;
        assert.ok(current);
        reviewed.push(current);
        const blocked = current === head;
        return {
          packetId: hash, key: { repo: "a/b", issue: 47, issueRevision: revision, pull: 53, head: current,
            mergeBase, plan: { id: "plan", version: 1, quality } }, status: blocked ? "block" : "pass",
          implementation: { status: blocked ? "block" : "pass", summary: "核对连续两次数据库写入失败", evidence: [] },
          requirements: { criteria: [] },
        };
      },
    });
  const first = open();
  try {
    await first.refresh();
    await setImmediate();
    const card = first.repairCards("member")[0];
    assert.ok(card);
    assert.match(card.prompt, /原工单 #47 · 原 PR #53/);
    assert.match(card.prompt, /允许修改 src\/main.mts/);
    assert.deepEqual(first.repairCards("other"), []);
    const answer = { authorization: "授权创建修复 Issue 并续修" };
    assert.equal(first.answerRepair(card.id, "other", answer), 409);
    assert.equal(first.answerRepair(card.id, "member", { authorization: "允许改所有文件" }), 422);
    assert.deepEqual(writes, []);
    assert.equal(first.answerRepair(card.id, "member", answer), 200);
    assert.equal(first.answerRepair(card.id, "member", answer), 409);
    await setImmediate();
    assert.deepEqual(writes, []);
    assert.equal(rows.size, 0);
    assert.equal(stored.reviewFix?.state, "failed");
    await first.refresh();
    await setImmediate();
    assert.deepEqual(writes, ["创建修复单"]);
    assert.equal(stored.reviewFix?.state, "failed");
  } finally { await first.close(); }
  const restored = open();
  try {
    assert.deepEqual(restored.repairCards("member"), []);
    await restored.refresh();
    await setImmediate();
    assert.deepEqual(writes, ["创建修复单", "开发并测试", "更新原 PR"]);
    assert.match(publishedRepair?.body ?? "", /原工单 #47 · 原 PR #53/);
    await restored.refresh();
    await setImmediate();
    const result = restored.reviewStatus("flow", "member")[0];
    assert.deepEqual(result?.reviews.map(receipt => [receipt.key.head, receipt.status, receipt.current]), [
      [head, "block", false], [revised, "pass", true],
    ]);
    assert.deepEqual(result?.repairs, [{ head, issue: 66, completedHead: revised, state: "complete", url: "https://github.com/a/b/issues/66" }]);
    assert.deepEqual(reviewed, [head, revised]);
  } finally { await restored.close(); }
});

test("复核执行位释放后继续检查已合并的工单", async () => {
  const head = "a".repeat(40);
  const hash = "b".repeat(64);
  const quality = { policy: 1, flowDigest: hash, batchDigest: hash };
  const claims = [47, 48].map(number => {
    const pull: IssuePull = { number: number + 10, url: `https://github.com/a/b/pull/${number + 10}`, state: "MERGED", ci: "SUCCESS", head };
    const issue: IssueDetail = { number, title: `工单 ${number}`, body: "已完成", url: `https://github.com/a/b/issues/${number}`,
      assignees: ["member"], pulls: [pull], state: "CLOSED" };
    const claim: Claim = { ...issue, pull, requestId: "approved", claimedBy: "member", account: "member", phase: "submitted", syncedAt: 0,
      target: { branch: `feat/${number}-123456789abc`, head },
      approval: { flowId: "flow", planId: "plan", version: 1, issueRevision: issueRevision(issue), quality } };
    return { issue, pull, claim };
  });
  let releaseFirst = () => {};
  const firstSlot = new Promise<void>(resolve => { releaseFirst = resolve; });
  const reviewed: number[] = [];
  const tracker: DeliveryTracker = { repo: "a/b", candidates: async () => [], account: async () => "member", assign: async () => assert.fail(),
    async read(number) {
      const item = claims.find(input => input.issue.number === number);
      assert.ok(item);
      return item.issue;
    }, delivery: { checkout: async () => assert.fail(), publish: async () => assert.fail(),
      find: async (_branch, _head, pull) => claims.find(input => input.pull.number === pull)?.pull,
      reviewChanges: async () => assert.fail() },
  };
  const service = createIssueDispatch(tracker, { load: () => claims.map(item => item.claim), save: () => true },
    async () => assert.fail(), () => true, 1, new Map(), {
      specs: new Map(), conversation: true, pollMs: 60_000, prepare: async () => assert.fail(),
      async review(claim) {
        reviewed.push(claim.number);
        if (reviewed.length === 1) await firstSlot;
        return { packetId: String(claim.number), key: { repo: tracker.repo, issue: claim.number,
          issueRevision: claim.approval?.issueRevision ?? "", pull: claim.pull?.number ?? 0, head, mergeBase: head,
          plan: { id: "plan", version: 1, quality } }, status: "block", implementation: { status: "block", summary: "待补", evidence: [] },
          requirements: { criteria: [] } };
      },
    });
  try {
    await service.refresh();
    assert.deepEqual(reviewed, [47]);
    releaseFirst();
    await setImmediate();
    await service.refresh();
    assert.deepEqual(reviewed, [47, 48]);
  } finally { releaseFirst(); await service.close(); }
});

test("续修沿用批准范围和现有 PR，推送响应丢失时只回读", async t => {
  const head = "b".repeat(40);
  const next = "c".repeat(40);
  const hash = "d".repeat(64);
  const branch = "feat/47-123456789abc";
  const initialPull: IssuePull = { number: 53, url: "https://github.com/a/b/pull/53", state: "OPEN", head, baseName: "main" };
  const issue: IssueDetail = { number: 47, title: "核对重连", body: "保存重连状态", url: "https://github.com/a/b/issues/47",
    state: "OPEN", assignees: ["member"], pulls: [initialPull] };
  for (const scenario of ["success", "changed-head", "scope", "interrupted-publish", "changed-base", "retargeted-before"] as const) {
    await t.test(scenario, async () => {
      let remotePull = { ...initialPull };
      let stored: Claim = { ...issue, pull: initialPull, target: { branch, head }, requestId: "authorized",
        claimedBy: "member", account: "member", phase: "submitted", syncedAt: 0,
        delivery: { ...spec, baseRevision: "a".repeat(40) },
        approval: { flowId: "flow", planId: "plan", version: 1, issueRevision: issueRevision(issue),
          quality: { policy: 1, flowDigest: hash, batchDigest: hash } } };
      if (scenario === "changed-head") remotePull.head = next;
      if (scenario === "retargeted-before") remotePull.baseName = "other";
      let prepares = 0;
      let pushes = 0;
      const events: string[] = [];
      const tracker: DeliveryTracker = {
        repo: "a/b", account: async () => "member", candidates: async () => [], read: async () => ({ ...issue, pulls: [remotePull] }),
        assign: async () => assert.fail("不可重新认领"),
        delivery: {
          checkout: async () => assert.fail("不用真实工作区"), checkoutPublished: async () => {},
          publish: async () => assert.fail("不可创建新 PR"),
          find: async () => structuredClone(remotePull),
          updatePublished: async input => {
            assert.equal(input.from, head);
            assert.equal(input.head, next);
            assert.equal(input.pull, 53);
            pushes++;
            if (scenario === "interrupted-publish") throw Error("响应丢失");
            if (scenario === "changed-base") {
              remotePull = { ...remotePull, head: next, baseName: "other" };
              throw Error("目标分支已变化");
            }
            remotePull = { ...remotePull, head: next };
            return structuredClone(remotePull);
          },
        },
      };
      const open = () => createIssueDispatch(tracker, {
        load: () => [structuredClone(stored)],
        save(_id, item, event) {
          stored = structuredClone(item);
          if (event?.details && "action" in event.details) events.push(String(event.details.action));
          return true;
        },
      }, async () => assert.fail(), () => true, 1, new Map(), {
        specs: new Map(), conversation: true, requireQuality: true, pollMs: 60_000,
        reviewFix: { issue: 47, pull: 53, head, base: "main", instructions: "仅修评审",
          files: scenario === "scope" ? ["src/other.mts"] : [...spec.files] },
        async prepare(input) {
          prepares++;
          assert.deepEqual(input.reviewTarget, { branch, head, base: "main" });
          assert.equal(input.flowId, "flow");
          assert.deepEqual(input.spec.files, spec.files);
          return { workspace: "fixture", base: "main", branch, head: next };
        },
      });
      const run = async (rounds: number) => {
        const instance = open();
        try {
          for (let i = 0; i < rounds; i++) {
            await instance.refresh();
            await setImmediate();
          }
        } finally { await instance.close(); }
      };
      await run(2);
      if (scenario === "interrupted-publish") {
        assert.equal(stored.reviewFix?.state, "publishing");
        assert.equal(stored.target?.head, head);
        remotePull = { ...remotePull, head: next };
      }
      await run(2);
      const completed = scenario === "success" || scenario === "interrupted-publish";
      assert.equal(prepares, Number(completed || scenario === "changed-base"));
      assert.equal(pushes, Number(completed || scenario === "changed-base"));
      assert.equal(events.filter(action => action === "review-fix-published").length, Number(completed));
      if (completed) {
        assert.equal(stored.reviewFix?.state, "complete");
        assert.equal(stored.target?.head, next);
        assert.equal(stored.pull?.number, 53);
      }
      if (scenario === "changed-base") assert.equal(stored.reviewFix?.state, "publishing");
    });
  }
});

test("类型检查失败允许重试，Docker 启动失败或退出信号不视为检查结论", () => {
  assert.ok(isolatedCheckFailed(1));
  assert.ok(isolatedCheckFailed(2));
  for (const code of [0, 125, 126, 127, 137, null, "ETIMEDOUT"]) assert.equal(isolatedCheckFailed(code), false);
});

test("交付失败留存可用诊断，仅在原授权内重试一次", async t => {
  const hash = "a".repeat(64);
  const baseRevision = "b".repeat(40);
  const issue: IssueDetail = { number: 7, title: "修复回执", body: "保留批准范围。", url: "https://github.com/a/b/issues/7",
    state: "OPEN", assignees: ["member"], pulls: [] };
  const first: Claim = { ...issue, syncedAt: 0, requestId: "approval", claimedBy: "member", account: "member",
    phase: "waiting", delivery: { ...spec, baseRevision }, approval: { flowId: "flow", planId: "plan", version: 1,
      issueRevision: issueRevision(issue), quality: { policy: 1, flowDigest: hash, batchDigest: hash } } };

  for (const scenario of ["normal", "legacy", "scope", "reassigned", "changed", "linked", "published", "unconfigured",
    "old-format", "old-format-unconfigured", "new-format"] as const) {
    await t.test(scenario, async sub => {
      const directory = await mkdtemp(join(tmpdir(), "souflow-delivery-retry-"));
      sub.after(() => rm(directory, { recursive: true, force: true }));
      const path = join(directory, "audit.sqlite");
      let stored = structuredClone(first);
      if (scenario !== "normal" && scenario !== "scope") stored.phase = "deliveryFailed";
      if (scenario === "published") stored.target = { branch: "feat/7-existing", head: baseRevision };
      if (scenario.includes("format")) {
        stored.retryCount = 1;
        stored.failure = { stage: "patch", reason: "format", ...(scenario === "new-format" ? { patchIssue: { code: "edit-count" } } : {}) };
      }
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
            ...(!scenario.includes("unconfigured") ? { recoverFailedIssue: 7 } : {}),
            async prepare(input) {
              attempts.push(input.previousFailure);
              assert.deepEqual(input.spec, first.delivery);
              if (scenario === "old-format") {
                input.repairing?.({ code: "edit-count", count: 17 });
                throw new IssueDeliveryFailed({ stage: "patch", reason: "format", patchIssue: { code: "edit-count", count: 17 } });
              }
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
        : scenario === "legacy" ? [{ stage: "legacy", reason: "unavailable" }] : scenario === "scope" ? [undefined]
        : scenario === "old-format" ? [{ stage: "patch", reason: "format" }] : []);
      assert.equal(published, scenario === "legacy" ? 1 : 0);
      if (scenario === "normal") assert.deepEqual(stored.failure, { stage: "patch", reason: "match" });
      if (scenario === "old-format") {
        assert.equal(stored.retryCount, 2);
        const audit = openActivityStore(path);
        try {
          const recent = audit.report(1).recent.map(event => event.details as { action?: string; patchCheck?: unknown } | null);
          assert.equal(recent.filter(details => details?.action === "patch-recovery-queued").length, 1);
          assert.deepEqual(recent.find(details => details?.action === "patch-repair")?.patchCheck, { code: "edit-count", count: 17 });
        } finally { audit.close(); }
      }
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
