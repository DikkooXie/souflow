import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { blockingTestDiagnostic, diagnoseIsolationFailure, readIsolationEvidence } from "../src/execution/isolation-evidence.mts";

test("TS 与 Biome 只保安全定位，info 不触发续修，warning 与 error 可区分且截断停止", async t => {
  const root = await mkdtemp(join(tmpdir(), "souflow-diagnostics-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "report.json");
  await writeFile(path, JSON.stringify({ diagnostics: ["info", "warning", "error"].map((severity, index) => ({ severity,
    category: "lint/correctness/noUnsafeOptionalChaining", message: "private source and token must not cross",
    location: { path: "tests/example.test.mts", start: { line: index + 1, column: 39 }, sourceCode: "private source" } })) }));
  const run = () => spawnSync(process.execPath, ["src/execution/quality-diagnostics.mjs", path], { encoding: "utf8" });
  const output = run();
  assert.equal(output.status, 0);
  assert.doesNotMatch(output.stdout, /info|private|token/);
  const evidence = diagnoseIsolationFailure({ code: 1, stdout: `${output.stdout}\ntests/example.test.mts(10,2): error TS1345: private text` },
    false, new AbortController().signal);
  assert.equal(evidence.diagnostics?.length, 3);
  assert.deepEqual(readIsolationEvidence(evidence), evidence);
  assert.ok(evidence.diagnostics?.every(line => blockingTestDiagnostic(line)));
  assert.equal(blockingTestDiagnostic("tests/example.test.mts:1:1 BIOME:info:lint/style/useTemplate"), undefined);
  assert.equal(blockingTestDiagnostic("src/example.mts:1:1 TS1345"), undefined);
  const repeated = blockingTestDiagnostic("tests/example.test.mts:99:4 TS1345");
  assert.equal(repeated?.key, blockingTestDiagnostic("tests/example.test.mts:1:2 TS1345")?.key);
  await writeFile(path, JSON.stringify({ diagnostics: [{ severity: "error", category: "parse", location: { path: "package.json" } }] }));
  assert.match(run().stdout, /SOUFLOW_DIAGNOSTICS_INCOMPLETE/);
  const truncated = diagnoseIsolationFailure({ code: 1, stdout: `${output.stdout}SOUFLOW_DIAGNOSTICS_INCOMPLETE\n` }, false, new AbortController().signal);
  assert.equal(truncated.diagnosticsIncomplete, true);
  const full = Array.from({ length: 16 }, (_, i) => `tests/example.test.mts(${i + 1},1): error TS1345:`).join("\n");
  const inspect = (stderr: string) => diagnoseIsolationFailure({ code: 1, stdout: full, stderr }, false, new AbortController().signal, 4096);
  assert.equal(inspect(full).diagnostics?.length, 16);
  assert.equal(inspect(full).diagnosticsIncomplete, undefined);
  assert.equal(inspect("src/main.mts(1,1): error TS1345:").diagnosticsIncomplete, true);
  assert.equal(inspect("SOUFLOW_DIAGNOSTICS_INCOMPLETE").diagnosticsIncomplete, true);
});
