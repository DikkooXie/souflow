import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { contentDigest } from "../src/execution/code-worker-protocol.mts";
import { createDispatchMonitor } from "../src/execution/dispatch-monitor.mts";
import { restoreFailedReviewDraft, type FailedReviewDraftEvidence } from "../src/execution/failed-review-draft.mts";
import { createIssueDeveloper } from "../src/execution/issue-delivery.mts";
import { applyLocalCodeChanges, readEditableFile } from "../src/execution/local-code-changes.mts";

test("固定候选的两种补丁摘要和文件清单独立匹配，模型只能纠正一个诊断测试", async t => {
  const root = await mkdtemp(join(tmpdir(), "souflow-replay-evidence-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const artifact = "issue-107-latest", target = join(root, artifact), source = join(target, "source");
  await mkdir(join(source, "src"), { recursive: true });
  await mkdir(join(source, "tests"));
  const files = [...[1, 2, 3, 4].map(n => `src/main${n}.mts`), "tests/other.test.mts", "tests/remote-handoff.test.mts"];
  const selected = "tests/remote-handoff.test.mts";
  const git = (dir: string, ...args: string[]) => execFileSync("git", ["-C", dir, "-c", "user.name=Test",
    "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", ...args],
  { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  for (const file of files) await writeFile(join(source, file), "export const value = 1;\n");
  git(source, "init", "-q");
  git(source, "add", ".");
  git(source, "commit", "-qm", "baseline");
  const head = git(source, "rev-parse", "HEAD").trim();
  const sources = new Map(await Promise.all(files.map(async file => [file, await readEditableFile(source, file)] as const)));
  const candidate = await applyLocalCodeChanges(target, source, sources,
    files.map(path => ({ path, before: "value = 1", after: "value = 2" })));
  const patch = await readFile(candidate.patchPath, "utf8");
  const evidence: FailedReviewDraftEvidence = { files: candidate.changes.map(file => ({ ...file, mode: 0o100644 })),
    patch, sha256: candidate.patchSha256, digest: contentDigest(JSON.stringify(candidate.changes)) };
  const draft = { artifact, sha256: contentDigest(git(source, "diff", "--binary", "--no-ext-diff", "--no-textconv", "--no-color", "--no-renames", "HEAD", "--")) };
  assert.notEqual(draft.sha256, evidence.sha256, "Git差异与双前缀候选分别固定摘要");
  for (const scenario of ["pass", "wrong-before", "wrong-after", "wrong-mode", "missing-file", "outside-scope", "wrong-manifest-digest",
    "wrong-draft-digest", "wrong-patch-digest", "wrong-patch-content"] as const) await t.test(scenario, async () => {
    const work = join(root, scenario), workspace = join(work, "source");
    await mkdir(work);
    git(root, "clone", "-q", "--", source, workspace);
    const current = structuredClone(evidence);
    const first = current.files[0];
    assert.ok(first);
    if (scenario === "wrong-before") first.before = "0".repeat(64);
    if (scenario === "wrong-after") first.after = "0".repeat(64);
    if (scenario === "wrong-mode") first.mode = 0o100755;
    if (scenario === "missing-file") current.files.pop();
    current.digest = contentDigest(JSON.stringify(current.files));
    if (scenario === "wrong-manifest-digest") current.digest = "0".repeat(64);
    if (scenario === "wrong-patch-content") { current.patch = current.patch.replace("+export const value = 2;", "+export const value = 3;");
      current.sha256 = contentDigest(current.patch); }
    if (scenario === "wrong-patch-digest") current.sha256 = "0".repeat(64);
    const result = restoreFailedReviewDraft(root, work, workspace, 107, head,
      scenario === "wrong-draft-digest" ? { ...draft, sha256: "0".repeat(64) } : draft,
      scenario === "outside-scope" ? files.slice(1) : files, 5000, new AbortController().signal, current);
    if (scenario !== "pass") await assert.rejects(result);
    else {
      assert.deepEqual(await result, files);
      for (const file of files) assert.equal(await readFile(join(workspace, file), "utf8"), "export const value = 2;\n");
    }
  });
  let modelStarts = 0;
  const prepare = createIssueDeveloper(createDispatchMonitor("fixture"), {
    root, image: "unused", timeoutMs: 5000, startTask: options => {
      modelStarts++;
      assert.ok(options.untrustedContext);
      const context = JSON.parse(options.untrustedContext);
      assert.deepEqual(context.editableFiles.map((file: { path: string }) => file.path), [selected]);
      assert.equal(context.editableFiles[0].text, "export const value = 2;\n");
      assert.deepEqual(Object.keys(context.recoveredReadOnlySources).sort(), files.filter(file => file !== selected).sort());
      for (const file of files) assert.equal(git(options.workspace, "show", `HEAD:${file}`), "export const value = 1;\n");
      throw Error("模型输入边界已验证，夹具不生成业务代码");
    },
  });
  await assert.rejects(prepare({ number: 107, branch: "feat/107-123456789abc", upstream: [],
    spec: { files, baseRevision: head, dependsOn: [], instructions: "原批准范围" },
    reviewTarget: { branch: "feat/107-123456789abc", head, base: "main" },
    failedReviewDraft: { ...draft, evidence, testFiles: [selected] },
    publisher: { checkout: async workspace => { git(root, "clone", "-q", "--", source, workspace);
      return { base: "main", author: "Test", email: "test@example.invalid" }; },
      checkoutPublished: async () => {}, find: async () => undefined, publish: async () => assert.fail("模型未完成不可发布") },
  }, () => {}, new AbortController().signal));
  assert.equal(modelStarts, 1);
});
