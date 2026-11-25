import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { startCodexReadOnlyTask } from "../src/execution/codex-command-attempt.mts";
import { createCodexQualityReviewer } from "../src/execution/codex-quality-review.mts";
import { readDispatchTickets } from "../src/execution/local-dispatch.mts";
import { prepareVerifiedDraft, qualityBlock, qualityCurrent, reviewQuality } from "../src/planning/dispatch-quality.mts";
import { deviceTicketPlan } from "./fixtures/device-ticket-plan.mts";
import { qualityReviewOutput } from "./fixtures/planning-quality.mts";

test("GitHub 新工单要求可演示结果、优先顺序和每项真实前置的理由", async () => {
  const { tickets } = await deviceTicketPlan();
  const candidates = tickets.map(ticket => ({ ...ticket, editPaths: ticket.paths, sources: [] }));
  const allowed = new Set(tickets.flatMap(ticket => ticket.paths));
  const [first, second] = candidates;
  assert.ok(first && second);
  const read = (items: unknown[], github = true) =>
    readDispatchTickets(JSON.stringify({ tickets: items }), ["AC-1", "AC-2"], allowed, "code", undefined, true, 16_000, github);
  assert.deepEqual(read(candidates).map(item => item.delivery), tickets.map(ticket => ticket.delivery));
  assert.throws(() => read([{ ...first, delivery: undefined }, second]), /T1.*可演示结果/);
  assert.throws(() => read([first, { ...second, dependsOn: ["T1"] }]), /T2.*前置说明/);
  const dependent = { ...second, dependsOn: ["T1"],
    delivery: { ...second.delivery, prerequisites: [{ ticket: "T1", reason: "依赖已合并的设备信息接口" }] } };
  assert.doesNotThrow(() => read([first, dependent]));
  assert.throws(() => read([dependent, first]), /前置 T1 必须排在/);
  const cycle = { ...first, dependsOn: ["T2"],
    delivery: { ...first.delivery, prerequisites: [{ ticket: "T2", reason: "依赖上游的状态输出" }] } };
  assert.throws(() => read([cycle, dependent]), /blocked-by-cycle/);
  assert.throws(() => read([first]), /uncovered:AC-2/);
  assert.throws(() => read([first, { ...second, editPaths: first.editPaths }]), /重复分配/);
  assert.doesNotThrow(() => read(candidates.map(item => ({ ...item, delivery: undefined })), false));
});

test("逐单复核必须引用每张工单，并能阻止按技术层拆、虚假依赖和颠倒优先顺序", async () => {
  const fixture = await deviceTicketPlan();
  const [first, second] = fixture.tickets;
  assert.ok(first && second);
  const signal = new AbortController().signal;
  const accepted = fixture.packet(fixture.tickets);
  const passed = await reviewQuality(accepted, fixture.tickets, async () => JSON.stringify(qualityReviewOutput(accepted)), signal);
  assert.equal(qualityBlock(passed), "");
  assert.equal(qualityCurrent(passed, fixture.flow, fixture.tickets), true);
  const variants = [
    { tickets: [{ ...first, instructions: "仅写 CSS，不连接设备数据" }, second], id: first.id, reason: "仅改界面无法演示成员设备列表" },
    { tickets: [first, { ...second, dependsOn: [first.id],
      delivery: { ...second.delivery, prerequisites: [{ ticket: first.id, reason: "列表先显示更方便" }] } }],
      id: second.id, reason: "已有详情可完成撤销，列表不阻塞开工" },
    { tickets: [second, first], id: second.id, reason: "同级顺序颠倒，已确认先交付成员列表" },
  ];
  for (const { tickets, id, reason } of variants) {
    const packet = fixture.packet(tickets);
    const output = qualityReviewOutput(packet);
    assert.ok(output.breakdown);
    const breakdown = output.breakdown.map(finding => finding.ticket === id ? { ...finding, status: "block", summary: reason } : finding);
    const receipt = await reviewQuality(packet, tickets, async () => JSON.stringify({ ...output, breakdown }), signal);
    assert.match(qualityBlock(receipt), new RegExp(reason));
    assert.equal(qualityCurrent(receipt, fixture.flow, tickets), false);
  }
  const output = qualityReviewOutput(accepted);
  const { breakdown, ...withoutBreakdown } = output;
  assert.ok(breakdown);
  await assert.rejects(reviewQuality(accepted, fixture.tickets, async () => JSON.stringify(withoutBreakdown), signal), /未返回完整结果/);
  await assert.rejects(reviewQuality(accepted, fixture.tickets,
    async () => JSON.stringify({ ...output, breakdown: breakdown.slice(0, 1) }), signal), /缺少逐单拆分/);
  const secondCheck = breakdown[1];
  const firstCheck = breakdown[0];
  assert.ok(secondCheck && firstCheck);
  await assert.rejects(reviewQuality(accepted, fixture.tickets,
    async () => JSON.stringify({ ...output, breakdown: [firstCheck, { ...secondCheck, evidence: firstCheck.evidence }] }), signal), /未引用 T2/);
});

