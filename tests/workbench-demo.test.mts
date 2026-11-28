import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import test, { type TestContext } from "node:test";
import { currentDevelopmentPlan, type Flow, maxArtifactTextLength } from "../src/planning/conversation-flow.mts";
import type { createLocalDispatch } from "../src/execution/local-dispatch.mts";
import { createWorkbenchServer } from "../src/workbench/demo-server.mts";
import type { createDecisionDemo } from "../src/workbench/demo-state.mts";
import { passingQualityReview, qualityReviewOutput, validation } from "./fixtures/planning-quality.mts";

type Snapshot = ReturnType<ReturnType<typeof createDecisionDemo>["snapshot"]> & {
  flows: (Flow & { canReplan?: boolean })[];
  dispatches: (ReturnType<ReturnType<typeof createLocalDispatch>["list"]>[number] & {
    acceptance?: { decision: string; actor: { id: string }; note: string }[];
  })[];
  inputLimits: { promptMaxLength: number; answerMaxLength: number };
};

async function start(t: TestContext, live?: Parameters<typeof createWorkbenchServer>[1],
  options?: Parameters<typeof createWorkbenchServer>[3], auditPath?: string) {
  const server = createWorkbenchServer(100, live, auditPath, { qualityReviewer: passingQualityReview, ...options });
  let closing: Promise<unknown> | undefined;
  function close() {
    if (closing) return closing;
    closing = once(server, "workbenchClosed");
    server.close();
    server.closeAllConnections();
    return closing;
  }
  t.after(async () => { await close(); });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const url = `http://127.0.0.1:${address.port}`;
  const post = (path: string, body?: object, origin = url, authorization?: string) => fetch(url + path, {
    method: "POST", headers: { origin, ...(body ? { "Content-Type": "application/json" } : {}), ...(authorization ? { authorization } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const read = async (authorization?: string): Promise<Snapshot> => {
    const response = await fetch(`${url}/api/decisions`, authorization ? { headers: { authorization } } : undefined);
    assert.equal(response.status, 200);
    return response.json();
  };
  return { url, post, read, close };
}

async function loadWorkbenchPage(hash = "") {
  function element() {
    const button = { disabled: false };
    return Object.assign(new EventTarget(), {
      value: "", textContent: "", hidden: false, dataset: {}, childElementCount: 0,
      querySelector: () => button, querySelectorAll: () => [], contains: () => false,
      append() {}, replaceChildren() {}, setAttribute() {}, removeAttribute() {},
    });
  }
  const elements = new Map<string, ReturnType<typeof element>>();
  function get(selector: string) {
    const entry = elements.get(selector) ?? element();
    elements.set(selector, entry);
    return entry;
  }
  const prompt = get("#new-prompt");
  const form = Object.assign(get("#start-session"), { reset() { prompt.value = ""; } });
  const pending: { path: string; send: (status: number, data?: unknown) => void }[] = [];
  let tick: (() => void) | undefined;
  const panel = () => ({ update() {}, setAvailable() {}, navigate() {} });
  const source = await readFile(new URL("../src/workbench/public/app.mjs", import.meta.url), "utf8");
  runInNewContext(source.replace(/^import .*;\n/gm, ""), {
    document: Object.assign(element(), { querySelector: get, createElement: element }),
    window: new EventTarget(), location: { hash }, matchMedia: () => new EventTarget(), AbortSignal,
    createArchive: panel, createAuditView: panel, createDispatchPanel: panel,
    createMonitorView: panel, createGithubPanel: panel, renderDeliveryReviews() {}, renderQualityDetails() {},
    setTimeout(callback: () => void) { tick = callback; },
    clearTimeout() { tick = undefined; },
    fetch: (path: string) => new Promise(resolve => pending.push({ path,
      send: (status, data) => resolve({ status, ok: status === 200, json: async () => data }),
    })),
  });
  function take(path = "/api/decisions") {
    const request = pending.shift();
    assert.equal(request?.path, path);
    assert.ok(request);
    return async (status: number, data?: unknown) => {
      request.send(status, data);
      await new Promise<void>(resolve => setImmediate(resolve));
    };
  }
  return { get, prompt, form, take, poll() { assert.ok(tick); tick(); return take(); }, submit() {
    form.dispatchEvent(new Event("submit", { cancelable: true }));
    return take("/api/workflows");
  } };
}

function memberSnapshot(login?: string, flowId?: string) {
  return { mode: "codex", requests: [], inputLimits: { promptMaxLength: 4000, answerMaxLength: 500 },
    member: login ? { id: "implementer", login, label: login } : undefined, flowId,
    flows: flowId ? [{ id: flowId, title: flowId, prompt: flowId, status: "ready", outputs: [] }] : [],
  };
}

test("AC-3 直接打开个人主页时首次读取失败，重试恢复当前成员", async () => {
  const page = await loadWorkbenchPage("#personal");
  const status = page.get("#personal-status");
  const identity = page.get("#personal-identity");
  const olderSnapshot = page.take();
  assert.equal(page.get("#personal-home").hidden, false);
  assert.match(status.textContent, /正在读取/);
  await page.poll()(503);
  assert.equal(status.hidden, false);
  assert.match(status.textContent, /无法读取.*重试/);
  await olderSnapshot(200, memberSnapshot("alice"));
  assert.equal(identity.hidden, true);
  assert.equal(identity.textContent, "");
  assert.equal(page.get("#member-label").hidden, true);
  await page.poll()(200, memberSnapshot("bob"));
  assert.equal(status.hidden, true);
  assert.equal(identity.hidden, false);
  assert.equal(identity.textContent, "bob");
  assert.equal(page.get("#personal-devices").hidden, false);
});

test("AC-3 同一成员保留草稿，切换成员或登出清空草稿", async () => {
  const page = await loadWorkbenchPage();
  const label = page.get("#member-label");
  await page.take()(200, memberSnapshot("alice", "甲的对话"));
  page.prompt.value = "甲的未提交需求";
  await page.poll()(200, memberSnapshot("alice", "甲的对话"));
  assert.equal(page.prompt.value, "甲的未提交需求");

  const oldUnauthorized = page.poll();
  await page.poll()(200, memberSnapshot("bob"));
  assert.equal(label.textContent, "bob");
  assert.equal(page.prompt.value, "");
  assert.equal(page.get("#conversation").hidden, true);
  page.prompt.value = "乙的未提交需求";
  await oldUnauthorized(401);
  assert.equal(label.textContent, "bob");
  assert.equal(page.prompt.value, "乙的未提交需求");

  await page.poll()(200, memberSnapshot());
  assert.equal(label.hidden, true);
  assert.equal(page.prompt.value, "");
  await page.poll()(200, memberSnapshot("alice"));
  assert.equal(label.textContent, "alice");
  assert.equal(page.prompt.value, "");
});

test("AC-3 先返回的轮询切换成员，后返回的当前 401 清空身份", async () => {
  const page = await loadWorkbenchPage();
  const label = page.get("#member-label");
  await page.take()(200, memberSnapshot("alice"));

  const switched = page.poll();
  const unauthorized = page.poll();
  await switched(200, memberSnapshot("bob"));
  assert.equal(label.textContent, "bob");
  assert.equal(page.form.hidden, false);

  await unauthorized(401);
  assert.equal(label.textContent, "");
  assert.equal(label.hidden, true);
  assert.equal(page.form.hidden, true);
});

test("AC-3 早一条 401 先清理身份，晚一条成功响应恢复切换后的成员", async () => {
  const page = await loadWorkbenchPage("#personal");
  const identity = page.get("#personal-identity");
  await page.take()(200, memberSnapshot("alice", "甲的对话"));
  page.prompt.value = "甲的未提交需求";
  const unauthorized = page.poll();
  const switched = page.poll();
  await unauthorized(401);
  assert.equal(identity.hidden, true);
  assert.equal(page.prompt.value, "");
  await switched(200, memberSnapshot("bob"));
  assert.equal(identity.hidden, false);
  assert.equal(identity.textContent, "bob");
  assert.equal(page.prompt.value, "");
});

test("AC-3 401 后在途旧成员成功响应不恢复身份，重新读取确认后才恢复", async () => {
  const page = await loadWorkbenchPage("#personal");
  const identity = page.get("#personal-identity");
  await page.take()(200, memberSnapshot("alice"));
  const unauthorized = page.poll();
  const stale = page.poll();
  await unauthorized(401);
  await stale(200, memberSnapshot("alice", "已失效的对话"));
  assert.equal(identity.hidden, true);
  assert.equal(page.get("#conversation").hidden, true);
  await page.poll()(200, memberSnapshot("alice"));
  assert.equal(identity.hidden, false);
  assert.equal(identity.textContent, "alice");
});

test("AC-3 迟到的轮询保留当前提交和新对话，当前 401 清理成员状态", async () => {
  const page = await loadWorkbenchPage();
  const label = page.get("#member-label");
  await page.take()(200, memberSnapshot("alice"));
  let finishOldSnapshot!: (data: unknown) => void;
  await page.poll()(200, new Promise(resolve => { finishOldSnapshot = resolve; }));
  const oldUnauthorized = page.poll();
  page.prompt.value = "待提交需求";
  const submitted = page.submit();
  await oldUnauthorized(401);
  assert.equal(page.form.querySelector().disabled, true);
  assert.equal(page.prompt.value, "待提交需求");
  assert.equal(label.textContent, "alice");

  await submitted(200, memberSnapshot("bob", "新对话"));
  page.prompt.value = "下一项需求";
  finishOldSnapshot(memberSnapshot("alice", "旧对话"));
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(label.textContent, "bob");
  assert.equal(page.get("#conversation").hidden, false);
  assert.equal(page.get("#conversation-message").textContent, "新对话");
  assert.equal(page.prompt.value, "下一项需求");
  assert.equal(page.form.querySelector().disabled, false);

  const oldSuccess = page.poll();
  await page.submit()(401);
  await oldSuccess(200, memberSnapshot("bob", "新对话"));
  assert.equal(label.hidden, true);
  assert.equal(page.form.hidden, true);
  assert.equal(page.prompt.value, "");
  assert.equal(page.get("#conversation").hidden, true);
});

async function withAuditWriteBlocked(path: string, check: () => Promise<void>) {
  const writer = new DatabaseSync(path);
  try {
    writer.exec("BEGIN IMMEDIATE");
    await check();
  } finally {
    writer.close();
  }
}

test("复核拦截后只有原发起者能在同一对话重规划，旧批次无法启动", { timeout: 10000 }, async t => {
  const repo = await mkdtemp(join(tmpdir(), "souflow-replan-"));
  t.after(() => rm(repo, { recursive: true, force: true }));
  const file = "docs/guide.md";
  await mkdir(join(repo, "docs"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo });
  git("init", "-q");
  async function revision(text: string) {
    await writeFile(join(repo, file), text);
    git("add", file);
    git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--no-gpg-sign", "-qm", text);
    return git("rev-parse", "HEAD").toString().trim();
  }
  const oldBase = await revision("旧指引");
  const keys = { implementer: "a".repeat(32), reviewer: "b".repeat(32), second: "c".repeat(32) };
  const credential = (actor: keyof typeof keys) => `Basic ${Buffer.from(`${actor}:${keys[actor]}`).toString("base64")}`;
  const terminal = { finished: Promise.resolve("completed" as const), close() {}, answerQuestions: () => false };
  const server = await start(t, [repo, options => ({ ...terminal,
    output: () => JSON.stringify(Object.fromEntries(((options.outputSchema?.required ?? []) as string[]).map(field => [field, `正文 ${field}`]))),
  })], { members: { implementer: keys.implementer, reviewer: keys.reviewer, additionalImplementers: { second: keys.second } },
    project: { planPath: file }, dispatchAdapters: {
      split: () => ({ ...terminal, output: () => JSON.stringify({ tickets: [{ id: "T1", title: "修改指引", instructions: "补齐测试",
        criteria: ["AC-1"], dependsOn: [], sources: [], editPaths: [file], validation }] }) }),
      execute: () => assert.fail("旧批次不得启动"),
    }, async qualityReviewer(packet) {
      return JSON.stringify({ ...qualityReviewOutput(packet), scope: { status: "block", summary: "缺少前置登录入口",
        evidence: [{ ref: "request", quote: "更新使用指引" }] } });
    },
  }, join(repo, "audit.sqlite"));
  const post = (actor: keyof typeof keys, path: string, body?: object) => server.post(path, body, server.url, credential(actor));
  const read = (actor: keyof typeof keys = "implementer") => server.read(credential(actor));
  async function waitFor<T>(find: (snapshot: Snapshot) => T | undefined): Promise<T> {
    for (let index = 0; index < 100; index++) {
      const value = find(await read());
      if (value !== undefined) return value;
      await delay(20);
    }
    throw Error("等待重规划超时");
  }
  assert.equal((await post("implementer", "/api/workflows", { prompt: "更新使用指引" })).status, 200);
  const flow = await waitFor(state => state.flows.find(item => item.status === "ready"));
  assert.equal(flow.requestedBy, "implementer");
  assert.equal(flow.project?.repository?.revision, oldBase);
  const entry = `/api/workflows/${flow.id}`;
  assert.equal((await post("implementer", `${entry}/local-dispatch/prepare`, { kind: "code" })).status, 200);
  const run = await waitFor(state => state.dispatches.find(item => item.status === "failed"));
  async function checkMonitorHistory() {
    const response = await fetch(`${server.url}/api/dispatch-status`, { headers: { authorization: credential("implementer") } });
    assert.equal(response.status, 200);
    const status = await response.json() as { waiting: { batchId: string }[]; jobs: {
      batchId: string; ticketId: string; planVersion: number; status: string; blockedByBatch?: boolean; waitingOn: string[];
    }[] };
    assert.equal(status.waiting.some(job => job.batchId === run.id), false);
    const history = status.jobs.find(job => job.batchId === run.id && job.ticketId === "T1");
    assert.ok(history);
    assert.equal(history.status, "blocked");
    assert.equal(history.blockedByBatch, true);
    assert.equal(history.planVersion, 1);
    assert.deepEqual(history.waitingOn, []);
  }
  await checkMonitorHistory();
  assert.equal((await read()).flows[0]?.canReplan, true);
  assert.equal((await read("second")).flows[0]?.canReplan, undefined);
  assert.equal((await post("second", `${entry}/replan`)).status, 409);
  assert.equal((await post("reviewer", `${entry}/replan`)).status, 403);
  const newBase = await revision("已有登录证据");
  assert.equal((await post("implementer", `${entry}/replan`)).status, 200);
  const updated = await waitFor(state => state.flows.find(item => item.status === "ready" && currentDevelopmentPlan(item)?.version === 2));
  assert.equal(updated.id, flow.id);
  assert.equal(updated.project?.repository?.revision, newBase);
  assert.equal(updated.replan?.batchId, run.id);
  assert.equal(updated.canReplan, undefined);
  await checkMonitorHistory();
  assert.equal((await post("implementer", `${entry}/local-dispatch/start`, { id: run.id })).status, 409);
});

test("two authenticated members return a code delivery and accept only the revised batch", { timeout: 10000 }, async t => {
  const repo = await mkdtemp(join(tmpdir(), "souflow-member-workbench-"));
  const runDirectories = new Set<string>();
  t.after(async () => {
    await Promise.all([...runDirectories, repo].map(path => rm(path, { recursive: true, force: true })));
  });
  const file = "docs/guide.md";
  const auditPath = join(repo, "audit.sqlite");
  await mkdir(join(repo, "docs"));
  await writeFile(join(repo, file), "草稿\n");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "ignore" });
  git("init", "-q");
  git("add", "docs");
  git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--no-gpg-sign", "-qm", "fixture");
  const terminal = { finished: Promise.resolve("completed" as const), close() {}, answerQuestions: () => false };
  const members = { implementer: "a".repeat(32), reviewer: "b".repeat(32) };
  const credential = (member: keyof typeof members) => `Basic ${Buffer.from(`${member}:${members[member]}`).toString("base64")}`;
  const launch = () => start(t, [repo, options => ({
    ...terminal,
    output: () => JSON.stringify(Object.fromEntries(((options.outputSchema?.required ?? []) as string[]).map(field => [field, `示例${field}`]))),
  })], { members, dispatchAdapters: {
    split(options) {
      const revised = options.prompt.includes("补齐验收步骤");
      return { ...terminal, output: () => JSON.stringify({ tickets: [{
        id: "T1", title: "编写指引", instructions: revised ? "修改后交付" : "提交初稿",
        criteria: ["AC-1"], dependsOn: [], sources: [], editPaths: [file], validation,
      }] }) };
    },
    execute(options) {
      runDirectories.add(join(options.workspace, "..", ".."));
      return { ...terminal, output: () => JSON.stringify({ report: "交付指引",
        edits: [{ path: file, before: "草稿", after: options.prompt.includes("修改后交付") ? "带验收步骤的指引" : "初稿" }],
      }) };
    },
  } }, auditPath);
  let server = await launch();
  const write = async (actor: keyof typeof members, path: string, payload?: object) => (await server.post(path, payload, server.url, credential(actor))).status;
  async function waitFor<T>(find: (snapshot: Snapshot) => T | undefined): Promise<T> {
    for (let index = 0; index < 100; index++) {
      const value = find(await server.read(credential("reviewer")));
      if (value !== undefined) return value;
      await delay(20);
    }
    throw Error("等待批次状态超时");
  }
  const noIdentity = await fetch(server.url);
  assert.equal(noIdentity.status, 401);
  assert.match(noIdentity.headers.get("www-authenticate") ?? "", /^Basic /);
  assert.equal((await fetch(`${server.url}/api/decisions`)).status, 401);
  assert.equal((await fetch(`${server.url}/api/audit`)).status, 401);
  assert.equal((await fetch(`${server.url}/api/dispatch-status`)).status, 401);
  for (const actor of ["implementer", "reviewer"] as const) {
    const monitor = await fetch(`${server.url}/api/dispatch-status`, { headers: { authorization: credential(actor) } });
    assert.equal(monitor.status, 200);
  }
  assert.equal((await server.post("/api/workflows", { prompt: "跳过登录" })).status, 401);
  assert.equal((await server.post("/api/workflows", { prompt: "交换密钥" }, server.url,
    `Basic ${Buffer.from(`implementer:${members.reviewer}`).toString("base64")}`)).status, 401);
  assert.equal(await write("reviewer", "/api/workflows", { prompt: "越权创建" }), 403);
  assert.equal(await write("implementer", "/api/workflows", { prompt: "更新使用指引" }), 200);
  const flow = await waitFor(snapshot => snapshot.flows.find(item => item.status === "ready"));
  const dispatch = `/api/workflows/${flow.id}/local-dispatch`;
  const revise = `/api/workflows/${flow.id}/plan/revise`;
  const note = { note: "已核对交付" };
  assert.equal(await write("reviewer", `${dispatch}/prepare`, { kind: "code" }), 403);
  assert.equal(await write("reviewer", revise, { version: 1, text: "越权改写" }), 403);
  async function finish(version: number) {
    assert.equal(await write("implementer", `${dispatch}/prepare`, { kind: "code" }), 200);
    const ready = await waitFor(snapshot => snapshot.dispatches.find(run => run.plan.version === version && run.status === "ready"));
    assert.equal(await write("implementer", `${dispatch}/start`, { id: ready.id }), 200);
    return waitFor(snapshot => snapshot.dispatches.find(run => run.id === ready.id && run.status === "finished"));
  }
  const first = await finish(1);
  const old = `/api/acceptance/${first.id}`;
  assert.equal(await write("reviewer", `${old}/submit`, note), 403);
  assert.equal(await write("reviewer", `${old}/accept`, note), 409);
  assert.equal(await write("implementer", `${old}/submit`, { note: " " }), 422);
  const firstSubmit = await Promise.all([write("implementer", `${old}/submit`, note), write("implementer", `${old}/submit`, note)]);
  assert.deepEqual(firstSubmit.sort(), [200, 409]);
  assert.equal(await write("implementer", `${old}/return`, note), 403);
  assert.equal(await write("implementer", `${old}/accept`, note), 403);
  assert.equal(await write("implementer", revise, { version: 1, text: "试图换掉待验收版本" }), 409);
  assert.equal(await write("reviewer", `${old}/return`, { note: "补齐验收步骤" }), 200);
  assert.equal(await write("reviewer", `${old}/accept`, note), 409);
  assert.equal(await write("implementer", `${old}/submit`, note), 409);
  assert.equal(await write("implementer", `${dispatch}/prepare`, { kind: "report" }), 409);
  assert.equal(await write("implementer", `${dispatch}/start`, { id: first.id }), 409);
  assert.equal(await write("implementer", revise, { version: 1, text: "补齐验收步骤" }), 200);
  assert.equal(await write("implementer", `${dispatch}/start`, { id: first.id }), 409);
  const second = await finish(2);
  const next = `/api/acceptance/${second.id}`;
  assert.notEqual(first.jobs[0]?.artifact?.patchSha256, second.jobs[0]?.artifact?.patchSha256);
  assert.equal(await write("implementer", `${next}/submit`, note), 200);
  await server.close();
  server = await launch();
  const restored = await waitFor(snapshot => snapshot.dispatches.find(run => run.id === second.id));
  assert.deepEqual(restored.acceptance?.map(receipt => [receipt.actor.id, receipt.decision]), [["implementer", "submitted"]]);
  assert.equal(await write("implementer", `${next}/accept`, note), 403);
  const patch = second.jobs[0]?.patchPath;
  assert.ok(patch);
  const originalPatch = await readFile(patch);
  await writeFile(patch, "被替换的文件");
  assert.equal(await write("reviewer", `${next}/accept`, note), 409);
  await writeFile(patch, originalPatch);
  await withAuditWriteBlocked(auditPath, async () => {
    assert.equal(await write("reviewer", `${next}/accept`, note), 503);
    const stuck = await waitFor(snapshot => snapshot.dispatches.find(run => run.id === second.id));
    assert.deepEqual(stuck.acceptance?.map(receipt => receipt.decision), ["submitted"]);
  });
  assert.equal(await write("reviewer", `${next}/accept`, note), 200);
  assert.equal(await write("reviewer", `${next}/return`, note), 409);
  assert.equal(await write("implementer", revise, { version: 2, text: "试图换掉已验收版本" }), 409);
  const audit = await (await fetch(`${server.url}/api/audit`, { headers: { authorization: credential("reviewer") } })).json();
  assert.deepEqual(audit.recent.filter((event: { kind: string }) => event.kind === "acceptance.decided")
    .map((event: { subject: string; details: { decision: string; actor: { id: string } } }) => [event.subject, event.details.decision, event.details.actor.id]),
  [[second.id, "accepted", "reviewer"], [second.id, "submitted", "implementer"],
    [first.id, "returned", "reviewer"], [first.id, "submitted", "implementer"]]);
  assert.doesNotMatch(JSON.stringify(audit), new RegExp(`${members.implementer}|${members.reviewer}`));
});

test("两名成员不能覆盖同版 PRD，旧开发计划不可派发，改版关系可在重启后回读", async t => {
  const repo = await mkdtemp(join(tmpdir(), "souflow-document-revision-"));
  t.after(() => rm(repo, { recursive: true, force: true }));
  const file = "docs/guide.md";
  await mkdir(join(repo, "docs"));
  await writeFile(join(repo, file), "设备接入说明\n");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "ignore" });
  git("init", "-q");
  git("add", file);
  git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--no-gpg-sign", "-qm", "fixture");
  const credentials = { implementer: "a".repeat(32), reviewer: "b".repeat(32), second: "c".repeat(32) };
  const auth = (actor: keyof typeof credentials) => `Basic ${Buffer.from(`${actor}:${credentials[actor]}`).toString("base64")}`;
  const terminal = { finished: Promise.resolve("completed" as const), close() {}, answerQuestions: () => false };
  const launch = () => start(t, [repo, options => ({ ...terminal,
    output: () => JSON.stringify(Object.fromEntries(((options.outputSchema?.required ?? []) as string[])
      .map(field => [field, `原版 ${field}`]))),
  })], { members: { implementer: credentials.implementer, reviewer: credentials.reviewer,
    additionalImplementers: { second: credentials.second } }, dispatchAdapters: {
    split: () => ({ ...terminal, output: () => JSON.stringify({ tickets: [{
      id: "T1", title: "核验接入说明", instructions: "核对引导内容", criteria: ["AC-1"], dependsOn: [], sources: [file],
    }] }) }),
    execute: () => assert.fail("旧批次不得启动"),
  } }, join(repo, "audit.sqlite"));
  let server = await launch();
  const send = (actor: keyof typeof credentials, path: string, body: object) => server.post(path, body, server.url, auth(actor));
  const read = async () => (await server.read(auth("implementer"))).flows[0];
  assert.equal((await send("implementer", "/api/workflows", { prompt: "新增设备绑定" })).status, 200);
  let flow = await read();
  for (let index = 0; flow?.status !== "ready" && index < 100; index++) {
    await delay(20);
    flow = await read();
  }
  assert.equal(flow?.status, "ready");
  const entry = `/api/workflows/${flow.id}`;
  const prdPath = `${entry}/prd/revise`;
  const planPath = `${entry}/plan/revise`;
  const originalPlan = currentDevelopmentPlan(flow);
  const originalPrd = flow.outputs.flatMap(output => output.artifacts).find(artifact => artifact.kind === "prd");
  assert.ok(originalPlan && originalPrd);
  const dispatchPath = `${entry}/local-dispatch`;
  assert.equal((await send("implementer", `${dispatchPath}/prepare`, { kind: "report" })).status, 200);
  let batch = (await server.read(auth("implementer"))).dispatches[0];
  for (let index = 0; batch?.status === "preparing" && index < 100; index++) {
    await delay(20);
    batch = (await server.read(auth("implementer"))).dispatches[0];
  }
  assert.equal(batch?.status, "ready");
  assert.equal((await send("reviewer", prdPath, { version: 1, text: "越权写入" })).status, 403);
  const options = ["# 第一个成员保存", "# 第二个成员保存"];
  const results = await Promise.all(options.map((value, index) =>
    send(index === 0 ? "implementer" : "second", prdPath, { version: 1, text: value })));
  assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
  const won = options[results.findIndex(result => result.status === 200)];
  assert.equal((await send("implementer", `${dispatchPath}/prepare`, { kind: "report" })).status, 409);
  assert.equal((await send("implementer", `${dispatchPath}/start`, { id: batch.id })).status, 409);
  assert.equal((await send("implementer", planPath, { version: 1, prdVersion: 1, text: "旧版表单" })).status, 409);
  assert.equal((await send("implementer", planPath, { version: 1, text: "缺少 PRD 版本" })).status, 409);
  await server.close();
  server = await launch();
  const afterRestart = await read();
  assert.ok(afterRestart);
  assert.equal(currentDevelopmentPlan(afterRestart), undefined);
  assert.equal(afterRestart.planHistory?.find(item => item.kind === "prd")?.sections[0]?.text, originalPrd.sections[0]?.text);
  const prd = afterRestart.outputs.flatMap(output => output.artifacts).find(artifact => artifact.kind === "prd");
  assert.deepEqual(prd?.upstream, originalPrd.upstream);
  assert.deepEqual(prd?.replaces, { id: originalPrd.id, version: 1 });
  assert.equal(prd?.sections[0]?.text, won);
  const text = "# 与第二版 PRD 对齐的计划";
  assert.equal((await send("implementer", planPath, { version: 1, prdVersion: 2, text })).status, 200);
  const revised = await read();
  assert.ok(revised);
  const newPlan = currentDevelopmentPlan(revised);
  assert.deepEqual(newPlan?.upstream, originalPlan.upstream.map(parent => parent.id === originalPrd.id ? { ...parent, version: 2 } : parent));
  assert.equal(newPlan?.sections[0]?.text, text);
  assert.deepEqual(newPlan?.replaces, { id: originalPlan.id, version: 1 });
  assert.equal(revised.planHistory?.find(item => item.kind === "development-plan")?.upstream[0]?.version, 1);
  assert.equal(revised.planHistory?.find(item => item.kind === "ticket-drafts")?.upstream[0]?.version, 1);
});

