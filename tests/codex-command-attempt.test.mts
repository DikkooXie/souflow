import assert from "node:assert/strict";
import { once, EventEmitter } from "node:events";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import {
  startCodexCommandAttempt,
  type CodexAttemptEvent,
} from "../src/execution/codex-command-attempt.mts";

const fixture = fileURLToPath(new URL("./fixtures/codex-app-server.mjs", import.meta.url));

async function workspace(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "souflow-approval-"));
  t.after(() => rm(directory, { recursive: true }));
  return directory;
}

function run(t: TestContext, directory: string, scenario: string, notify?: (event: CodexAttemptEvent) => void) {
  const events: CodexAttemptEvent[] = [];
  const updates = new EventEmitter();
  const attempt = startCodexCommandAttempt({
    workspace: directory,
    prompt: "验证本地命令审批",
    command: [process.execPath, fixture, scenario],
    onEvent(event) {
      events.push(event);
      updates.emit("update");
      notify?.(event);
    },
  });
  t.after(attempt.close);
  async function waitFor<K extends CodexAttemptEvent["kind"]>(kind: K) {
    let ended = false;
    for (;;) {
      const current = events.find(
        (event): event is Extract<CodexAttemptEvent, { kind: K }> => event.kind === kind,
      );
      if (current) return current;
      if (ended) assert.fail(`Attempt ended before ${kind}`);
      ended = await Promise.race([
        once(updates, "update", { signal: t.signal }).then(() => false),
        attempt.finished.then(() => true),
      ]);
    }
  }
  return { attempt, events, waitFor };
}

test("routes two simultaneous requests with identical protocol IDs in reverse order", { timeout: 5_000 }, async t => {
  const root = await workspace(t);
  const firstDirectory = join(root, "ticket-a");
  const secondDirectory = join(root, "ticket-b");
  await Promise.all([mkdir(firstDirectory), mkdir(secondDirectory)]);
  const a = run(t, firstDirectory, "accept");
  const b = run(t, secondDirectory, "decline");
  const [first, second] = await Promise.all([
    a.waitFor("approval-requested"),
    b.waitFor("approval-requested"),
  ]);
  assert.notEqual(first.approval.id, second.approval.id);
  assert.equal(a.attempt.answer(second.approval.id, "accept"), false);
  assert.equal(b.attempt.answer(second.approval.id, "decline"), true);
  assert.equal(b.attempt.answer(second.approval.id, "accept"), false);
  assert.equal(await b.attempt.finished, "completed");
  assert.equal(a.attempt.answer(first.approval.id, "accept"), true);
  assert.equal(await a.attempt.finished, "completed");
  for (const { events } of [a, b]) {
    assert.deepEqual(events.map(event => event.kind), ["approval-requested", "approval-submitted", "approval-cleared"]);
  }
});

test("expires a request when Codex clears it before a decision", { timeout: 5_000 }, async t => {
  const { attempt, waitFor } = run(t, await workspace(t), "expired");
  const { approval } = await waitFor("approval-requested");
  await waitFor("approval-expired");
  assert.equal(attempt.answer(approval.id, "accept"), false);
});

test("requires reconciliation when the connection drops after sending an answer", { timeout: 5_000 }, async t => {
  const { attempt, events, waitFor } = run(t, await workspace(t), "lost-after-answer");
  const { approval } = await waitFor("approval-requested");
  assert.equal(attempt.answer(approval.id, "accept"), true);
  assert.equal(await attempt.finished, "needs-reconciliation");
  assert.equal(attempt.answer(approval.id, "accept"), false);
  assert.deepEqual(events.map(event => event.kind), ["approval-requested", "approval-submitted", "approval-uncertain"]);
});

