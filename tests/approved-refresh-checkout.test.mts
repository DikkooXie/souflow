import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { createGitHubDelivery } from "../src/connections/github-delivery.mts";
import { checkoutApprovedRefresh, proveRefreshedSources } from "../src/execution/dependency-source-handoff.mts";
import { createDispatchMonitor } from "../src/execution/dispatch-monitor.mts";
import { createIssueDeveloper, IssueDeliverySourcesChanged } from "../src/execution/issue-delivery.mts";

test("恢复固定授权提交，拒绝旁支祖先，并从旧提交向当前主干推送关联 PR", async t => {
  const root = await mkdtemp(join(tmpdir(), "souflow-approved-refresh-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = join(root, "remote"), workspace = join(root, "source");
  await mkdir(repository);
  const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, "-c", "user.name=Test",
    "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", ...args],
  { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git(repository, "init", "-q", "--initial-branch=main");
  await mkdir(join(repository, "src"));
  await writeFile(join(repository, "src/main.mts"), "export const value = 1;\n");
  await writeFile(join(repository, "src/upstream.mts"), "export const upstream = 1;\n");
  git(repository, "add", ".");
  git(repository, "commit", "-qm", "original");
  const original = git(repository, "rev-parse", "HEAD");
  git(repository, "switch", "-c", "feat/upstream");
  await writeFile(join(repository, "src/upstream.mts"), "export const upstream = 2;\n");
  git(repository, "commit", "-am", "upstream");
  const side = git(repository, "rev-parse", "HEAD");
  git(repository, "switch", "main");
  git(repository, "merge", "--no-ff", "--no-edit", "feat/upstream");
  const approved = git(repository, "rev-parse", "HEAD");
  await writeFile(join(repository, "src/main.mts"), "export const value = 9;\n");
  git(repository, "commit", "-am", "later main");
  const latest = git(repository, "rev-parse", "HEAD");
  git(root, "clone", "-q", "--", repository, workspace);
  const runGit = async (args: string[]) => git(workspace, ...args);
  const producer = { issue: 1, pull: 10, head: side, merge: approved, baseName: "main", files: ["src/upstream.mts"], sources: ["src/upstream.mts"] };
  await assert.rejects(checkoutApprovedRefresh(runGit, side), IssueDeliverySourcesChanged);
  await assert.rejects(checkoutApprovedRefresh(runGit, "f".repeat(40)), IssueDeliverySourcesChanged);
  assert.equal(git(workspace, "rev-parse", "HEAD"), latest);
  await assert.rejects(proveRefreshedSources(runGit, original, approved, ["src/main.mts", "src/upstream.mts"], undefined,
    [approved], [producer]), IssueDeliverySourcesChanged, "普通复核仍必须使用当前主干");
  await checkoutApprovedRefresh(runGit, approved);
  const proof = await proveRefreshedSources(runGit, original, approved, ["src/main.mts", "src/upstream.mts"], undefined, [approved], [producer]);
  assert.equal(proof.execution, approved);
  assert.equal(await readFile(join(workspace, "src/main.mts"), "utf8"), "export const value = 1;\n");

  let reviewed = false, started = false;
  const stoppedAtModel = new Error("固定源码已交给模型夹具");
  const prepare = createIssueDeveloper(createDispatchMonitor("fixture"), { root: join(root, "artifacts"), image: "unused", timeoutMs: 5000,
    startTask: options => {
      started = true;
      assert.equal(git(options.workspace, "rev-parse", "HEAD"), approved);
      assert.ok(options.untrustedContext);
      assert.match(options.untrustedContext, /export const value = 1/);
      throw stoppedAtModel;
    } });
  await assert.rejects(prepare({ number: 2, branch: "feat/2-123456789abc", upstream: [approved],
    spec: { files: ["src/main.mts"], instructions: "固定授权", dependsOn: [1], baseRevision: original,
      sourcePaths: ["src/upstream.mts"], sourceFrom: [{ issue: 1, path: "src/upstream.mts" }] },
    publisher: { checkout: async target => { git(root, "clone", "-q", "--", repository, target);
      return { base: "main", author: "Fixture", email: "fixture@example.invalid" }; },
      find: async () => undefined, publish: async () => assert.fail("模型夹具停止，不能发布") },
    sourceHandoff: { refreshRevision: approved, reuseApprovedRevision: true, current: async () => [producer],
      review: async (proof, sources) => { reviewed = true; assert.equal(proof.execution, approved);
        assert.equal(sources["src/main.mts"], "export const value = 1;\n"); },
      ready: () => assert.equal(reviewed, true) },
  }, () => {}, new AbortController().signal));
  assert.equal(started, true);

  // 发布适配器使用真实本地 Git push；只模拟 GitHub 的 PR API，不调用远端服务。
  await writeFile(join(workspace, "src/main.mts"), "export const value = 2;\n");
  git(workspace, "commit", "-am", "fixed-source change");
  const head = git(workspace, "rev-parse", "HEAD");
  const branch = "feat/2-123456789abc";
  let created = false;
  const publisher = createGitHubDelivery("fixture/recovery", async args => {
    if (args[0] === "graphql") return JSON.stringify({ data: { repository: { pullRequests: { nodes: created ? [{ number: 11,
      state: "OPEN", isDraft: true, headRefOid: head, baseRefName: "main", mergeCommit: null,
      headRepository: { nameWithOwner: "fixture/recovery" }, commits: { nodes: [] } }] : [] } } } });
    assert.ok(args.includes("repos/fixture/recovery/pulls"));
    assert.ok(args.includes("base=main"));
    assert.ok(args.includes(`head=${branch}`));
    assert.ok(args.includes("body=Closes #2\n\n本机 Codex 在独立工作区生成改动，npm run check 通过。请核对工单验收条件、差异和 GitHub CI。"));
    created = true;
    return JSON.stringify({ number: 11 });
  }, async () => ({ ...process.env, GIT_CONFIG_COUNT: "2", GIT_CONFIG_KEY_0: `url.${pathToFileURL(repository)}.insteadOf`,
    GIT_CONFIG_VALUE_0: "https://github.com/fixture/recovery.git", GIT_CONFIG_KEY_1: "protocol.file.allow", GIT_CONFIG_VALUE_1: "always" }));
  assert.equal((await publisher.publish({ workspace, branch, head, base: "main", issue: 2, title: "fixture" }, new AbortController().signal)).number, 11);
  assert.equal(git(repository, "rev-parse", `refs/heads/${branch}`), head);
  assert.equal(git(repository, "rev-parse", "main"), latest);
  assert.equal(git(repository, "rev-parse", `${head}^`), approved);
});
