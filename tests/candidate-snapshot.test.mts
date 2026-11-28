import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile, access, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { contentDigest } from "../src/execution/code-worker-protocol.mts";
import { locateFailedCandidate, readCandidateSnapshot, verifyCandidateSnapshot } from "../src/execution/candidate-snapshot.mts";
import { applyLocalCodeChanges, readEditableFile } from "../src/execution/local-code-changes.mts";
import { IssueDeliveryFailed, type DeliveryFailure } from "../src/execution/issue-delivery.mts";
import { createRepairCandidateInspector } from "../src/execution/repair-candidate-inspection.mts";

test("旧父候选与最新增量组合为完整快照，只读全检从固定头重建且不复制未跟踪文件", async t => {
  const root = await mkdtemp(join(tmpdir(), "souflow-candidate-snapshot-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const parent = join(root, "issue-1-parent"), first = join(parent, "source");
  await mkdir(join(first, "src"), { recursive: true }); await mkdir(join(first, "tests"));
  const paths = ["src/main.mts", "tests/main.test.mts"];
  for (const path of paths) await writeFile(join(first, path), "export const value = 1;\n");
  const git = (dir: string, ...args: string[]) => execFileSync("git", ["-C", dir, "-c", "user.name=Test",
    "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git(first, "init", "-q"); git(first, "add", "."); git(first, "commit", "-qm", "baseline");
  const head = git(first, "rev-parse", "HEAD"), signal = new AbortController().signal;
  const original = new Map(await Promise.all(paths.map(async path => [path, await readEditableFile(first, path)] as const)));
  await applyLocalCodeChanges(parent, first, original, paths.map(path => ({ path, before: "value = 1", after: "value = 2" })));
  const base = await readCandidateSnapshot(first, head, paths, signal);
  const next = join(root, "issue-1-next"), source = join(next, "source");
  await mkdir(next); git(root, "clone", "-q", "--", first, source);
  for (const path of paths) await writeFile(join(source, path), await readFile(join(first, path)));
  const file = paths[1] as string;
  const latest = await applyLocalCodeChanges(next, source, new Map([[file, await readEditableFile(source, file)]]),
    [{ path: file, before: "value = 2", after: "value = 3" }]);
  const failure: DeliveryFailure = { stage: "tests", reason: "check-failed", candidateFiles: latest.changes as NonNullable<DeliveryFailure["candidateFiles"]>,
    candidateDigest: contentDigest(JSON.stringify(latest.changes)), candidatePatchDigest: latest.patchSha256,
    candidatePatch: await readFile(latest.patchPath, "utf8") };
  const ancestor = { draft: base, files: base.files, digest: base.digest };
  const snapshot = await locateFailedCandidate(root, 1, head, paths, failure, ancestor, signal);
  assert.equal(snapshot.artifact, "issue-1-next");
  assert.equal(snapshot.files.length, 2);
  assert.equal(snapshot.files.find(row => row.path === file)?.before, base.files.find(row => row.path === file)?.before);
  assert.notEqual(snapshot.files.find(row => row.path === file)?.after, base.files.find(row => row.path === file)?.after);
  assert.equal(await verifyCandidateSnapshot(root, 1, snapshot, head, paths, signal), await realpath(source));
  await assert.rejects(locateFailedCandidate(root, 1, head, paths, failure, { ...ancestor, digest: "0".repeat(64) }, signal));
  await assert.rejects(locateFailedCandidate(root, 1, head, paths, { ...failure, candidatePatch: `${failure.candidatePatch}changed` }, ancestor, signal));
  await assert.rejects(verifyCandidateSnapshot(root, 1, { ...snapshot, sha256: "0".repeat(64) }, head, paths, signal));
  await assert.rejects(verifyCandidateSnapshot(root, 1, snapshot, head, [file], signal));
  await writeFile(join(source, "untracked.mjs"), "throw Error('must never be copied');\n");
  await mkdir(join(source, "node_modules")); await writeFile(join(source, "node_modules/untrusted"), "untrusted");
  let installs = 0, checks = 0;
  const inspector = createRepairCandidateInspector({ root, image: "fixture", timeoutMs: 1000,
    check: async (workspace, _image, _timeout, _signal, install) => {
      assert.notEqual(workspace, source);
      await assert.rejects(access(join(workspace, "untracked.mjs")));
      await assert.rejects(access(join(workspace, "node_modules/untrusted")));
      assert.equal(await readFile(join(workspace, file), "utf8"), "export const value = 3;\n");
      if (install) { installs++; return []; }
      checks++;
      throw new IssueDeliveryFailed({ stage: "tests", reason: "check-failed", isolation: { step: "quality", outcome: "exit", exitCode: 1,
        diagnostics: [`${file}:263:39 BIOME:error:lint/correctness/noUnsafeOptionalChaining`] } });
    } });
  const result = await inspector({ issue: 1, head, files: paths, branch: "feat/1-fixture", base: "main", failure, parent: ancestor,
    publisher: { checkout: async workspace => { git(root, "clone", "-q", "--", first, workspace); return { base: "main", author: "Test", email: "test@example.invalid" }; },
      checkoutPublished: async () => {}, find: async () => undefined, publish: async () => assert.fail() } }, signal);
  assert.equal(result.candidate.sha256, snapshot.sha256);
  assert.equal(result.isolation?.diagnostics?.length, 1);
  assert.equal(installs, 1); assert.equal(checks, 1);
});
