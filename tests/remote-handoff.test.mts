import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { BusinessEvent, Checkpoint } from "../src/audit/activity-store.mts";
import { createRemoteHandoff, type RemoteDevice, type RemoteJob } from "../src/execution/remote-handoff.mts";
import { readRemoteFiles } from "../src/workbench/remote-worker-ingress.mts";

function checkpoint<T extends object>(events: BusinessEvent[]): Checkpoint<T> {
  const saved = new Map<string, T>();
  return {
    load: () => Array.from(saved.values(), row => structuredClone(row)),
    save(id, row, event) {
      if (event) events.push(structuredClone(event));
      saved.set(id, structuredClone(row));
      return true;
    },
  };
}

const revision = "a".repeat(40);
const text = "# 标题\n";
const sha256 = createHash("sha256").update(text).digest("hex");
const bytes = Buffer.byteLength(text);
const files = ["docs/one.md", "docs/two.md"].map(path => ({ path, text, sha256, bytes }));
const receipt = { sha256, bytes, headings: 1 };

test("只允许绑定设备领取，重启及断线后继续同一工单，重复回执只写一次", () => {
  const events: BusinessEvent[] = [];
  const devices = checkpoint<RemoteDevice>(events);
  const jobs = checkpoint<RemoteJob>(events);
  let time = 1000;
  const restore = () => createRemoteHandoff(devices, jobs, 10, () => time);
  let hub = restore();
  const first = hub.addDevice("第二台 Mac", "implementer");
  const other = hub.addDevice("备用 Mac", "implementer");
  assert.equal(first.status, 201);
  assert.equal(other.status, 201);
  if (first.status !== 201 || other.status !== 201) assert.fail();
  const { id, key } = first.bundle;
  const auth = `Bearer ${key}`;
  const instance = randomUUID();
  assert.equal(hub.poll(id, "Bearer invalid", { instance }).status, 401);
  assert.equal(hub.snapshot().devices[0]?.status, "pending");
  const job = hub.enqueue(id, revision, files, "implementer");
  assert.equal(job.status, 201);
  if (job.status !== 201) assert.fail();
  assert.equal(hub.enqueue(id, revision, files, "implementer").status, 409);
  assert.equal(hub.poll(other.bundle.id, `Bearer ${other.bundle.key}`, { instance }).status, 200);
  assert.equal(hub.poll(other.bundle.id, `Bearer ${other.bundle.key}`, { instance, update: {id: job.id, receipts: [receipt]} }).status, 409);
  const claimed = hub.poll(id, auth, { instance });
  assert.equal(claimed.status, 200);
  assert.deepEqual(hub.poll(id, auth, { instance }), claimed);
  assert.equal(hub.poll(id, auth, { instance: randomUUID() }).status, 409);
  const update = { instance, update: { id: job.id, receipts: [receipt] } };
  assert.equal(hub.poll(id, auth, update).status, 200);
  time += 15;
  assert.equal(hub.snapshot().devices.find(item => item.id === id)?.status, "offline");
  assert.equal(hub.snapshot().jobs[0]?.receipts.length, 1);
  hub = restore();
  assert.equal(hub.snapshot().devices.find(item => item.id === id)?.status, "offline");
  const resumed = hub.poll(id, auth, update);
  assert.deepEqual(resumed, { status: 200, task: { id: job.id, revision, files, receipts: [receipt] } });
  const finish = { instance, update: { id: job.id, receipts: [receipt, receipt] } };
  assert.deepEqual(hub.poll(id, auth, finish), { status: 200, task: null });
  assert.deepEqual(hub.poll(id, auth, finish), { status: 200, task: null });
  assert.equal(hub.snapshot().jobs[0]?.status, "ready");
  assert.ok(jobs.load()[0]?.files.every(file => file.text === undefined));
  assert.ok(!JSON.stringify(events).includes(key) && !JSON.stringify(hub.snapshot()).includes(key));
  assert.deepEqual(events.filter(event => event.kind === "remote.job").map(event => (event.details as {action: string}).action),
    ["queued", "claimed", "progress", "finished"]);
});

test("撤销设备后旧设备凭据无法继续领取或回传", () => {
  const events: BusinessEvent[] = [];
  const hub = createRemoteHandoff(checkpoint<RemoteDevice>(events), checkpoint<RemoteJob>(events), 1000);
  const created = hub.addDevice("test-device", "implementer");
  if (created.status !== 201) assert.fail();
  const { id, key } = created.bundle;
  const instance = randomUUID();
  assert.equal(hub.enqueue(id, revision, files, "implementer").status, 201);
  assert.equal(hub.poll(id, `Bearer ${key}`, { instance }).status, 200);
  assert.equal(hub.revoke(id, "implementer"), 200);
  assert.equal(hub.poll(id, `Bearer ${key}`, { instance }).status, 401);
  assert.equal(hub.enqueue(id, revision, files, "implementer").status, 404);
  assert.equal(hub.snapshot().jobs[0]?.status, "revoked");
});

test("远端核验只读取固定提交中的普通 Markdown，排除未提交内容和符号链接", async t => {
  const workspace = await mkdtemp(join(tmpdir(), "souflow-remote-files-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: workspace, encoding: "utf8" }).trim();
  await mkdir(join(workspace, "docs"));
  await writeFile(join(workspace, "docs/one.md"), text);
  await symlink("one.md", join(workspace, "docs/link.md"));
  git("init", "-q");
  git("add", "docs");
  git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--no-gpg-sign", "-qm", "fixture");
  await writeFile(join(workspace, "docs/one.md"), "未提交");
  assert.deepEqual(await readRemoteFiles(workspace, ["docs/one.md"]), {
    revision: git("rev-parse", "HEAD"), files: [{ path: "docs/one.md", text, bytes, sha256 }],
  });
  await assert.rejects(readRemoteFiles(workspace, ["docs/link.md"]));
  await assert.rejects(readRemoteFiles(workspace, ["../docs/one.md"]));
});
