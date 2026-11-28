import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { contentDigest } from "../src/execution/code-worker-protocol.mts";
import { verifyCandidatePatch } from "../src/execution/candidate-patch-evidence.mts";

test("隔离候选补丁必须能从已批准源码精确生成声明的文件哈希", async t => {
  const root = await mkdtemp(join(tmpdir(), "souflow-candidate-proof-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = "src/example.mts";
  const before = "export const value = 1;\n";
  const after = "export const value = 2;\n";
  await mkdir(join(root, "before", "src"), { recursive: true });
  await mkdir(join(root, "after", "src"), { recursive: true });
  await writeFile(join(root, "before", path), before);
  await writeFile(join(root, "after", path), after);
  const diff = spawnSync("git", ["diff", "--no-index", "--no-ext-diff", "--no-textconv", "--no-color", "--binary",
    "--src-prefix=a/", "--dst-prefix=b/", "--", `before/${path}`, `after/${path}`], { cwd: root, encoding: "utf8" });
  assert.equal(diff.status, 1);
  const patch = diff.stdout;
  const files = [{ path, before: contentDigest(before), after: contentDigest(after), mode: 0o100644 as const }];
  const [candidateFile] = files;
  assert.ok(candidateFile);
  const sources = new Map([[path, { content: before, mode: 0o644 }]]);

  assert.equal(verifyCandidatePatch(sources, files, patch), true);
  assert.equal(verifyCandidatePatch(sources, [{ ...candidateFile, after: contentDigest("wrong\n") }], patch), false);
  assert.equal(verifyCandidatePatch(new Map([[path, { content: "different\n", mode: 0o644 }]]), files, patch), false);
  assert.equal(verifyCandidatePatch(sources, [{ ...candidateFile, path: "src/other.mts" }], patch), false);
  assert.equal(verifyCandidatePatch(sources, files, `${patch}\ndiff --git a/before/secret b/after/secret\n`), false);
  const secretPath = "src/unauthorized.mts";
  await mkdir(join(root, "before", "src"), { recursive: true });
  await mkdir(join(root, "after", "src"), { recursive: true });
  await writeFile(join(root, "before", secretPath), "export const secret = 1;\n");
  await writeFile(join(root, "after", secretPath), "export const secret = 2;\n");
  const extra = spawnSync("git", ["diff", "--no-index", "--no-ext-diff", "--no-textconv", "--no-color", "--binary",
    "--src-prefix=a/", "--dst-prefix=b/", "--", `before/${secretPath}`, `after/${secretPath}`], { cwd: root, encoding: "utf8" });
  assert.equal(extra.status, 1);
  assert.equal(verifyCandidatePatch(sources, files, patch + extra.stdout), false);
  assert.equal((await readFile(join(root, "before", path), "utf8")), before);
});
