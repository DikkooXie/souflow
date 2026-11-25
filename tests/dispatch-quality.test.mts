import assert from "node:assert/strict";
import test from "node:test";
import { currentDevelopmentPlan } from "../src/planning/conversation-flow.mts";
import {
  type BatchAcceptance, qualityBlock, qualityCurrent, qualityPacket, type QualityTicket, reviewQuality,
} from "../src/planning/dispatch-quality.mts";
import { passingQualityReview, qualityReviewOutput, readyQualityFlow } from "./fixtures/planning-quality.mts";

const revision = "a".repeat(40);
const idempotencyCriterion = "重复确认同一份纪要时只发送一次待办";
const confirmationCriterion = "人工确认前不发送待办";
const idempotencyProcedure = "对同一份纪要连续确认两次，查看发送记录";
const idempotencyResult = "发送记录只有一条";
const ticket = {
  id: "send-todo",
  title: "人工确认纪要后发送待办",
  instructions: "复用待办服务，同一纪要使用固定幂等键。",
  paths: ["src/minutes/confirmation.mts"],
  dependsOn: [],
  criteria: ["AC-1", "AC-2"],
  validation: [
    { criterion: "AC-1", procedure: idempotencyProcedure, expected: idempotencyResult },
    { criterion: "AC-2", procedure: "上传录音并等待纪要生成，暂不确认", expected: "没有待办发送记录" },
  ],
} satisfies QualityTicket;

async function qualityFixture() {
  const flow = await readyQualityFlow();
  flow.outputs = flow.outputs.map(output => ({ ...output, artifacts: output.artifacts.map(artifact =>
    artifact.kind === "requirements" ? { ...artifact, sections: artifact.sections.map(section =>
      section.title === "验收条件" ? { ...section, text: `${section.text}\n${confirmationCriterion}` } : section) } : artifact),
  }));
  const payload = { id: "minutes-dispatch", revision, tickets: [ticket] };
  const packet = qualityPacket(flow, revision, payload.id, payload.tickets);
  return { flow, payload, packet, signal: new AbortController().signal };
}

test("通过的复审记录保留幂等验收及其验证依据", async () => {
  const { flow, payload, packet, signal } = await qualityFixture();
  assert.equal(packet.references.request, "上传录音生成纪要，人工确认后发送待办");
  assert.deepEqual(packet.planning.criteria, [
    { id: "AC-1", text: idempotencyCriterion },
    { id: "AC-2", text: confirmationCriterion },
  ]);
  const receipt = await reviewQuality(packet, payload, passingQualityReview, signal);
  assert.deepEqual(receipt.checks.verification.evidence[0], {
    ref: "test:send-todo:AC-1", quote: `${idempotencyProcedure}\n${idempotencyResult}`,
  });
  assert.equal(qualityBlock(receipt), "");
  assert.equal(qualityCurrent(receipt, structuredClone(flow), structuredClone(payload)), true);
});

test("另行待验收仍须覆盖所有条件，且关联闭单证据随批次绑定", async () => {
  const { flow, signal } = await qualityFixture();
  const url = "https://github.com/a/b/issues/8";
  flow.project = { plan: { status: "read" }, repository: { revision, commits: [] }, github: { status: "read", repo: "a/b" },
    relatedIssues: [{ number: 8, url, status: "read", state: "CLOSED", assigned: false,
      source: { number: 8, title: "确认前禁止发送", body: "等待人工确认后再发送纪要待办。", revision: "8".repeat(64) } }] };
  const [first, second] = ticket.validation;
  assert.ok(first && second);
  const onlyNew = { ...ticket, criteria: ["AC-1"], validation: [first] };
  const related: BatchAcceptance = { ...second, owner: "related-issue", issue: 8, basis: "等待人工确认后再发送纪要待办" };
  const input = (checks: BatchAcceptance[], tickets: QualityTicket[] = [onlyNew]) =>
    qualityPacket(flow, revision, "trial", tickets, {}, checks);
  assert.throws(() => input([]), /uncovered:AC-2/);
  assert.throws(() => input([related, related]), /唯一编号/);
  assert.throws(() => input([{ ...related, issue: 9 }]), /已读正文/);
  assert.throws(() => input([{ ...related, basis: "未经确认也可以发送" }]), /已读正文/);
  assert.throws(() => input([related], [ticket]), /unknown-criterion:send-todo:AC-2/);
  const packet = input([related]);
  assert.deepEqual(packet.batchAcceptance, [related]);
  assert.equal(packet.references["github:issue:8"], "确认前禁止发送\n等待人工确认后再发送纪要待办。");
  const payload = { tickets: [onlyNew], batchAcceptance: [related] };
  const receipt = await reviewQuality(packet, payload, passingQualityReview, signal);
  const invalid = qualityReviewOutput(packet);
  invalid.verification.evidence.pop();
  await assert.rejects(reviewQuality(packet, payload, async () => JSON.stringify(invalid), signal), /每项验收的验证依据/);
  const unsupported = qualityReviewOutput(packet);
  unsupported.evidence.evidence.pop();
  await assert.rejects(reviewQuality(packet, payload, async () => JSON.stringify(unsupported), signal), /未引用 AC-2 的关联 Issue 正文/);
  assert.equal(qualityCurrent(receipt, flow, payload), true);
  assert.equal(qualityCurrent(receipt, flow, { ...payload, batchAcceptance: [{ ...related, expected: "另一种预期" }] }), false);
  const changed = structuredClone(flow);
  if (changed.project) changed.project.relatedIssues = [];
  assert.equal(qualityCurrent(receipt, changed, payload), false);
});