test("expires pending approvals when a connection closes and rejects them on the next attempt", { timeout: 5_000 }, async t => {
  const directory = await workspace(t);
  const old = run(t, directory, "accept");
  const { approval } = await old.waitFor("approval-requested");
  old.attempt.close();
  assert.equal(await old.attempt.finished, "needs-reconciliation");
  assert.equal(old.events.at(-1)?.kind, "approval-expired");
  const next = run(t, directory, "accept");
  const current = await next.waitFor("approval-requested");
  assert.equal(next.attempt.answer(approval.id, "accept"), false);
  assert.equal(next.attempt.answer(current.approval.id, "accept"), true);
  assert.equal(await next.attempt.finished, "completed");
});

test("rejects unsupported requests before exposing an approval", { timeout: 5_000 }, async t => {
  const cases = [
    "foreign-thread", "early-foreign-turn", "network", "terminal-input",
    "additional-permissions", "outside-workspace", "unknown-type", "accept-only",
  ];
  for (const scenario of cases) {
    const { attempt, events } = run(t, await workspace(t), scenario);
    assert.equal(await attempt.finished, "completed", scenario);
    assert.deepEqual(events, [], scenario);
  }
});

test("exposes cancel separately and rejects a decline the server does not offer", { timeout: 5_000 }, async t => {
  const { attempt, waitFor } = run(t, await workspace(t), "cancel");
  const { approval } = await waitFor("approval-requested");
  assert.deepEqual(approval.availableDecisions, ["accept", "cancel"]);
  assert.equal(attempt.answer(approval.id, "decline"), false);
  assert.equal(attempt.answer(approval.id, "cancel"), true);
  assert.equal(await attempt.finished, "interrupted");
});

test("keeps the original choices for servers that omit available decisions", { timeout: 5_000 }, async t => {
  const { attempt, waitFor } = run(t, await workspace(t), "legacy");
  const { approval } = await waitFor("approval-requested");
  assert.deepEqual(approval.availableDecisions, ["accept", "decline"]);
  assert.equal(attempt.answer(approval.id, "cancel"), false);
  assert.equal(attempt.answer(approval.id, "decline"), true);
  assert.equal(await attempt.finished, "completed");
});

test("checks an early approval against the eventual turn/start response", { timeout: 5_000 }, async t => {
  const { attempt, waitFor } = run(t, await workspace(t), "early-current-turn");
  const { approval } = await waitFor("approval-requested");
  assert.equal(attempt.answer(approval.id, "accept"), true);
  assert.equal(await attempt.finished, "completed");
});

test("ignores foreign notifications and preserves a string request ID", { timeout: 5_000 }, async t => {
  const { attempt, events, waitFor } = run(t, await workspace(t), "foreign-notifications");
  const { approval } = await waitFor("approval-requested");
  assert.equal(attempt.answer(approval.id, "accept"), true);
  assert.equal(await attempt.finished, "completed");
  assert.deepEqual(events.map(event => event.kind), ["approval-requested", "approval-submitted", "approval-cleared"]);
});

test("closes the connection on conflicting reuse of a pending request ID", { timeout: 5_000 }, async t => {
  const { attempt, events, waitFor } = run(t, await workspace(t), "conflicting-id");
  const { approval } = await waitFor("approval-requested");
  assert.equal(await attempt.finished, "needs-reconciliation");
  assert.equal(attempt.answer(approval.id, "accept"), false);
  assert.deepEqual(events.map(event => event.kind), ["approval-requested", "approval-expired"]);
});

test("settles after a malformed handshake", { timeout: 5_000 }, async t => {
  const { attempt, events } = run(t, await workspace(t), "malformed");
  assert.equal(await attempt.finished, "failed");
  assert.deepEqual(events, []);
});

test("settles even if the event consumer throws during delivery and cleanup", { timeout: 5_000 }, async t => {
  const { attempt, events } = run(t, await workspace(t), "accept", () => { throw new Error("synthetic consumer failure"); });
  assert.equal(await attempt.finished, "needs-reconciliation");
  assert.deepEqual(events.map(event => event.kind), ["approval-requested", "approval-expired"]);
});
