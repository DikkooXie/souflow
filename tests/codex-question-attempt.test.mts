import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { type CodexAttemptEvent, startCodexQuestionAttempt } from "../src/execution/codex-command-attempt.mts";


const fixture = fileURLToPath(new URL("./fixtures/codex-app-server.mjs", import.meta.url));

type Overrides = Pick<Parameters<typeof startCodexQuestionAttempt>[0], "outputSchema" | "answerMaxLength" | "model" | "onAccount">;

function runQuestion(t: TestContext, scenario: string, workspace: string, overrides?: Overrides) {
  const events: CodexAttemptEvent[] = [];
  let reportQuestion!: (event: Extract<CodexAttemptEvent, { kind: "question-requested" }>) => void;
  const requested = new Promise<Extract<CodexAttemptEvent, { kind: "question-requested" }>>(resolve => {
    reportQuestion = resolve;
  });
  const attempt = startCodexQuestionAttempt({
    workspace, prompt: "验证需求澄清", command: [process.execPath, fixture, scenario, ...(overrides?.model ? [overrides.model] : [])],
    ...overrides,
    onEvent(event) {
      events.push(event);
      if (event.kind === "question-requested") reportQuestion(event);
    },
  });
  t.after(attempt.close);
  return { attempt, events, requested };
}

test("账号观察只返回本次运行的短标记，未知及无响应的账号仍可发出澄清", { timeout: 5000 }, async t => {
  const workspace = await mkdtemp(join(tmpdir(), "souflow-account-"));
  t.after(() => rm(workspace, { recursive: true }));
  async function observe(scenario: string) {
    const refs: string[] = [];
    const { requested, attempt } = runQuestion(t, `question-account-${scenario}`, workspace, { onAccount: ref => { refs.push(ref); } });
    await requested;
    attempt.close();
    return refs;
  }
  const [first, second, late, other, ...unavailable] = await Promise.all(
    ["first", "second", "late", "other", "missing", "key", "unsupported", "silent"].map(observe),
  );
  assert.ok(first?.[0] && /^[a-f0-9]{12}$/.test(first[0]));
  assert.deepEqual(first, second);
  assert.deepEqual(first, late);
  assert.ok(other?.[0] && other[0] !== first[0]);
  assert.ok(unavailable.every(refs => refs.length === 0));
});

test("keeps invalid, secret, and permission requests out of the decision inbox", { timeout: 5000 }, async t => {
  const workspace = await mkdtemp(join(tmpdir(), "souflow-question-"));
  t.after(() => rm(workspace, { recursive: true }));
  const scenarios = ["question-foreign-thread", "question-foreign-turn", "question-secret", "question-command"];
  await Promise.all(scenarios.map(async scenario => {
    const { attempt, events } = runQuestion(t, scenario, workspace);
    assert.equal(await attempt.finished, "completed", scenario);
    assert.deepEqual(events, [], scenario);
  }));
  const invalid = runQuestion(t, "question-invalid-config", workspace);
  assert.equal(await invalid.attempt.finished, "failed");
  assert.deepEqual(invalid.events, []);
});

test("requests the configured planning model and rejects a fallback before asking", { timeout: 5000 }, async t => {
  const workspace = await mkdtemp(join(tmpdir(), "souflow-planning-model-"));
  t.after(() => rm(workspace, { recursive: true }));
  const model = "fixture-planner";
  const pinned = runQuestion(t, "question-valid", workspace, { model });
  const fallback = runQuestion(t, "question-model-mismatch", workspace, { model });
  assert.equal(await fallback.attempt.finished, "failed");
  assert.deepEqual(fallback.events, []);
  assert.equal(pinned.attempt.answerQuestions((await pinned.requested).requestId, { language: " TypeScript" }), true);
  assert.equal(await pinned.attempt.finished, "completed");
});

test("preserves option labels and expires or reconciles questions on disconnect", { timeout: 5000 }, async t => {
  const workspace = await mkdtemp(join(tmpdir(), "souflow-question-"));
  t.after(() => rm(workspace, { recursive: true }));
  const pending = runQuestion(t, "question-valid", workspace);
  const submitted = runQuestion(t, "question-lost-after-answer", workspace);
  const valid = runQuestion(t, "question-valid", workspace);
  const [a, b, c] = await Promise.all([pending.requested, submitted.requested, valid.requested]);
  pending.attempt.close();
  assert.equal(pending.attempt.answerQuestions(a.requestId, { language: " TypeScript" }), false);
  assert.equal(submitted.attempt.answerQuestions(b.requestId, { language: " TypeScript" }), true);
  assert.equal(valid.attempt.answerQuestions(c.requestId, { language: "TypeScript" }), false);
  assert.equal(valid.attempt.answerQuestions(c.requestId, { language: " TypeScript" }), true);
  assert.deepEqual(await Promise.all([pending.attempt.finished, submitted.attempt.finished, valid.attempt.finished]),
    ["needs-reconciliation", "needs-reconciliation", "completed"]);
  assert.equal(pending.events.at(-1)?.kind, "question-expired");
  assert.equal(submitted.events.at(-1)?.kind, "question-uncertain");
  assert.equal(valid.events.at(-1)?.kind, "question-cleared");
});

test("does not fall back to an earlier output when the final result exceeds the size limit", { timeout: 5000 }, async t => {
  const workspace = await mkdtemp(join(tmpdir(), "souflow-question-"));
  t.after(() => rm(workspace, { recursive: true }));
  const { attempt, requested } = runQuestion(t, "question-output", workspace, { outputSchema: { type: "object" } });
  assert.equal(attempt.answerQuestions((await requested).requestId, { language: " TypeScript" }), true);
  assert.equal(await attempt.finished, "completed");
  assert.equal(attempt.output(), undefined);
});

test("uses the configured custom answer limit in the Codex adapter", { timeout: 5000 }, async t => {
  const workspace = await mkdtemp(join(tmpdir(), "souflow-question-limit-"));
  t.after(() => rm(workspace, { recursive: true }));
  const { attempt, requested } = runQuestion(t, "question-custom-length", workspace, { answerMaxLength: 1200 });
  const { requestId } = await requested;
  const boundary = "自".repeat(1200);
  assert.equal(attempt.answerQuestions(requestId, { language: boundary + "外" }), false);
  assert.equal(attempt.answerQuestions(requestId, { language: boundary }), true);
  assert.equal(await attempt.finished, "completed");
});