test("工单引用不存在的验收项时拒绝准备复审", async () => {
  const { flow, payload } = await qualityFixture();
  const invalid = { ...ticket, criteria: [...ticket.criteria, "AC-99"] };
  assert.throws(() => qualityPacket(flow, revision, payload.id, [invalid]), /unknown-criterion:send-todo:AC-99/);
});

test("复审拒绝不存在的引用及无法在原文找到的引文", async () => {
  const { payload, packet, signal } = await qualityFixture();
  for (const citation of [
    { ref: "repo:src/missing.mts", quote: idempotencyCriterion },
    { ref: "criterion:AC-1", quote: "每次确认都重新发送待办" },
  ]) {
    const output = qualityReviewOutput(packet);
    output.evidence.evidence = [citation];
    await assert.rejects(reviewQuality(packet, payload, async () => JSON.stringify(output), signal), /引用无法在本轮资料找到/);
  }
});

test("依据维度只接收上限内的有效引用", async () => {
  const { payload, packet, signal } = await qualityFixture();
  const output = qualityReviewOutput(packet);
  output.evidence.evidence = Array.from({ length: 7 }, (_, start) => ({
    ref: "request", quote: packet.planning.request.slice(start, start + 4),
  }));
  const review = async () => JSON.stringify(output);
  await assert.rejects(reviewQuality(packet, payload, review, signal), /质量复核结论缺少依据/);
  output.evidence.evidence.pop();
  const receipt = await reviewQuality(packet, payload, review, signal);
  assert.equal(receipt.checks.evidence.evidence.length, 6);
});

test("工单缺少幂等验收的验证步骤和预期结果时拒绝准备复审", async () => {
  const { flow, payload } = await qualityFixture();
  const invalid = { ...ticket, validation: ticket.validation.filter(item => item.criterion !== "AC-1") };
  assert.throws(() => qualityPacket(flow, revision, payload.id, [invalid]), /每项验收引用需要一条验证步骤和预期结果/);
});

test("只有确认前的验证依据时，复审不能判定全部验收通过", async () => {
  const { payload, packet, signal } = await qualityFixture();
  const output = qualityReviewOutput(packet);
  output.verification.evidence = output.verification.evidence.filter(item => item.ref === "test:send-todo:AC-2");
  await assert.rejects(reviewQuality(packet, payload, async () => JSON.stringify(output), signal), /未给出每项验收的验证依据/);
});

test("开发计划沿用编号和版本但修改正文后，原复审记录失效", async () => {
  const { flow, payload, packet, signal } = await qualityFixture();
  const receipt = await reviewQuality(packet, payload, passingQualityReview, signal);
  const plan = currentDevelopmentPlan(flow);
  assert.ok(plan);
  const changed = { ...flow, outputs: flow.outputs.map(output => ({ ...output, artifacts: output.artifacts.map(artifact =>
    artifact === plan ? { ...plan, sections: [{ title: "开发计划", text: "先记录人工确认，再按同一纪要去重发送待办。" }] } : artifact),
  })) };
  assert.equal(qualityCurrent(receipt, changed, payload), false);
});

test("工单沿用编号但修改执行要求后，原复审记录失效", async () => {
  const { flow, payload, packet, signal } = await qualityFixture();
  const receipt = await reviewQuality(packet, payload, passingQualityReview, signal);
  const changed = { ...payload, tickets: [{ ...ticket, instructions: "确认成功后先写发送记录，再投递待办。" }] };
  assert.equal(qualityCurrent(receipt, flow, changed), false);
});

const blockers = [
  { dimension: "scope", label: "范围", summary: "实时录音超出首版范围。",
    citation: { ref: "requirements", quote: "首版只支持已有录音" } },
  { dimension: "evidence", label: "依据", summary: "计划还需说明重试时如何沿用原幂等键。",
    citation: { ref: "development-plan", quote: "同一纪要使用固定幂等键" } },
  { dimension: "verification", label: "验证", summary: "验证步骤还需覆盖并发确认。",
    citation: { ref: "test:send-todo:AC-1", quote: idempotencyProcedure } },
] as const;

for (const { dimension, label, summary, citation } of blockers) {
  test(`保留有原文引用的 ${dimension} 阻塞，复审记录不能用于放行`, async () => {
    const { flow, payload, packet, signal } = await qualityFixture();
    const block = { status: "block", summary, evidence: [citation] };
    const output = { ...qualityReviewOutput(packet), [dimension]: block };
    const receipt = await reviewQuality(packet, payload, async () => JSON.stringify(output), signal);
    assert.deepEqual(receipt.checks[dimension], block);
    assert.equal(qualityBlock(receipt), `${label}：${summary}`);
    assert.equal(qualityCurrent(receipt, flow, payload), false);
  });
}
