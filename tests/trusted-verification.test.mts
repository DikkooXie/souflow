import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { issueRevision, type DeliveryTracker, type IssueDetail } from "../src/connections/issue-tracker.mts";
import { type DeliveryReviewer, type DeliveryReviewScope, reviewDelivery } from "../src/planning/delivery-review.mts";
import { createGitHubDeliveryReviewer } from "../src/workbench/github-delivery-review.mts";
import { createIssueDispatch, type Claim } from "../src/workbench/issue-dispatch.mts";
import { loadTrustedVerification, readTrustedVerificationConfig, verificationCriterionDigest,
  type VerificationBundle } from "../src/workbench/trusted-verification.mts";

const sha = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const scope: DeliveryReviewScope = { request: "夹具需求", files: ["src/device.mts"], criteria: [
  { criterion: "AC-1", text: "设备上线", procedure: "启动设备", expected: "显示在线" },
  { criterion: "AC-2", text: "撤销后拒绝", procedure: "撤销再连接", expected: "拒绝连接" },
] };

// 以下仅为可复现的测试夹具，不作为实际双机验收材料。
async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "souflow-verification-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync("git", ["-C", root, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
    "-c", "commit.gpgsign=false", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  await mkdir(join(root, "src")); await mkdir(join(root, "docs"));
  await writeFile(join(root, "AGENTS.md"), "夹具规则"); await writeFile(join(root, "docs/engineering-quality.md"), "夹具检查");
  await writeFile(join(root, "src/device.mts"), "guarded");
  git("init", "-q"); git("add", "."); git("commit", "-qm", "fixture business");
  const head = git("rev-parse", "HEAD");
  git("commit", "--allow-empty", "-qm", "fixture integration");
  const integration = git("rev-parse", "HEAD");
  const pull = { number: 8, head, state: "OPEN", url: "https://github.com/a/b/pull/8", baseName: "main" };
  const issue: IssueDetail = { number: 7, title: "夹具工单", body: "夹具验收", assignees: ["member"], state: "OPEN", pulls: [pull], url: "https://github.com/a/b/issues/7" };
  const plan = { id: "plan", version: 1, quality: { policy: 1, flowDigest: sha("flow"), batchDigest: sha("batch") } };
  const claim: Claim = { ...issue, pull, phase: "submitted", syncedAt: 0, requestId: "approved", account: "member", claimedBy: "member",
    target: { branch: "feat/7-fixture", head, base: "main" }, observedIssueRevision: issueRevision(issue), observedReviewLink: true,
    approval: { flowId: "flow", planId: plan.id, version: plan.version, quality: plan.quality, issueRevision: issueRevision(issue) },
    delivery: { baseRevision: head, files: [...scope.files], dependsOn: [], instructions: "原范围" } };
  const tracker: DeliveryTracker = { repo: "a/b", account: async () => "member", read: async () => issue, candidates: async () => [],
    assign: async () => assert.fail(), delivery: { checkout: async () => assert.fail(), publish: async () => assert.fail(),
      find: async () => pull, reviewChanges: async () => ({ mergeBase: head, files: [{ path: "src/device.mts", diff: "+guarded" }] }) } };
  await mkdir(join(root, "evidence"));
  await writeFile(join(root, "evidence/fixture.png"), "BINARY_IMAGE_FIXTURE_NEVER_SENT");
  await writeFile(join(root, "evidence/observations.txt"), "RAW_FILE_FIXTURE_NEVER_SENT");
  const now = Date.parse("2026-11-28T10:00:00.000Z");
  const bundle: VerificationBundle = { version: 1, repo: "a/b", issue: 7, issueRevision: issueRevision(issue), pull: 8, head, plan, integration,
    observedAt: "2026-11-28T09:00:00.000Z", expiresAt: "2026-11-29T09:00:00.000Z", verifiedBy: "测试夹具维护者", environment: "模拟双设备", publicSafe: true,
    files: [{ path: "evidence/fixture.png", sha256: sha("BINARY_IMAGE_FIXTURE_NEVER_SENT") },
      { path: "evidence/observations.txt", sha256: sha("RAW_FILE_FIXTURE_NEVER_SENT") }],
    results: scope.criteria.map(criterion => ({ criterion: criterion.criterion, criterionDigest: verificationCriterionDigest(criterion), outcome: "pass",
      facts: `夹具观测：${criterion.expected}`, files: ["evidence/fixture.png", "evidence/observations.txt"] })) };
  const write = async (value = bundle) => {
    const bytes = JSON.stringify(value);
    const config = { path: join(root, "manifest.json"), sha256: sha(bytes) };
    await writeFile(config.path, bytes);
    return config;
  };
  return { root, git, head, integration, claim, tracker, bundle, now, write };
}