test("项目文档 Markdown 支持常用格式，内嵌 HTML 与图片无法加载", async t => {
  const { url } = await start(t);
  const asset = await fetch(`${url}/vendor/markdown-it.mjs`);
  assert.equal(asset.status, 200);
  assert.match(asset.headers.get("content-type") ?? "", /text\/javascript/);
  const markdownModule = new URL("../src/workbench/public/document-markdown.mjs", import.meta.url).href;
  const { createDocumentMarkdown } = await import(markdownModule);
  const { default: MarkdownIt } = await import("markdown-it/browser");
  const render = createDocumentMarkdown(MarkdownIt);
  const formatted = render(["# 概要", "", "- 步骤", "", "| 工单 |", "| --- |", "| 接入 |", "", "    code",
    "", "[文档](https://example.com)"].join("\n"));
  for (const fragment of ["<h1>概要</h1>", "<li>步骤</li>", "<table>", "<pre><code>code", 'href="https://example.com"']) {
    assert.ok(formatted.includes(fragment), fragment);
  }
  assert.equal(render("旧纯文本\n第二行"), "<p>旧纯文本<br>\n第二行</p>\n");
  const safe = render("<script>示例</script> <img src=x onerror=example> ![图片](https://example.com/image) [链接](javascript&#x3a;example) [外部](file:///etc/example)");
  assert.match(safe, /&lt;script&gt;示例&lt;\/script&gt;/);
  assert.doesNotMatch(safe, /<(?:script|img)\b|href="(?:javascript|file):/i);
});

test("the decision inbox routes answers to the selected session and records one receipt", async t => {
  const { url, post, read } = await start(t);
  const page = await fetch(url);
  assert.match(await page.text(), /决策收件箱/);
  const [first, second] = (await read()).requests;
  assert.ok(first && second);
  const secondAnswer = ["/api/decisions", second.id, "answer"].join("/");
  const firstAnswer = ["/api/decisions", first.id, "answer"].join("/");
  const answer = { scope: "当前筛选结果" };
  assert.equal((await post(secondAnswer, { language: "TypeScript" })).status, 422);
  assert.equal((await post(secondAnswer, { scope: "所有项目" })).status, 422);
  assert.equal((await post(secondAnswer, answer, "https://example.test")).status, 403);
  const results = await Promise.all([post(secondAnswer, answer), post(secondAnswer, answer)]);
  assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);

  await delay(130);
  const [unchanged, answered] = (await read()).requests;
  assert.equal(unchanged?.status, "pending");
  assert.equal(answered?.status, "acknowledged");
  assert.deepEqual(answered?.answers, answer);
  assert.deepEqual(answered?.timeline.map(entry => entry.label), [
    "Codex 已发出提问", "已提交回答", "原会话已收到回答",
  ]);
  assert.equal((await post(firstAnswer, { language: " TypeScript ", genre: "" })).status, 422);
  assert.equal((await post(firstAnswer, { language: " TypeScript ", genre: " 经营模拟 " })).status, 200);
  await delay(130);
  assert.deepEqual((await read()).requests[0]?.answers, { language: "TypeScript", genre: "经营模拟" });
});