test("新建工单的两个验收字段均采用旧编号时也能修正一次", async () => {
  const { tickets } = await deviceTicketPlan();
  const allowed = new Set(tickets.flatMap(ticket => ticket.paths));
  let calls = 0;
  const result = await prepareVerifiedDraft(async feedback => {
    calls++;
    if (calls === 2) assert.match(feedback ?? "", /工单 T1 验收编号必须从本轮资料原样选择：AC-1、AC-2/);
    return JSON.stringify({ tickets: tickets.map(ticket => ({ ...ticket, editPaths: ticket.paths, sources: [],
      ...(calls === 1 && ticket.id === "T1"
        ? { criteria: ["AC-01"], validation: ticket.validation.map(item => ({ ...item, criterion: "AC-01" })) } : {}),
    })) });
  }, output => readDispatchTickets(output, ["AC-1", "AC-2"], allowed, "code", undefined, true, 16_000, true));
  assert.equal(calls, 2);
  assert.deepEqual(result.map(ticket => ticket.criteria), [["AC-1"], ["AC-2"]]);
});

test("逐单复核通过真实适配器协议完整接收超过旧上限的有效结果", async () => {
  const fixture = await deviceTicketPlan();
  const tickets = Array.from({ length: 12 }, (_, i) => {
    const sample = fixture.tickets[i % 2];
    assert.ok(sample);
    return { ...sample, id: `T${i + 1}`, instructions: "设备验收说明".repeat(48) };
  });
  const packet = fixture.packet(tickets);
  const original = qualityReviewOutput(packet);
  const breakdown = tickets.map(({ id }) => {
    const ref = `ticket:${id}`;
    const body = packet.references[ref];
    assert.ok(body);
    return { ticket: id, status: "pass", summary: "逐单核对验收依据".repeat(62),
      evidence: [0, 1, 2].map(start => ({ ref, quote: body.slice(start, start + 240) })) };
  });
  const output = JSON.stringify({ ...original, breakdown }, undefined, 2);
  assert.ok(output.length > 16_384);
  const appServer = fileURLToPath(new URL("./fixtures/codex-app-server.mjs", import.meta.url));
  const reviewer = createCodexQualityReviewer(process.cwd(), undefined, 5000, options =>
    startCodexReadOnlyTask({ ...options, command: [process.execPath, appServer, "quality-result", output] }));
  const receipt = await reviewQuality(packet, tickets, reviewer, new AbortController().signal);
  assert.equal(receipt.breakdown?.length, tickets.length);
  assert.equal(qualityBlock(receipt), "");
});

test("本地和 GitHub 工单复核都核对开工条件与未执行的验收", async () => {
  const fixture = await deviceTicketPlan();
  const variants = [fixture.tickets.map(({ delivery: _delivery, ...ticket }) => ticket), fixture.tickets];
  for (const [index, tickets] of variants.entries()) {
    const packet = fixture.packet(tickets);
    const reviewer = createCodexQualityReviewer(process.cwd(), undefined, 5000, ({ prompt, outputSchema }) => {
      assert.match(prompt, /验收回执待实际运行后取得/);
      assert.match(prompt, /确实必需的权限、外部资源或上游契约缺失时，应引用阻塞依据/);
      assert.equal(JSON.stringify(outputSchema).includes('"breakdown"'), index === 1);
      return { finished: Promise.resolve("completed"), close() {}, output: () => JSON.stringify(qualityReviewOutput(packet)) };
    });
    const receipt = await reviewQuality(packet, tickets, reviewer, new AbortController().signal);
    assert.equal(qualityBlock(receipt), "");
    const denied = createCodexQualityReviewer(process.cwd(), undefined, 5000, () => {
      const review = qualityReviewOutput(packet);
      return { finished: Promise.resolve("completed"), close() {}, output: () => JSON.stringify({
        ...review, evidence: { ...review.evidence, status: "block", summary: "缺少可信成员身份和读取授权" },
      }) };
    });
    const blocked = await reviewQuality(packet, tickets, denied, new AbortController().signal);
    assert.match(qualityBlock(blocked), /缺少可信成员身份和读取授权/);
    assert.equal(qualityCurrent(blocked, fixture.flow, tickets), false);
  }
});