test("维护者验收包精确绑定版本、材料、Git 集成祖先与有效期", async t => {
  const f = await fixture(t), config = await f.write();
  const trusted = loadTrustedVerification(config, f.root, () => f.now);
  const current = trusted.observe("a/b", f.claim, scope);
  assert.equal(current?.evidence?.length, 2);
  assert.equal(current?.verification?.integration, f.integration);
  assert.doesNotMatch(JSON.stringify(current), /BINARY_IMAGE_FIXTURE|RAW_FILE_FIXTURE|manifest\.json/);
  assert.deepEqual(readTrustedVerificationConfig(JSON.stringify(config)), config);
  assert.throws(() => readTrustedVerificationConfig(JSON.stringify({ ...config, path: "manifest.json" })));
  assert.throws(() => loadTrustedVerification({ ...config, sha256: sha("wrong") }, f.root));
  assert.equal(trusted.observe("elsewhere/repo", f.claim, scope), undefined);
  for (const changed of [
    { ...f.claim, pull: { ...f.claim.pull, number: 9, head: f.head, state: "OPEN", url: "fixture" } },
    { ...f.claim, pull: { ...f.claim.pull, head: f.integration, number: 8, state: "OPEN", url: "fixture" } },
    { ...f.claim, approval: { ...f.claim.approval, flowId: "flow", planId: "plan", issueRevision: sha("changed"), version: 1 } },
    { ...f.claim, approval: { ...f.claim.approval, flowId: "flow", planId: "plan", issueRevision: f.bundle.issueRevision, version: 2 } },
  ]) assert.equal(trusted.observe("a/b", changed, scope)?.evidence, undefined);
  assert.equal(trusted.observe("a/b", f.claim, { ...scope, criteria: scope.criteria.map(c => ({ ...c, expected: "changed" })) })?.evidence, undefined);
  assert.equal(loadTrustedVerification(config, f.root, () => Date.parse(f.bundle.expiresAt)).observe("a/b", f.claim, scope)?.evidence, undefined);
  await writeFile(join(f.root, "evidence/observations.txt"), "tampered");
  assert.equal(trusted.observe("a/b", f.claim, scope)?.evidence, undefined);
  assert.throws(() => loadTrustedVerification(config, f.root, () => f.now));
  await writeFile(join(f.root, "evidence/observations.txt"), "RAW_FILE_FIXTURE_NEVER_SENT");
  await rm(join(f.root, "evidence/fixture.png"));
  await symlink(join(f.root, "evidence/observations.txt"), join(f.root, "evidence/fixture.png"));
  assert.equal(trusted.observe("a/b", f.claim, scope)?.evidence, undefined);
  await rm(join(f.root, "evidence/fixture.png"));
  await writeFile(join(f.root, "evidence/fixture.png"), "BINARY_IMAGE_FIXTURE_NEVER_SENT");
  const unrelated = f.git("commit-tree", f.git("rev-parse", "HEAD^{tree}"), "-m", "unrelated fixture");
  const unrelatedConfig = await f.write({ ...f.bundle, integration: unrelated });
  assert.throws(() => loadTrustedVerification(unrelatedConfig, f.root));
});

const mockReview: DeliveryReviewer = async (axis, packet) => axis === "implementation"
  ? JSON.stringify({ status: "pass", summary: "夹具实现核对", evidence: [{ ref: "change:src/device.mts", quote: "guarded" }] })
  : JSON.stringify({ criteria: packet.criteria.map(criterion => {
    const proof = packet.evidence.find(e => e.kind === "verification" && e.criteria.includes(criterion.criterion));
    return { criterion: criterion.criterion, status: proof?.kind === "verification" && proof.outcome === "pass" ? "pass" : "block",
      summary: "夹具逐项核对", evidence: [{ ref: `criterion:${criterion.criterion}`, quote: criterion.text },
        ...(proof ? [{ ref: proof.id, quote: "夹具观测" }] : [])] };
  }) });

test("部分或失败材料不能被模型或普通 passingTests 报成完整通过，缺失 AC 也不能补勾", async t => {
  const f = await fixture(t);
  for (const outcome of ["partial", "fail"] as const) {
    const config = await f.write({ ...f.bundle, results: f.bundle.results.map(row => ({ ...row, outcome })) });
    const proof = loadTrustedVerification(config, f.root, () => f.now).observe("a/b", f.claim, scope);
    assert.ok(proof?.evidence && proof.verification);
    const packet = { key: { ...f.bundle, mergeBase: f.head, verification: proof.verification }, request: scope.request, criteria: scope.criteria,
      evidence: [{ id: "change:src/device.mts", kind: "change" as const, text: "+guarded" }, ...proof.evidence,
        { id: "npm", kind: "verification" as const, criteria: ["AC-1", "AC-2"], text: "tagged test passed" }] };
    const dishonest: DeliveryReviewer = async (axis, input, signal) => {
      const raw = JSON.parse(await mockReview(axis, input, signal) ?? "null");
      if (axis === "requirements") for (const criterion of raw.criteria) criterion.status = "pass";
      return JSON.stringify(raw);
    };
    assert.equal((await reviewDelivery(packet, dishonest, new AbortController().signal)).status, "incomplete");
    assert.equal((await reviewDelivery(packet, mockReview, new AbortController().signal)).status, "block");
  }
  const missing = await f.write({ ...f.bundle, results: f.bundle.results.slice(0, 1) });
  const reviewer = createGitHubDeliveryReviewer(f.root, () => scope, mockReview,
    { repo: "a/b", bundle: loadTrustedVerification(missing, f.root, () => f.now) });
  assert.equal((await reviewer(f.claim, f.tracker, f.tracker.delivery, new AbortController().signal))?.status, "block");
});