test("disconnect invalidates question requests and reset prevents stale answers", async t => {
  const { post, read } = await start(t);
  const [first, second] = (await read()).requests;
  assert.ok(first && second);
  const firstPath = ["/api/decisions", first.id].join("/");
  const secondPath = ["/api/decisions", second.id].join("/");
  const scope = { scope: "当前筛选结果" };
  assert.equal((await post(`${firstPath}/disconnect`)).status, 200);
  assert.equal((await post(`${firstPath}/answer`, { language: "Python", genre: "解谜" })).status, 409);
  assert.equal((await post(`${secondPath}/answer`, scope)).status, 200);
  assert.equal((await post(`${secondPath}/disconnect`)).status, 200);
  await delay(130);
  assert.deepEqual((await read()).requests.map(request => request.status), ["expired", "uncertain"]);

  assert.equal((await post("/api/demo/reset")).status, 200);
  assert.equal((await post(`${secondPath}/answer`, scope)).status, 404);
  assert.deepEqual((await read()).requests.map(request => request.status), ["pending", "pending"]);
});

test("advances only the workflow whose clarification was answered", { timeout: 5000 }, async t => {
  const { post, read } = await start(t);
  assert.equal((await post("/api/workflows", { prompt: "项目 A 的游戏" })).status, 200);
  assert.equal((await post("/api/workflows", { prompt: "项目 B 的导出" })).status, 200);
  const { flows, requests } = await read();
  const [a, b] = flows;
  assert.ok(a && b);
  assert.deepEqual(a.outputs.map(output => output.title), ["调研"]);
  const decision = requests.find(card => card.flowId === b.id);
  assert.ok(decision);
  assert.equal((await post(`/api/decisions/${decision.id}/answer`, { scope: "CSV 首版" })).status, 200);
  const deadline = Date.now() + 2000;
  let snapshot = await read();
  while (snapshot.flows[1]?.status !== "ready" && Date.now() < deadline) {
    await delay(30);
    snapshot = await read();
  }
  assert.equal(snapshot.flows[0]?.status, "running");
  assert.equal(snapshot.flows[1]?.status, "ready");
  assert.deepEqual(snapshot.flows[1]?.outputs.map(output => output.title), ["调研", "需求澄清", "技术选型", "开发文档", "拆单"]);
  assert.match(snapshot.flows[1]?.outputs[3]?.artifacts[0]?.sections[0]?.text ?? "", /CSV 首版/);
  assert.equal(snapshot.requests.find(card => card.flowId === a.id)?.status, "pending");
});

