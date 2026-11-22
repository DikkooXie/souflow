import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { startCodexReadOnlyTask } from "../src/execution/codex-command-attempt.mts";
import { codeResultSchema, maxCodeProposalBytes, maxEdits, type PatchIssue, PatchRejection,
  prepareCodeProposal } from "../src/execution/local-code-changes.mts";

const path = "src/demo.mts";
const sources = new Map([[path, { content: "original\nrepeat\nrepeat\n", mode: 0o644 }]]);
const valid = { path, before: "original", after: "updated" };
const reply = (edits: unknown[]) => JSON.stringify({ report: "fixture", edits });

async function patchWorkspace(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "souflow-patch-validation-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("代码回复超过 16 KiB 时完整接收，超出独立容量时保留安全诊断", async t => {
  const fixture = fileURLToPath(new URL("./fixtures/codex-app-server.mjs", import.meta.url));
  const run = (outputMaxBytes?: number) => {
    let overflow: number | undefined;
    const attempt = startCodexReadOnlyTask({ command: [process.execPath, fixture, "long-code-result"],
      workspace: process.cwd(), prompt: "验证传输", outputSchema: codeResultSchema,
      ...(outputMaxBytes === undefined ? {} : { outputMaxBytes }), onEvent() {}, onOutputOverflow(bytes) { overflow = bytes; } });
    t.after(attempt.close);
    return { ...attempt, overflow: () => overflow };
  };
  const limited = run();
  assert.equal(await limited.finished, "completed");
  assert.equal(limited.output(), undefined);
  assert.ok((limited.overflow() ?? 0) > 16_384);
  const patch = run(maxCodeProposalBytes);
  assert.equal(await patch.finished, "completed");
  const applied = await prepareCodeProposal(await patchWorkspace(t), sources, async () => patch.output());
  assert.equal(applied.proposed.get(path)?.length, 18_015);
  assert.equal(patch.overflow(), undefined);
});

test("可修正的补丁仅重新生成一次，修正前没有源码写入", async t => {
  const target = await patchWorkspace(t);
  for (const [input, code] of [
    [undefined, "output-missing"], ["{ ", "json"], ["null", "envelope"],
    [reply(Array(maxEdits + 1).fill(valid)), "edit-count"],
    [reply([{ ...valid, after: null }]), "edit-fields"],
    [reply([{ ...valid, before: "absent" }]), "anchor-missing"],
    [reply([{ ...valid, before: "repeat" }]), "anchor-ambiguous"],
  ] as const) {
    const calls: (PatchIssue | undefined)[] = [];
    const repaired: PatchIssue[] = [];
    const checked = await prepareCodeProposal(target, sources, async issue => {
      calls.push(issue);
      assert.ok(sources.get(path)?.content.startsWith("original"));
      return issue ? reply([valid]) : input;
    }, issue => repaired.push(issue));
    assert.equal(checked.proposed.get(path), "updated\nrepeat\nrepeat\n");
    assert.equal(calls.length, 2);
    assert.deepEqual(calls, [undefined, repaired[0]]);
    assert.equal(repaired[0]?.code, code);
  }
  let attempts = 0;
  await assert.rejects(prepareCodeProposal(target, sources, async () => {
    attempts++;
    return reply([]);
  }), (error: unknown) => error instanceof PatchRejection && error.issue.code === "edit-count");
  assert.equal(attempts, 2);
});

test("合法围栏与无效果替换可规范化，越权或脱敏内容立即停止", async t => {
  const target = await patchWorkspace(t);
  const normalized = await prepareCodeProposal(target, sources, async issue => {
    assert.equal(issue, undefined);
    return "```json\n" + reply([{ ...valid, after: "original" }, valid]) + "\n```";
  });
  assert.equal(normalized.proposed.get(path), "updated\nrepeat\nrepeat\n");
  for (const [edit, expected] of [[{ ...valid, path: "src/outside.mts" }, "unauthorized-file"],
    [{ ...valid, after: "[已隐藏凭据]" }, "redaction-marker"]] as const) {
    await assert.rejects(prepareCodeProposal(target, sources, async issue => {
      assert.equal(issue, undefined);
      return reply([{ ...valid, before: "absent" }, edit]);
    }, () => assert.fail("权限错误不得自动纠正")),
    (error: unknown) => error instanceof PatchRejection && error.issue.code === expected);
  }
});

test("预先核对真实归档补丁的总量，超限后可以合并或缩小替换", async t => {
  const target = await patchWorkspace(t);
  const before = "a".repeat(30_000);
  const after = "b".repeat(30_000);
  const paths = [path, "src/second.mts", "src/third.mts"];
  const large = new Map(paths.map(path => [path, { content: before, mode: 0o644 }]));
  const oversize = reply(paths.map(path => ({ path, before, after })));
  assert.ok(Buffer.byteLength(oversize) < maxCodeProposalBytes);
  const checked = await prepareCodeProposal(target, large, async issue => {
    assert.deepEqual(await readdir(target), []);
    if (issue) {
      assert.deepEqual(issue, { code: "patch-size" });
      return reply([{ path, before, after }]);
    }
    return oversize;
  });
  assert.deepEqual(checked.files, [path]);
  assert.deepEqual(checked.proposed.get(path), after);
  assert.deepEqual(await readdir(target), []);
});