test("旧包不阻塞新提交的正常复核，复核中材料变化不能保存旧通过结果", async t => {
  const f = await fixture(t), config = await f.write();
  const bundle = loadTrustedVerification(config, f.root, () => f.now);
  const reviewer = createGitHubDeliveryReviewer(f.root, () => scope, mockReview, { repo: "a/b", bundle });
  assert.ok(f.claim.pull);
  const pull = { ...f.claim.pull, head: f.integration };
  const changed = { ...f.claim, pull };
  const tracker: DeliveryTracker = { ...f.tracker, read: async () => ({ ...await f.tracker.read(7), pulls: [pull] }),
    delivery: { ...f.tracker.delivery, find: async () => pull } };
  const receipt = await reviewer(changed, tracker, tracker.delivery, new AbortController().signal);
  assert.equal(receipt?.status, "block");
  assert.equal(receipt?.key.head, f.integration);
  assert.equal(receipt?.key.verification, undefined);
  const duringReview = createGitHubDeliveryReviewer(f.root, () => scope, async (axis, packet, signal) => {
    if (axis === "implementation") await writeFile(join(f.root, "evidence/observations.txt"), "changed during review");
    return mockReview(axis, packet, signal);
  }, { repo: "a/b", bundle });
  assert.equal(await duringReview(f.claim, f.tracker, f.tracker.delivery, new AbortController().signal), undefined);
});

test("正常轮询在同业务头新增或变更证明后各复核一次，历史回执不覆盖，篡改和过期立即停用", async t => {
  const f = await fixture(t);
  let stored = f.claim, calls = 0, now = f.now;
  const run: DeliveryReviewer = (axis, packet, signal) => { calls++; return mockReview(axis, packet, signal); };
  for (const generation of [0, 1, 2]) {
    const config = generation ? await f.write({ ...f.bundle, results: f.bundle.results.map(row => ({ ...row,
      outcome: generation === 1 ? "partial" : "pass", facts: `${row.facts}，版本 ${generation}` })) }) : undefined;
    const reviewer = createGitHubDeliveryReviewer(f.root, () => scope, run,
      config ? { repo: "a/b", bundle: loadTrustedVerification(config, f.root, () => now) } : undefined);
    const build = () => createIssueDispatch(f.tracker, { load: () => [stored], save(_id, value) { stored = value; return true; } },
      async () => assert.fail(), () => true, 1, new Map(), { specs: new Map(), conversation: true, pollMs: 60_000, prepare: async () => assert.fail(),
        review: reviewer, reviewScopeCurrent: () => true });
    let dispatch = build();
    try {
      await dispatch.refresh();
      for (let n = 0; n < 100 && stored.deliveryReviews?.length !== generation + 1; n++) await delay(10);
      assert.equal(stored.deliveryReviews?.length, generation + 1);
      assert.equal(stored.deliveryReviews?.at(-1)?.receipt.status, generation === 2 ? "pass" : "block");
      assert.equal(new Set(stored.deliveryReviews?.map(row => row.receipt.packetId)).size, generation + 1);
      await dispatch.refresh(); await dispatch.close();
      dispatch = build(); await dispatch.refresh();
      assert.equal(calls, (generation + 1) * 2);
      const history = dispatch.reviewStatus("flow", "member")[0]?.reviews;
      assert.equal(history?.filter(row => row.current).length, 1);
      assert.equal(history?.at(-1)?.current, true);
      if (generation === 2 && config) {
        now = Date.parse(f.bundle.expiresAt);
        assert.equal(dispatch.reviewStatus("flow", "member")[0]?.reviews.some(row => row.current), false);
        now = f.now;
        await writeFile(config.path, `${await readFile(config.path, "utf8")} `);
        await dispatch.refresh();
        for (let n = 0; n < 100 && stored.deliveryReviews?.length !== 4; n++) await delay(10);
        assert.equal(calls, 8);
        const latest = dispatch.reviewStatus("flow", "member")[0]?.reviews.find(row => row.current);
        assert.equal(latest?.status, "block", "过期或失效的包不能卡住正常复核，缺实测时仍拦截");
        assert.equal(latest?.key.verification, undefined);
      }
    } finally { await dispatch.close(); }
  }
});
