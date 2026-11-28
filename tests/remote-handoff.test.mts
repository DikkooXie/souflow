import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { defaultAuditThresholds, openActivityStore, type BusinessEvent, type Checkpoint } from "../src/audit/activity-store.mts";
import { createRemoteHandoff, type RemoteDevice, type RemoteJob } from "../src/execution/remote-handoff.mts";
import { readRemoteFiles, remoteWorkerNetwork } from "../src/workbench/remote-worker-ingress.mts";

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

test("局域网继续可用，共享地址仅接受本机 Tailscale IPv4", async () => {
  let queries = 0;
  const readAddress = async () => {
    queries++;
    return "100.82.12.34";
  };

  for (const host of ["127.0.0.1", "10.0.0.1", "172.31.0.1", "192.168.0.1"]) {
    assert.equal(await remoteWorkerNetwork(host, readAddress), "lan", host);
  }
  for (const host of ["0.0.0.0", "::", "100.63.255.255", "100.128.0.0", "172.32.0.1", "192.168.0.256", "localhost", "8.8.8.8"]) {
    assert.equal(await remoteWorkerNetwork(host, readAddress), undefined, host);
  }
  assert.equal(queries, 0);

  assert.equal(await remoteWorkerNetwork("100.82.12.34", readAddress), "tailscale");
  assert.equal(await remoteWorkerNetwork("100.82.12.35", readAddress), undefined);
  for (const host of ["100.64.0.1", "100.127.255.254"]) {
    assert.equal(await remoteWorkerNetwork(host, async () => host), "tailscale", host);
  }
  assert.equal(await remoteWorkerNetwork("100.82.12.34", async () => { throw Error("Tailscale 未启动"); }), undefined);
});

