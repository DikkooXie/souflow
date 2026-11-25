import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { openActivityStore } from "../src/audit/activity-store.mts";
import type { IssueDetail, IssueTracker } from "../src/connections/issue-tracker.mts";
import type { VerifyIssue } from "../src/execution/issue-verification.mts";
import { currentDevelopmentPlan, type StoredFlow } from "../src/planning/conversation-flow.mts";
import { createWorkbenchServer } from "../src/workbench/demo-server.mts";
import type { Claim } from "../src/workbench/issue-dispatch.mts";
import { readyQualityFlow } from "./fixtures/planning-quality.mts";

test("GitHub 工单通过成员权限、并发去重、持久化和刷新保持一致", { timeout: 15_000 }, async () => {
  const workspace = await mkdtemp(join(tmpdir(), "souflow-github-http-"));
  const database = join(workspace, "audit.sqlite");
  const members = { implementer: "a".repeat(32), reviewer: "b".repeat(32), additionalImplementers: { second: "c".repeat(32) } };
  const auth = (name: "implementer" | "reviewer" | "second") => {
    const key = name === "second" ? members.additionalImplementers.second : members[name];
    return `Basic ${Buffer.from(`${name}:${key}`).toString("base64")}`;
  };
  const rows = new Map<number, IssueDetail>([1, 2].map(number => [number, {
    number, title: `工单 ${number}`, body: "核验描述", state: "OPEN", assignees: [], pulls: [],
    url: `https://github.com/example/repo/issues/${number}`,
  }]));
  let releaseAccount!: () => void;
  const accountGate = new Promise<void>(resolve => { releaseAccount = resolve; });
  let accountStarted!: () => void;
  const accountEntered = new Promise<void>(resolve => { accountStarted = resolve; });
  const assignments: string[] = [];
  let firstAccount = true;
  function tracker(account: string): IssueTracker {
    return {
      repo: "example/repo",
      async account() {
        if (firstAccount) { firstAccount = false; accountStarted(); await accountGate; }
        return account;
      },
      async candidates() { return [...rows.values()].filter(row => row.state === "OPEN" && !row.assignees.length).map(row => structuredClone(row)); },
      async read(number) {
        const row = rows.get(number);
        assert.ok(row);
        return structuredClone(row);
      },
      async assign(number, login) {
        const row = rows.get(number);
        assert.ok(row);
        assignments.push(`${number}:${login}`);
        row.assignees = [login];
      },
    };
  }
  const mainTracker = tracker("github-one");
  const secondTracker = tracker("github-two");
  const verifications: number[] = [];
  const finish = new Map<number, () => void>();
  const verifyIssue: VerifyIssue = async (issue, connected, signal) => {
    verifications.push(issue.number);
    connected(`session-${issue.number}`);
    await new Promise<void>((resolve, reject) => {
      finish.set(issue.number, resolve);
      signal.addEventListener("abort", () => reject(Error("已中断")), { once: true });
    });
    return `工单 ${issue.number} 的核验报告`;
  };
  const options = { members, issueTracker: mainTracker, verifyIssue,
    memberTrackers: new Map([["implementer", mainTracker], ["second", secondTracker]]) };
  let current: ReturnType<typeof createWorkbenchServer> | undefined;
  async function start() {
    current = createWorkbenchServer(0, [workspace], database, options);
    current.listen(0, "127.0.0.1");
    await once(current, "listening");
    const address = current.address();
    assert.ok(address && typeof address === "object");
    return `http://127.0.0.1:${address.port}`;
  }
  async function close() {
    if (!current) return;
    const closed = once(current, "workbenchClosed");
    current.close();
    current.closeAllConnections();
    await closed;
    current = undefined;
  }
  let url = "";
  const get = (path: string, authorization?: string) => fetch(url + path, { headers: authorization ? { authorization } : {} });
  const post = (path: string, body: object, authorization?: string, origin = url) => fetch(url + path, {
    method: "POST", headers: { origin, "Content-Type": "application/json", ...(authorization ? { authorization } : {}) },
    body: JSON.stringify(body),
  });
  async function snapshot() {
    const response = await get("/api/github/issues", auth("reviewer"));
    assert.equal(response.status, 200);
    return await response.json() as { repo: string; canClaim: boolean; items: Array<{
      number: number; claimedBy?: string; assignees: string[]; sessionId?: string; report?: string; progress: string;
      pulls: { number: number; state: string; url: string }[];
    }> };
  }
  async function waitUntil(predicate: () => Promise<boolean>) {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await predicate()) return;
      await delay(20);
    }
    assert.fail("等待工单状态超时");
  }
  try {
    url = await start();
    assert.equal((await get("/api/github/issues")).status, 401);
    assert.equal((await post("/api/github/issues/claim", { requestId: randomUUID() })).status, 401);
    assert.equal((await post("/api/github/issues/claim", { requestId: randomUUID() }, auth("reviewer"))).status, 403);
    assert.equal((await post("/api/github/issues/claim", { requestId: randomUUID() }, auth("implementer"), "https://example.invalid")).status, 403);
    assert.equal((await snapshot()).canClaim, false);
    assert.equal((await (await get("/api/decisions", auth("implementer"))).json()).githubEnabled, true);

    const firstId = randomUUID();
    const secondId = randomUUID();
    const first = post("/api/github/issues/claim", { requestId: firstId }, auth("implementer"));
    await accountEntered;
    assert.equal((await post("/api/github/issues/claim", { requestId: firstId }, auth("second"))).status, 409);
    assert.equal((await post("/api/github/issues/claim", { requestId: secondId }, auth("second"))).status, 409);
    releaseAccount();
    assert.equal((await first).status, 200);
    assert.equal((await post("/api/github/issues/claim", { requestId: firstId }, auth("second"))).status, 409);
    assert.equal((await post("/api/github/issues/claim", { requestId: firstId }, auth("implementer"))).status, 200);
    assert.equal((await post("/api/github/issues/claim", { requestId: secondId }, auth("second"))).status, 200);
    assert.deepEqual(assignments, ["1:github-one", "2:github-two"]);
    assert.deepEqual(verifications, [1, 2]);
    const running = await snapshot();
    assert.equal(running.repo, "example/repo");
    assert.equal(running.items.find(item => item.number === 1)?.claimedBy, "implementer");
    assert.equal(running.items.find(item => item.number === 2)?.claimedBy, "second");
    assert.equal(running.items.find(item => item.number === 1)?.sessionId, "session-1");
    finish.get(1)?.();
    finish.get(2)?.();
    await waitUntil(async () => (await snapshot()).items.every(item => item.progress === "核验完成"));
    const issue = rows.get(1);
    assert.ok(issue);
    // 即使 GitHub 重新显示工单无人负责，本机也不能再次执行已有工单。
    issue.assignees = [];
    assert.equal((await post("/api/github/issues/claim", { requestId: randomUUID() }, auth("implementer"))).status, 409);
    assert.deepEqual(verifications, [1, 2]);

    issue.pulls = [{ number: 7, state: "MERGED", url: "https://github.com/example/repo/pull/7" }];
    assert.equal((await post("/api/github/issues/refresh", {}, auth("reviewer"))).status, 200);
    assert.deepEqual((await snapshot()).items.find(item => item.number === 1)?.pulls, issue.pulls);
    await close();
    url = await start();
    const restored = await snapshot();
    assert.equal(restored.items.length, 2);
    assert.equal(restored.items.find(item => item.number === 1)?.report, "工单 1 的核验报告");
    assert.deepEqual(restored.items.find(item => item.number === 1)?.pulls, issue.pulls);
    assert.equal((await post("/api/github/issues/claim", { requestId: firstId }, auth("implementer"))).status, 200);
    assert.equal((await post("/api/github/issues/claim", { requestId: randomUUID() }, auth("second"))).status, 409);
    assert.deepEqual(verifications, [1, 2]);
  } finally {
    releaseAccount();
    for (const resolve of finish.values()) resolve();
    await close();
    await rm(workspace, { recursive: true, force: true });
  }
});