test("rejects a new workflow when existing Codex sessions have filled capacity", async t => {
  const { post, read } = await start(t, [process.cwd(), () => {
    let close!: () => void;
    const finished = new Promise<"interrupted">(resolve => { close = () => resolve("interrupted"); });
    return { finished, close, answerQuestions: () => false, output: () => undefined };
  }], { limits: { codex: 2, demo: 24 } });
  for (let session = 0; session < 2; session += 1) {
    assert.equal((await post("/api/sessions", { prompt: `澄清会话 ${session}` })).status, 200);
  }
  assert.equal((await post("/api/workflows", { prompt: "开发一个游戏" })).status, 409);
  const capacity = await post("/api/sessions", { prompt: "超出配置的会话" });
  assert.equal(capacity.status, 409);
  assert.match((await capacity.json()).error, /已有 2 条会话进行中/);
  assert.deepEqual((await read()).flows, []);
});

test("revises a plan without reusing the old dispatch confirmation or changing an active code run", { timeout: 10000 }, async t => {
  const repo = await mkdtemp(join(tmpdir(), "souflow-code-workbench-"));
  const file = "docs/guide.md";
  await mkdir(join(repo, "docs"));
  await writeFile(join(repo, file), "初始文档\n");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "ignore" });
  git("init", "-q");
  git("add", "docs");
  git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--no-gpg-sign", "-qm", "fixture");
  const terminal = { finished: Promise.resolve("completed" as const), close() {} };
  let executions = 0;
  let rejected = true;
  const splitPrompts: string[] = [];
  let finishExecution!: () => void;
  const executionGate = new Promise<"completed">(resolve => { finishExecution = () => resolve("completed"); });
  const executedDirs = new Set<string>();
  const { post, read } = await start(t, [repo, options => ({
    ...terminal, answerQuestions: () => false,
    output: () => JSON.stringify(Object.fromEntries(((options.outputSchema?.required ?? []) as string[]).map(field => [field, `示例${field}`]))),
  })], { async qualityReviewer(packet) {
    if (!rejected) return passingQualityReview(packet, new AbortController().signal);
    return JSON.stringify({ ...qualityReviewOutput(packet), scope: { status: "block", summary: "工单超出本次范围",
      evidence: [{ ref: "request", quote: "更新使用指引" }] } });
  }, dispatchAdapters: {
    split(options) {
      splitPrompts.push(options.prompt);
      const code = options.prompt.includes("拆成本地代码工单");
      const fields = { id: "T1", title: "整理指引", instructions: "更新使用步骤", criteria: ["AC-1"], dependsOn: [], sources: [file] };
      return { ...terminal, answerQuestions: () => false,
        output: () => JSON.stringify({ tickets: [code ? { ...fields, editPaths: [file], validation } : fields] }) };
    },
    execute(options) {
      executions += 1;
      executedDirs.add(join(options.workspace, "..", ".."));
      return { finished: executionGate, close: finishExecution, output: () => JSON.stringify({ report: `已核对 ${file}`,
        ...(options.prompt.includes("文本替换") ? { edits: [{ path: file, before: "初始文档", after: "已更新" }] } : {}),
      }) };
    },
  } });
  t.after(async () => {
    for (const dir of executedDirs) await rm(dir, { recursive: true, force: true });
    await rm(repo, { recursive: true, force: true });
  });
  async function waitFor<T>(find: (snapshot: Snapshot) => T | undefined): Promise<T> {
    for (let index = 0; index < 100; index++) {
      const value = find(await read());
      if (value !== undefined) return value;
      await delay(20);
    }
    throw Error("等待派发状态超时");
  }
  assert.equal((await post("/api/workflows", { prompt: "更新使用指引" })).status, 200);
  const flow = await waitFor(snapshot => snapshot.flows.find(item => item.status === "ready"));
  const base = `/api/workflows/${flow.id}/local-dispatch`;
  const revise = `/api/workflows/${flow.id}/plan/revise`;
  const original = currentDevelopmentPlan(flow);
  const draft = flow.outputs.flatMap(output => output.artifacts).find(artifact => artifact.kind === "ticket-drafts");
  assert.ok(original && draft);
  assert.equal((await post(`${base}/prepare`, { kind: "invalid" })).status, 422);
  assert.equal((await post(`${base}/prepare`)).status, 200);
  const report = await waitFor(snapshot => snapshot.dispatches.find(run => run.kind === "report" && run.status === "ready"));
  assert.equal(report.quality, undefined);
  assert.equal((await post(`${base}/prepare`, { kind: "code" })).status, 200);
  const blocked = await waitFor(snapshot => snapshot.dispatches.find(run => run.kind === "code" && run.status === "failed"));
  assert.match(blocked.error ?? "", /工单超出本次范围/);
  assert.deepEqual(blocked.quality?.checks.scope.evidence, [{ ref: "request", quote: "更新使用指引" }]);
  assert.equal((await post(`${base}/start`, { id: blocked.id })).status, 409);
  assert.equal(executions, 0);
  rejected = false;
  assert.equal((await post(`${base}/prepare`, { kind: "code" })).status, 200);
  const code = await waitFor(snapshot => snapshot.dispatches.find(run => run.kind === "code" && run.status === "ready"));
  assert.equal(code.quality?.checks.scope.status, "pass");
  assert.deepEqual(code.quality?.documents.find(item => item.kind === original.kind),
    { kind: original.kind, id: original.id, version: original.version });
  assert.equal(executions, 0);
  assert.deepEqual(code.jobs[0]?.editPaths, [file]);
  assert.equal((await post(`${base}/start`, { id: "stale" })).status, 409);
  assert.equal((await post(revise, { version: 1, text: "新计划" }, "https://example.test")).status, 403);
  assert.equal((await post(revise, { version: 1, text: " " })).status, 422);
  assert.equal((await post(revise, { version: 1, text: "超".repeat(maxArtifactTextLength + 1) })).status, 422);
  assert.equal((await post(revise, { version: 1, text: original.sections[0]?.text })).status, 422);
  const revised = await Promise.all([
    post(revise, { version: 1, text: "只更新使用步骤" }),
    post(revise, { version: 1, text: "只更新使用步骤" }),
  ]);
  assert.deepEqual(revised.map(response => response.status).sort(), [200, 409]);
  const [updated] = (await read()).flows;
  assert.ok(updated);
  const current = currentDevelopmentPlan(updated);
  assert.equal(current?.version, 2);
  assert.equal(current?.id, original.id);
  assert.deepEqual(current?.replaces, { id: original.id, version: 1 });
  assert.deepEqual(current?.upstream, original.upstream);
  assert.equal(current?.sections[0]?.text, "只更新使用步骤");
  assert.deepEqual(updated.planHistory, [original, draft]);
  assert.ok(updated.outputs.every(output => output.artifacts.every(artifact => artifact.kind !== "ticket-drafts")));

  assert.equal((await post(`${base}/start`, { id: code.id })).status, 409);
  assert.equal((await post(`${base}/start`, { id: report.id })).status, 409);
  assert.equal(executions, 0);
  assert.equal((await post(`${base}/prepare`, { kind: "code" })).status, 200);
  const newCode = await waitFor(snapshot => snapshot.dispatches.find(run => run.kind === "code" && run.plan.version === 2 && run.status === "ready"));
  assert.notEqual(newCode.id, code.id);
  assert.match(splitPrompts.at(-1) ?? "", /只更新使用步骤/);
  assert.equal((await post(`${base}/start`, { id: newCode.id })).status, 200);
  assert.equal((await post(revise, { version: 2, text: "另一个新版" })).status, 409);
  finishExecution();
  const finished = await waitFor(snapshot => snapshot.dispatches.find(run => run.id === newCode.id && run.status === "finished"));
  assert.equal(executions, 1);
  assert.deepEqual(finished.jobs[0]?.changedFiles, [file]);
  assert.ok(finished.jobs[0]?.patchPath);
  assert.equal(await readFile(join(repo, file), "utf8"), "初始文档\n");
  assert.equal((await read()).dispatches.find(run => run.id === report.id)?.status, "ready");
  assert.equal((await read()).dispatches.find(run => run.id === code.id)?.status, "ready");
  assert.equal((await post(revise, { version: 2, text: "保留已交付记录的新计划" })).status, 200);
  assert.equal((await post(`${base}/start`, { id: newCode.id })).status, 409);
  assert.deepEqual((await read()).flows[0]?.planHistory, [original, draft, current]);
});

