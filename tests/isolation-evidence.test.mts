import assert from "node:assert/strict";
import test from "node:test";
import { readCodeWorkerConfig } from "../src/config/runtime.mts";
import { diagnoseIsolationFailure, readIsolationEvidence } from "../src/execution/isolation-evidence.mts";

test("AC-3 隔离失败仅保留限长、脱敏的检查诊断标题", () => {
  const limit = readCodeWorkerConfig({ SOULFLOW_CODE_WORKER_DIAGNOSTIC_MAX_BYTES: "512" }).diagnosticMaxBytes;
  const error = Object.assign(new Error("检查失败"), {
    code: 2,
    stdout: [
      "src/example.mts(3,4): error TS2322: Type 'string' is not assignable to type 'number'.",
      "  const token = 'ghp_12345678901234567890';",
      "src/secret.mts(4,5): error TS2345: Authorization: Bearer ghp_12345678901234567890",
    ].join("\n"),
    stderr: "ordinary output that may contain source text",
  });
  const evidence = diagnoseIsolationFailure(error, false, new AbortController().signal, limit);
  assert.equal(evidence.step, "quality");
  assert.equal(evidence.outcome, "exit");
  assert.equal(evidence.exitCode, 2);
  assert.equal(evidence.diagnostics?.length, 2);
  assert.match(evidence.diagnostics?.[0] ?? "", /TS2322/);
  assert.equal(evidence.diagnostics?.[0], "src/example.mts:3:4 TS2322");
  assert.doesNotMatch(JSON.stringify(evidence), /ghp_12345678901234567890|ordinary output|const token/);
  assert.deepEqual(readIsolationEvidence(evidence, limit), evidence);
  assert.ok(Buffer.byteLength(JSON.stringify(evidence.diagnostics)) <= limit);
});

test("AC-3 依赖安装、超时、取消与 Docker 基础设施错误分类准确且不保留安装输出", () => {
  const signal = new AbortController().signal;
  assert.deepEqual(diagnoseIsolationFailure(Object.assign(new Error(), { code: 1, stdout: "private npm output" }), true, signal),
    { step: "dependencies", outcome: "exit", exitCode: 1 });
  assert.deepEqual(diagnoseIsolationFailure(Object.assign(new Error(), { code: 125 }), false, signal),
    { step: "quality", outcome: "infrastructure", exitCode: 125 });
  assert.deepEqual(diagnoseIsolationFailure(Object.assign(new Error(), { killed: true }), false, signal),
    { step: "quality", outcome: "infrastructure" });

  const cancelled = new AbortController();
  cancelled.abort(new Error("cancelled"));
  assert.deepEqual(diagnoseIsolationFailure(new Error(), false, cancelled.signal),
    { step: "quality", outcome: "cancelled" });

  const timeout = new AbortController();
  timeout.abort(Object.assign(new Error("timeout"), { name: "TimeoutError" }));
  assert.deepEqual(diagnoseIsolationFailure(new Error(), false, timeout.signal),
    { step: "quality", outcome: "timeout" });
});

test("AC-3 拒绝超长或与退出检查不一致的诊断回执", () => {
  assert.equal(readIsolationEvidence({ step: "quality", outcome: "exit", exitCode: 2,
    diagnostics: ["x".repeat(513) + " error TS2322:"] }, 512), undefined);
  assert.equal(readIsolationEvidence({ step: "dependencies", outcome: "exit", exitCode: 2,
    diagnostics: ["error TS2322: failure"] }), undefined);
  assert.equal(readIsolationEvidence({ step: "quality", outcome: "infrastructure", exitCode: 125,
    diagnostics: ["error TS2322: failure"] }), undefined);
});

test("AC-3 单条诊断超上限时继续保留后续合规诊断", () => {
  const long = `src/${"x".repeat(700)}.mts(1,1): error TS2322: detail`;
  const short = "src/valid.mts(2,3): error TS2345: detail";
  const error = Object.assign(new Error(), { code: 2, stdout: `${long}\n${short}` });
  const evidence = diagnoseIsolationFailure(error, false, new AbortController().signal, 256);
  assert.deepEqual(evidence.diagnostics, ["src/valid.mts:2:3 TS2345"]);
});