test("验收成员可读共享双维度复核，其他实施成员仍不能读取该回执或替人派发", async t => {
  const workspace = await mkdtemp(join(tmpdir(), "souflow-github-reviews-http-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const database = join(workspace, "audit.sqlite");
  const flow = await readyQualityFlow();
  flow.requestedBy = "implementer";
  const plan = currentDevelopmentPlan(flow);
  assert.ok(plan);
  const head = "a".repeat(40);
  const issueRevision = "b".repeat(64);
  const quality = { policy: 1, flowDigest: "c".repeat(64), batchDigest: "d".repeat(64) };
  const pull = { number: 2, url: "https://github.com/example/repo/pull/2", state: "OPEN", head };
  const issue: IssueDetail = { number: 1, title: "交付复核", body: "核对验收", state: "OPEN", assignees: ["member"],
    pulls: [pull], url: "https://github.com/example/repo/issues/1" };
  const store = openActivityStore(database);
  try {
    assert.equal(store.checkpoint<StoredFlow>("flows").save(flow.id, { flow }), true);
    assert.equal(store.checkpoint<Claim>("github-issues:example/repo").save("1", { ...issue, pull, syncedAt: 0,
      requestId: "fixture", claimedBy: "implementer", account: "member", phase: "submitted",
      approval: { flowId: flow.id, planId: plan.id, version: plan.version, issueRevision, quality },
      deliveryReviews: [{ observed: "historical", receipt: { packetId: "example", status: "block",
        key: { repo: "example/repo", issue: 1, issueRevision, pull: 2, head, mergeBase: head, plan: { id: plan.id, version: plan.version, quality } },
        implementation: { status: "pass", summary: "代码核对", evidence: [{ ref: "change:src/main.mts", quote: "代码依据" }] },
        requirements: { criteria: [{ criterion: "AC-1", status: "block", summary: "验收遗漏",
          evidence: [{ ref: "criterion:AC-1", quote: "需求依据" }] }] },
      } }],
    }), true);
  } finally { store.close(); }

  const keys = { implementer: "e".repeat(32), reviewer: "f".repeat(32), second: "g".repeat(32) };
  const auth = (name: keyof typeof keys) => `Basic ${Buffer.from(`${name}:${keys[name]}`).toString("base64")}`;
  const server = createWorkbenchServer(0, [workspace], database, {
    members: { implementer: keys.implementer, reviewer: keys.reviewer, additionalImplementers: { second: keys.second } },
    issueTracker: { repo: "example/repo", account: async () => assert.fail("回读无需 GitHub 身份"), candidates: async () => [],
      read: async () => issue, assign: async () => assert.fail("验收成员不能认领") },
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const url = `http://127.0.0.1:${address.port}`;
    const route = `${url}/api/decisions`;
    const snapshot = async (name: keyof typeof keys) => {
      const response = await fetch(route, { headers: { authorization: auth(name) } });
      assert.equal(response.status, 200);
      return response.json();
    };
    assert.equal((await fetch(route)).status, 401);
    const reviewer = await snapshot("reviewer");
    const evidence = reviewer.deliveryReviews[0].reviews[0].reviews[0];
    assert.equal(reviewer.deliveryReviews[0].flowId, flow.id);
    assert.deepEqual(evidence.implementation.evidence, [{ ref: "change:src/main.mts", quote: "代码依据" }]);
    assert.deepEqual(evidence.requirements.criteria[0].evidence, [{ ref: "criterion:AC-1", quote: "需求依据" }]);
    assert.deepEqual((await snapshot("implementer")).deliveryReviews, reviewer.deliveryReviews);
    assert.equal((await snapshot("second")).deliveryReviews, undefined);
    assert.equal((await fetch(`${url}/api/github/issues/claim`, { method: "POST", headers: { origin: url,
      "Content-Type": "application/json", authorization: auth("reviewer") }, body: JSON.stringify({ requestId: randomUUID() }) })).status, 403);
  } finally {
    const closed = once(server, "workbenchClosed");
    server.close();
    server.closeAllConnections();
    await closed;
  }
});