for (const outcome of ["approved", "rejected", "tampered-before", "tampered-after"] as const) {
  test(`code successors use only reviewed upstream patches (${outcome})`, { timeout: 10000 }, async t => {
    const repo = await mkdtemp(join(tmpdir(), "souflow-dependency-workbench-"));
    const guide = "docs/guide.md";
    const rules = "docs/rules.md";
    await mkdir(join(repo, "docs"));
    await Promise.all([writeFile(join(repo, guide), "原始指引\n"), writeFile(join(repo, rules), "原始规则\n")]);
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "ignore" });
    git("init", "-q");
    git("add", "docs");
    git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--no-gpg-sign", "-qm", "fixture");
    const terminal = { finished: Promise.resolve("completed" as const), close() {} };
    const steps = [
      { id: "T1", dependsOn: [], path: guide, before: "原始指引", after: "已核准指引" },
      { id: "T2", dependsOn: [], path: rules, before: "原始规则", after: "已核准规则" },
      { id: "T3", dependsOn: ["T2", "T1"], path: guide, before: "已核准指引", after: "汇总指引" },
      { id: "T4", dependsOn: ["T3", "T1"], path: rules, before: "已核准规则", after: "最终规则" },
    ];
    const directories = new Set<string>();
    const started: string[] = [];
    const members = outcome === "rejected" || outcome === "approved"
      ? { implementer: "i".repeat(32), reviewer: "r".repeat(32) } : undefined;
    const auditPath = outcome === "approved" ? join(repo, "audit.sqlite") : undefined;
    const identity = (actor: "implementer" | "reviewer") => members
      ? `Basic ${Buffer.from(`${actor}:${members[actor]}`).toString("base64")}` : undefined;
    const reviewer = identity("reviewer");
    const launch = () => start(t, [repo, options => ({
      ...terminal, answerQuestions: () => false,
      output: () => JSON.stringify(Object.fromEntries(((options.outputSchema?.required ?? []) as string[]).map(field => [field, `示例${field}`]))),
    })], { ...(members ? { members } : {}), dispatchAdapters: {
      split() {
        return { ...terminal, answerQuestions: () => false, output: () => JSON.stringify({
          tickets: [steps[3], steps[2], steps[1], steps[0]].map(step => ({
            id: step?.id, title: step?.id, instructions: "更新两份说明", criteria: ["AC-1"],
            dependsOn: step?.dependsOn, sources: [guide, rules], editPaths: [step?.path], validation,
          })),
        }) };
      },
      execute(options) {
        directories.add(join(options.workspace, "..", ".."));
        const input = JSON.parse(options.prompt.split("\n\n").at(-1) ?? "{}");
        const step = steps.find(item => item.id === input.title);
        assert.ok(step);
        started.push(step.id);
        assert.equal(input.editableFiles[0]?.text, `${step.before}\n`);
        if (step.id === "T3" || step.id === "T4") assert.equal(input.evidence[1]?.text, "已核准规则\n");
        if (step.id === "T4") assert.equal(input.evidence[0]?.text, "汇总指引\n");
        return { ...terminal, output: () => JSON.stringify({ report: step.id, edits: [step] }) };
      },
    } }, auditPath);
    let server = await launch();
    const read = () => server.read(identity("reviewer"));
    const post = (path: string, body: object, origin = server.url) =>
      server.post(path, body, origin, identity(path.startsWith("/api/decisions/") ? "reviewer" : "implementer"));
    t.after(async () => {
      for (const directory of directories) await rm(directory, { recursive: true, force: true });
      await rm(repo, { recursive: true, force: true });
    });
    async function waitFor<T>(find: (snapshot: Snapshot) => T | undefined): Promise<T> {
      for (let index = 0; index < 100; index++) {
        const value = find(await read());
        if (value !== undefined) return value;
        await delay(20);
      }
      throw Error("等待依赖工单超时");
    }
    assert.equal((await post("/api/workflows", { prompt: "按依赖更新指引和规则" })).status, 200);
    const flow = await waitFor(snapshot => snapshot.flows.find(item => item.status === "ready"));
    const path = `/api/workflows/${flow.id}/local-dispatch`;
    const reviewPath = (id: string) => `/api/decisions/${id}/answer`;
    assert.equal((await post(`${path}/prepare`, { kind: "code" })).status, 200);
    const run = await waitFor(snapshot => snapshot.dispatches.find(item => item.status !== "preparing"));
    assert.equal(run.status, "ready", run.error);
    assert.equal((await post(`${path}/start`, { id: run.id })).status, 200);
    let pending = await waitFor(snapshot => snapshot.requests.length === 2 ? snapshot : undefined);
    assert.deepEqual([...started].sort(), ["T1", "T2"]);
    const monitor = async () => {
      const response = await fetch(`${server.url}/api/dispatch-status`, reviewer ? { headers: { authorization: reviewer } } : undefined);
      assert.equal(response.status, 200);
      const { jobs } = await response.json() as { jobs: {
        batchId: string; ticketId: string; status: string; reviewing: boolean; waitingOn: string[];
      }[] };
      return jobs.filter(job => job.batchId === run.id);
    };
    if (auditPath) {
      const previousCards = pending.requests.map(card => card.id).sort();
      await server.close();
      server = await launch();
      pending = await read();
      assert.equal(pending.dispatches[0]?.id, run.id);
      assert.equal(pending.dispatches[0]?.status, "paused");
      assert.deepEqual(pending.requests.map(card => card.id).sort(), previousCards);
      assert.deepEqual([...started].sort(), ["T1", "T2"]);
    }
    const monitored = await monitor();
    assert.deepEqual(monitored.find(job => job.ticketId === "T3")?.waitingOn, ["T2", "T1"]);
    assert.deepEqual(monitored.filter(job => job.reviewing).map(job => job.ticketId).sort(), ["T1", "T2"]);
    const first = pending.requests.find(card => card.title.includes("T1"));
    const second = pending.requests.find(card => card.title.includes("T2"));
    assert.ok(first && second);
    const firstPatch = pending.dispatches[0]?.jobs.find(job => job.id === "T1")?.patchPath;
    assert.ok(firstPatch);
    assert.equal((await post(reviewPath(first.id), { review: "通过此版本" }, "https://example.test")).status, 403);
    if (members) {
      assert.equal((await server.post(reviewPath(first.id), { review: "通过此版本" }, server.url, identity("implementer"))).status, 403);
    }
    assert.equal((await post(reviewPath(first.id), { review: "模型自行批准" })).status, 422);
    assert.equal((await post(`/api/workflows/${flow.id}/plan/revise`, { version: 1, text: "改版" })).status, 409);
    if (outcome === "tampered-after") {
      assert.equal((await post(reviewPath(first.id), { review: "通过此版本" })).status, 200);
      await writeFile(firstPatch, "通过后被替换的补丁");
    }
    assert.equal((await post(reviewPath(second.id), { review: "通过此版本" })).status, 200);
    assert.equal((await post(reviewPath(second.id), { review: "通过此版本" })).status, 409);
    assert.deepEqual([...started].sort(), ["T1", "T2"]);
    if (auditPath) {
      await withAuditWriteBlocked(auditPath, async () => {
        assert.equal((await post(reviewPath(first.id), { review: "通过此版本" })).status, 503);
        const snapshot = await read();
        assert.ok(snapshot.requests.some(card => card.id === first.id && card.status === "pending"));
        assert.equal(snapshot.dispatches[0]?.jobs.find(job => job.id === "T3")?.status, "queued");
        assert.deepEqual([...started].sort(), ["T1", "T2"]);
      });
    }
    if (outcome === "tampered-before") await writeFile(firstPatch, "通过前被替换的补丁");
    if (outcome === "approved") {
      const repeated = await Promise.all([
        post(reviewPath(first.id), { review: "通过此版本" }),
        post(reviewPath(first.id), { review: "通过此版本" }),
      ]);
      assert.deepEqual(repeated.map(response => response.status).sort(), [200, 409]);
      if (auditPath) {
        assert.deepEqual([...started].sort(), ["T1", "T2"]);
        assert.equal((await post(`${path}/start`, { id: run.id })).status, 200);
      }
      const third = await waitFor(snapshot => snapshot.requests.find(card => card.title.includes("T3")));
      assert.deepEqual(started.slice(2), ["T3"]);
      assert.equal((await post(reviewPath(third.id), { review: "通过此版本" })).status, 200);
    } else if (outcome !== "tampered-after") {
      assert.equal((await post(reviewPath(first.id), { review: outcome === "rejected" ? "不通过" : "通过此版本" })).status,
        outcome === "tampered-before" ? 409 : 200);
    }
    const final = await waitFor(snapshot => snapshot.dispatches.find(item => item.status === "finished" || item.status === "failed"));
    assert.equal(final.status, outcome === "approved" ? "finished" : "failed");
    assert.equal((await monitor()).find(job => job.ticketId === "T4")?.status, outcome === "approved" ? "ready" : "blocked");
    assert.deepEqual(started.slice(2), outcome === "approved" ? ["T3", "T4"] : []);
    assert.equal(final.jobs.find(job => job.id === "T4")?.status, outcome === "approved" ? "ready" : "blocked");
    assert.match(final.jobs.find(job => job.id === "T3")?.error ?? "", outcome === "tampered-after" ? /前置补丁/ : /^$/);
    const persisted = JSON.parse(await readFile(join(final.directory ?? "", "run.json"), "utf8"));
    assert.equal(persisted.status, final.status);
    if (outcome === "approved") {
      const upstream = final.jobs.find(job => job.id === "T4")?.artifact?.upstream ?? [];
      assert.deepEqual(upstream.map(item => item.ticketId).sort(), ["T1", "T2", "T3"]);
      assert.ok(upstream.every(item => final.jobs.some(job => job.id === item.ticketId && job.artifact?.id === item.artifactId
        && job.artifact.patchSha256 === item.patchSha256 && job.artifact.review === "accepted")));
    }
    await Promise.all([guide, rules].map(async (file, index) => {
      assert.equal(await readFile(join(repo, file), "utf8"), `${steps[index]?.before}\n`);
    }));
    const audit = await (await fetch(`${server.url}/api/audit`, reviewer ? { headers: { authorization: reviewer } } : undefined)).json();
    const reviews = audit.recent.filter((entry: { kind: string }) => entry.kind === "dispatch.reviewed");
    assert.equal(reviews.length, outcome === "approved" ? 3 : 2);
    if (members) assert.ok(reviews.every((entry: { details: { actor: string } }) => entry.details.actor === "reviewer"));
    assert.ok(reviews.every((entry: { subject: string; details: { patchSha256: string } }) =>
      entry.subject === run.id && /^[a-f0-9]{64}$/.test(entry.details.patchSha256)));
  });
}