test("工作台启动拒绝其他共享地址及与本机地址不符的证书", { skip: process.platform === "win32" }, async t => {
  const openssl = spawnSync("openssl", ["version"]);
  if ((openssl.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
    t.skip("生成一次性测试证书需要 OpenSSL");
    return;
  }
  assert.ifError(openssl.error);
  assert.equal(openssl.status, 0);
  const dir = await mkdtemp(join(tmpdir(), "souflow-tailscale-config-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  // 用不同的 IP SAN 验证启动入口确实检查证书，测试后删除一次性密钥。
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "worker-key.pem",
    "-out", "worker-cert.pem", "-days", "1", "-subj", "/CN=souflow-test", "-addext", "subjectAltName=IP:127.0.0.1"],
  { cwd: dir, stdio: "ignore", timeout: 5000 });
  await writeFile(join(dir, "tailscale"), "#!/bin/sh\n[ \"$*\" = 'ip -4' ] || exit 1\nprintf '%s\\n' 100.82.12.34\n", { mode: 0o700 });
  const entry = fileURLToPath(new URL("../src/workbench/demo-server.mts", import.meta.url));
  for (const [host, failure] of [["100.82.12.35", /确认的本机 Tailscale IPv4/], ["100.82.12.34", /IP SAN 必须包含本机 Tailscale IPv4/]] as const) {
    const result = spawnSync(process.execPath, ["--experimental-strip-types", entry, "--codex"], {
      cwd: dir, timeout: 5000, encoding: "utf8",
      env: { PATH: dir, SOULFLOW_DEMO_PORT: "0", SOULFLOW_LAN_BIND: host, SOULFLOW_LAN_PORT: "0",
        SOULFLOW_LAN_CERT_FILE: "worker-cert.pem", SOULFLOW_LAN_KEY_FILE: "worker-key.pem" },
    });
    assert.ifError(result.error);
    assert.equal(result.status, 1, host);
    assert.match(result.stderr, failure);
    assert.doesNotMatch(result.stdout, /决策收件箱/);
  }
});

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

test("AC-3 配对码过期失效，跨成员确认不消费原码，并发确认只绑定一次", async () => {
  const events: BusinessEvent[] = [];
  const devices = checkpoint<RemoteDevice>(events);
  let now = 1000;
  const hub = createRemoteHandoff(devices, checkpoint<RemoteJob>(events), 1000, () => now,
    event => { events.push(event); return true; });
  const expired = hub.startPairing("过期 Mac", "alice");
  assert.ok(expired.status === 201);
  now = expired.expiresAt;
  assert.equal(hub.confirmPairing(expired.code, "alice").status, 409);
  assert.equal(devices.load().length, 0);

  const pending = hub.startPairing("新人 Mac", "alice");
  const other = hub.startPairing("另一台 Mac", "bob");
  assert.ok(pending.status === 201 && other.status === 201);
  assert.equal(hub.confirmPairing(pending.code, "bob").status, 409);
  assert.equal(devices.load().length, 0);
  const results = await Promise.all([pending.code, pending.code].map(async code => {
    await Promise.resolve();
    return hub.confirmPairing(code, "alice");
  }));
  assert.deepEqual(results.map(result => result.status), [201, 409]);
  const [bound] = results;
  assert.ok(bound?.status === 201);
  const { id, key } = bound.bundle;
  assert.equal(hub.confirmPairing(pending.code, "alice").status, 409);
  assert.equal(hub.confirmPairing(other.code, "bob").status, 201);
  assert.deepEqual(devices.load().map(device => device.owner), ["alice", "bob"]);
  assert.equal(hub.ownsDevice(id, "alice"), true);
  assert.equal(hub.ownsDevice(id, "bob"), false);
  assert.equal(hub.revoke(id, "bob"), 404);
  assert.equal(hub.canAuthenticateCodeDevice(id, `Bearer ${key}`), true);
  assert.equal(hub.revoke(id, "alice"), 200);
  assert.equal(hub.ownsDevice(id, "alice"), false);
  assert.equal(hub.canAuthenticateCodeDevice(id, `Bearer ${key}`), false);
  assert.deepEqual(events.filter(event => event.subject === id).map(event => (event.details as { action: string }).action),
    ["pairing-started", "paired", "revoked"]);
  const audit = JSON.stringify(events);
  assert.ok(!audit.includes(pending.code) && !audit.includes(key));
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

test("历史过多时保留离线工单，重连完成后排在历史首位", () => {
  const events: BusinessEvent[] = [];
  let time = 0;
  const hub = createRemoteHandoff(checkpoint<RemoteDevice>(events), checkpoint<RemoteJob>(events), 10, () => time);
  const first = hub.addDevice("first", "implementer");
  const other = hub.addDevice("other", "implementer");
  if (first.status !== 201 || other.status !== 201) assert.fail();
  const worker = ({ id, key }: typeof first.bundle) => {
    const instance = randomUUID();
    return {
      enqueue: () => hub.enqueue(id, revision, files, "implementer"),
      poll: (update?: { id: string; receipts: typeof receipt[] }) => hub.poll(id, `Bearer ${key}`, { instance, update }),
    };
  };
  const slow = worker(first.bundle);
  const busy = worker(other.bundle);
  const job = slow.enqueue();
  if (job.status !== 201) assert.fail();
  assert.equal(slow.poll().status, 200);
  assert.equal(slow.poll({ id: job.id, receipts: [receipt] }).status, 200);
  for (let index = 0; index < 25; ++index) {
    ++time;
    const item = busy.enqueue();
    if (item.status !== 201) assert.fail();
    assert.equal(busy.poll().status, 200);
    assert.equal(busy.poll({ id: item.id, receipts: [receipt, receipt] }).status, 200);
  }
  const offline = hub.snapshot();
  assert.equal(offline.devices.find(device => device.id === first.bundle.id)?.status, "offline");
  assert.equal(offline.jobs.length, 25);
  assert.equal(offline.jobs[0]?.id, job.id);
  assert.equal(offline.jobs[0]?.receipts.length, 1);
  ++time;
  assert.equal(slow.poll({ id: job.id, receipts: [receipt, receipt] }).status, 200);
  const history = hub.snapshot().jobs;
  assert.equal(history.length, 24);
  assert.equal(history[0]?.id, job.id);
  assert.equal(history[0]?.status, "ready");
});

test("SQLite 审计关联设备心跳与工单回执，拒绝错误身份并去重", async t => {
  const directory = await mkdtemp(join(tmpdir(), "souflow-remote-audit-"));
  const path = join(directory, "audit.sqlite");
  let time = Date.now();
  const audit = openActivityStore(path, () => time, defaultAuditThresholds);
  const reader = new DatabaseSync(path, { readOnly: true });
  t.after(async () => {
    reader.close();
    audit.close();
    await rm(directory, { recursive: true, force: true });
  });
  const deviceStore = audit.checkpoint<RemoteDevice>("remote-devices");
  let deviceSaves = 0;
  let remainingFailures = 0;
  const hub = createRemoteHandoff({
    ...deviceStore,
    save(id, row, event) {
      ++deviceSaves;
      // 仅让携带本次通信时间的写入失败，以便发现提前写入的重连审计。
      if (remainingFailures > 0 && row.lastSeen === time) {
        --remainingFailures;
        return false;
      }
      return deviceStore.save(id, row, event);
    },
  }, audit.checkpoint<RemoteJob>("remote-jobs"), 10, () => time);
  const created = hub.addDevice("audit-device", "implementer");
  if (created.status !== 201) assert.fail();
  const { id, key } = created.bundle;
  const instance = randomUUID();
  const rawMessage = "private-remote-audit-message";
  const body = "# private-remote-audit-document\n";
  const proof = { sha256: createHash("sha256").update(body).digest("hex"), bytes: Buffer.byteLength(body), headings: 1 };
  const shippedFiles = files.map(file => ({ path: file.path, text: body, sha256: proof.sha256, bytes: proof.bytes }));
  const poll = (identity: string, update?: { id: string; receipts: typeof proof[] }) =>
    hub.poll(id, `Bearer ${key}`, { instance: identity, message: rawMessage, update });

  // 读取 SQLite 行的所有列，按业务事件类型筛出记录，避开需要续传文件正文的工单快照。
  const tables = reader.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all();
  const auditRows = () => tables.flatMap(({ name }) => {
    const table = String(name).replaceAll('"', '""');
    return reader.prepare(`SELECT * FROM "${table}"`).all().map(row => JSON.stringify(row, (_key, value: unknown) => {
      if (typeof value === "string" && value.startsWith("{")) return JSON.parse(value) as unknown;
      return value;
    }));
  }).filter(row => row.includes('"remote.device"') || row.includes('"remote.job"'));
  const event = (kind: string, action: string, subject: string) => auditRows().filter(row =>
    [kind, action, subject].every(value => row.includes(JSON.stringify(value))));
  function metadata(row: string | undefined, expected: Record<string, string | number>) {
    assert.ok(row);
    for (const [field, value] of Object.entries(expected)) {
      assert.ok(row.includes(`${JSON.stringify(field)}:${JSON.stringify(value)}`), `缺少审计字段 ${field}`);
    }
  }

  assert.deepEqual(poll(instance), { status: 200, task: null });
  const connections = event("remote.device", "connected", id);
  assert.equal(connections.length, 1);
  metadata(connections[0], { direction: "from-device", at: time });
  const heartbeat = () => event("remote.device", "heartbeat", id);
  assert.equal(heartbeat().length, 0);
  const heartbeatAt = ++time;
  assert.equal(poll(instance).status, 200);
  assert.equal(heartbeat().length, 1);
  metadata(heartbeat()[0], { direction: "from-device", at: heartbeatAt });
  ++time;
  assert.equal(poll(instance).status, 200);
  assert.equal(heartbeat().length, 1);
  assert.equal(hub.snapshot().devices.find(device => device.id === id)?.lastSeen, time);

  const job = hub.enqueue(id, revision, shippedFiles, "implementer");
  if (job.status !== 201) assert.fail();
  const claimedAt = ++time;
  assert.equal(poll(instance).status, 200);
  const claims = event("remote.job", "claimed", job.id);
  assert.equal(claims.length, 1);
  metadata(claims[0], { deviceId: id, direction: "to-device", at: claimedAt, received: 0 });
  const updates = () => auditRows().filter(row => ["remote.job", "from-device", job.id].every(value => row.includes(JSON.stringify(value))));
  assert.equal(updates().length, 0);
  const first = { id: job.id, receipts: [proof], message: rawMessage };
  ++time;
  assert.equal(poll(randomUUID(), first).status, 409);
  assert.equal(updates().length, 0);
  assert.equal(hub.snapshot().devices.find(device => device.id === id)?.lastSeen, claimedAt);
  assert.equal(poll(instance, first).status, 200);
  assert.equal(updates().length, 1);
  metadata(event("remote.job", "progress", job.id)[0], { deviceId: id, direction: "from-device", at: time, received: 1 });
  assert.equal(hub.snapshot().devices.find(device => device.id === id)?.lastSeen, time);
  ++time;
  assert.equal(poll(instance, first).status, 200);
  assert.equal(updates().length, 1);

  const finish = { id: job.id, receipts: [proof, proof], message: rawMessage };
  ++time;
  const results = await Promise.all([first, finish].map(() => Promise.resolve().then(() => poll(instance, finish))));
  assert.deepEqual(results, [{ status: 200, task: null }, { status: 200, task: null }]);
  assert.equal(updates().length, 2);
  metadata(event("remote.job", "finished", job.id)[0], { deviceId: id, direction: "from-device", at: time, received: 2 });
  const deviceState = () => hub.snapshot().devices.find(device => device.id === id);
  const savedDevice = () => deviceStore.load().find(device => device.id === id);
  const reconnected = () => event("remote.device", "reconnected", id);
  const previous = savedDevice();
  assert.equal(previous?.instance, instance);
  assert.equal(previous?.lastSeen, time);
  time += 11;
  const offline = deviceState();
  assert.equal(offline?.status, "offline");
  assert.equal(offline?.lastSeen, previous?.lastSeen);
  assert.equal(reconnected().length, 0);

  remainingFailures = 2;
  const savesBeforeReconnect = deviceSaves;
  for (let attempt = 1; attempt <= 2; ++attempt) {
    assert.deepEqual(poll(instance), { status: 503 });
    assert.deepEqual(deviceState(), offline);
    assert.deepEqual(savedDevice(), previous);
    assert.equal(reconnected().length, 0);
    assert.equal(deviceSaves, savesBeforeReconnect + attempt);
    ++time;
  }

  assert.deepEqual(poll(instance), { status: 200, task: null });
  assert.equal(deviceSaves, savesBeforeReconnect + 3);
  assert.deepEqual(deviceState(), { ...offline, status: "online", lastSeen: time });
  assert.deepEqual(savedDevice(), { ...previous, instance, lastSeen: time });
  assert.equal(reconnected().length, 1);
  metadata(reconnected()[0], { direction: "from-device", at: time });
  assert.equal(heartbeat().length, 1);
  ++time;
  assert.equal(poll(instance).status, 200);
  assert.equal(reconnected().length, 1);
  assert.equal(heartbeat().length, 2);

  const logged = auditRows().join("\n");
  for (const privateValue of [key, rawMessage, body.trim()]) assert.ok(!logged.includes(privateValue));
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