test("loads local environment settings at startup and keeps the file off HTTP", { timeout: 5000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), "souflow-env-"));
  const auditPath = join(dir, "from-dotenv.sqlite");
  await writeFile(join(dir, ".env"), [
    "SOULFLOW_DEMO_PORT=0",
    "SOULFLOW_DEMO_MAX_CONCURRENT=1",
    "SOULFLOW_PROMPT_MAX_LENGTH=8000",
    "SOULFLOW_ANSWER_MAX_LENGTH=6",
    "SOULFLOW_AUDIT_REPEAT_CLICK_MS=600",
    "SOULFLOW_AUDIT_QUICK_RETURN_MS=1500",
    "SOULFLOW_AUDIT_INSIGHT_MIN_COUNT=1",
    `SOULFLOW_AUDIT_DB="${auditPath}"`,
    "OPENAI_API_KEY=synthetic-test-value",
  ].join("\n"), { mode: 0o600 });
  const entry = fileURLToPath(new URL("../src/workbench/demo-server.mts", import.meta.url));
  const child = spawn(process.execPath, ["--experimental-strip-types", entry], {
    cwd: dir, env: { SOULFLOW_DEMO_MAX_CONCURRENT: "2" }, stdio: ["ignore", "pipe", "inherit"],
  });
  const closed = once(child, "close");
  t.after(async () => {
    child.kill();
    try {
      await closed;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  const lines = createInterface({ input: child.stdout });
  const first = await Promise.race([once(lines, "line", { signal: t.signal }), closed.then(() => [])]);
  const origin = /^souflow 决策收件箱 (http:\/\/127\.0\.0\.1:\d+)/.exec(String(first[0]))?.[1];
  assert.ok(origin, "the demo server should announce its bound address");
  assert.ok((await stat(auditPath)).isFile());
  const envResponse = await fetch(`${origin}/.env`);
  assert.equal(envResponse.status, 404);
  assert.doesNotMatch(await envResponse.text(), /synthetic-test-value/);
  const snapshot = await (await fetch(`${origin}/api/decisions`)).json() as Snapshot;
  assert.deepEqual(snapshot.inputLimits, { promptMaxLength: 8000, answerMaxLength: 6 });
  const report = await fetch(`${origin}/api/audit`);
  assert.equal(report.status, 200);
  assert.deepEqual((await report.json()).thresholds, { repeatClickMs: 600, quickReturnMs: 1500, insightMinCount: 1 });
  const firstCard = snapshot.requests[0];
  assert.ok(firstCard);
  const post = (path: string, body: object) => fetch(origin + path, {
    method: "POST", headers: { origin, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const submit = (prompt: string) => post("/api/workflows", { prompt });
  const widePrompt = "界".repeat(snapshot.inputLimits.promptMaxLength);
  const overLimit = await submit(widePrompt + "外");
  assert.equal(overLimit.status, 422);
  assert.match((await overLimit.json()).error, /8000/);
  assert.equal((await submit(widePrompt)).status, 200);
  assert.equal((await submit("验证配置的流程上限")).status, 200);
  assert.equal((await submit("第三个流程")).status, 409);
  const answer = (genre: string) => post(`/api/decisions/${firstCard.id}/answer`, { language: "TypeScript", genre });
  assert.equal((await answer("🎮🎮🎮外")).status, 422);
  assert.equal((await answer("🎮🎮🎮")).status, 200);
});
