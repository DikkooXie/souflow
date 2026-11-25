import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import { createConversationFlows, makePhasePrompt, phases, readPhaseOutput, type StoredFlow } from "../src/planning/conversation-flow.mts";

test("runs phases in order and hands later phases the collected outputs", async () => {
  const manager = createConversationFlows(async (flow, phase) => {
    const index = phases.indexOf(phase);
    assert.deepEqual(flow.outputs.map(output => output.title), phases.slice(0, index).map(step => step.title));
    return phase.fields.map(field => `产物 ${field}`);
  }, 1);
  const flow = manager.begin("开发一个游戏");
  assert.ok(flow);
  assert.equal(manager.begin("第二条需求"), undefined);
  await setImmediate();
  assert.equal(flow.status, "ready");
  assert.equal(flow.outputs[3]?.artifacts[0]?.sections[0]?.text, "产物 PRD");
  assert.ok(manager.begin("第二条需求"));
});

test("records each artifact and its exact upstream versions for independently started flows", async () => {
  const prompts = new Map<string, string>();
  const manager = createConversationFlows(async (flow, phase, targets) => {
    if (phase.title === "开发文档") prompts.set(flow.id, makePhasePrompt(flow, phase, targets));
    return phase.fields.map(field => `产物 ${field}`);
  }, 2);
  const first = manager.begin("导出工单");
  const second = manager.begin("导出工单");
  assert.ok(first && second);
  await setImmediate();
  for (const flow of [first, second]) {
    assert.equal(flow.status, "ready");
    assert.deepEqual(flow.source, { id: `${flow.id}/request`, version: 1, kind: "request", upstream: [] });
    const artifacts = flow.outputs.flatMap(output => output.artifacts);
    const ref = (kind: string) => ({ id: `${flow.id}/${kind}`, version: 1 });
    assert.deepEqual(artifacts.map(({ kind, id, version, upstream }) => ({ kind, id, version, upstream })), [
      { kind: "research", ...ref("research"), upstream: [ref("request")] },
      { kind: "requirements", ...ref("requirements"), upstream: [ref("research")] },
      { kind: "technology", ...ref("technology"), upstream: [ref("requirements")] },
      { kind: "prd", ...ref("prd"), upstream: [ref("requirements")] },
      { kind: "development-plan", ...ref("development-plan"), upstream: [ref("prd"), ref("technology")] },
      { kind: "ticket-drafts", ...ref("ticket-drafts"), upstream: [ref("development-plan")] },
    ]);
    assert.deepEqual(flow.outputs[3]?.artifacts.map(artifact => artifact.sections.map(section => section.title)), [["PRD"], ["开发计划"]]);
    const prompt = prompts.get(flow.id) ?? "";
    assert.ok(prompt.includes(JSON.stringify({ ...flow.source, text: flow.prompt })));
    assert.ok(prompt.includes(JSON.stringify({ kind: "development-plan", ...ref("development-plan"), upstream: [ref("prd"), ref("technology")] })));
    assert.match(prompt, /区分开工条件和交付证据/);
    assert.match(prompt, /由本工单建立的测试环境和实现后才有的请求、审计或交付回执，写成验收步骤/);
  }
  assert.notEqual(first.source.id, second.source.id);
});

test("does not record either document or draft tickets if a document phase fails", async () => {
  const manager = createConversationFlows(async (_flow, phase) => {
    assert.notEqual(phase.title, "拆单");
    return phase.title === "开发文档" ? ["仅返回 PRD", " "] : phase.fields.map(field => `产物 ${field}`);
  }, 1);
  const flow = manager.begin("为工单增加导出");
  assert.ok(flow);
  await setImmediate();
  assert.equal(flow.status, "failed");
  assert.deepEqual(flow.outputs.flatMap(output => output.artifacts).map(artifact => artifact.kind), ["research", "requirements", "technology"]);
});

test("stops on invalid output and discards work completed after reset", async () => {
  const failed = createConversationFlows(async () => ["只返回一个字段"], 1);
  const incomplete = failed.begin("无效产物");
  assert.ok(incomplete);
  let complete!: (value: string[]) => void;
  const manager = createConversationFlows(() => new Promise(resolve => { complete = resolve; }), 1);
  const old = manager.begin("已重置需求");
  assert.ok(old);
  manager.reset();
  complete(["产物一", "产物二"]);
  await setImmediate();
  assert.equal(incomplete.status, "failed");
  assert.deepEqual(incomplete.outputs, []);
  assert.deepEqual(manager.list(), []);
  assert.deepEqual(old.outputs, []);
});

test("accepts only nonempty bounded outputs for the selected phase", () => {
  const [research] = phases;
  assert.ok(research);
  assert.deepEqual(readPhaseOutput(research, '```json\n{"场景与已有依据":"场景","待核实事项":"来源"}\n```'), ["场景", "来源"]);
  for (const output of ["no json", "[]", '{"场景与已有依据":"场景"}', '{"场景与已有依据":"场景","待核实事项":" "}']) {
    assert.equal(readPhaseOutput(research, output), undefined);
  }
});

test("在原会话沿用答复重新规划，锁定新基线并保留旧版产物", async () => {
  const saved = new Map<string, StoredFlow>();
  const oldBase = "a".repeat(40);
  const newBase = "b".repeat(40);
  const clarification = { cardId: "card", questionId: "login", question: "执行账号", answer: "沿用设备自己的登录。" };
  const corrected = { ...clarification, cardId: "updated-card", answer: "试用改用专用账号。" };
  const planned: { version: number; base: string | undefined }[] = [];
  const answers = [clarification];
  let revision = oldBase;
  let rejectWrite = false;
  let interruption = false;
  const manager = () => createConversationFlows(async (flow, phase, targets, planText) => {
    if (flow.replan) {
      const prompt = makePhasePrompt(flow, phase, targets, planText);
      assert.ok(prompt.includes(clarification.answer));
      assert.ok(prompt.includes("补齐登录前置"));
      assert.match(prompt, /真实权限、外部访问限制和必须先合入的依赖继续核查/);
      assert.ok(prompt.includes(`项目计划 ${newBase}`));
      assert.ok(prompt.includes("保留旧版验收编号"));
      if (interruption && phase.title === "需求澄清") return "interrupted";
      if (phase.title === "需求澄清") answers.push(corrected);
      if (phase.title === "技术选型") assert.ok(prompt.includes(corrected.answer));
    }
    return phase.fields.map(field => field === "验收条件" && !flow.replan ? "保留旧版验收编号"
      : `${field} ${flow.project?.repository?.revision}`);
  }, 1, undefined, async () => ({
    evidence: { repository: { revision, commits: [] }, plan: { status: "read" }, github: { status: "unconfigured" } },
    planText: `项目计划 ${revision}`,
  }), { load: () => [...saved.values()].map(value => structuredClone(value)),
    save(id, value) {
      if (rejectWrite) return false;
      saved.set(id, structuredClone(value));
      return true;
    },
  }, flow => {
    const plan = flow.outputs.flatMap(output => output.artifacts).find(artifact => artifact.kind === "development-plan");
    assert.ok(plan);
    planned.push({ version: plan.version, base: flow.project?.repository?.revision });
    return true;
  }, () => structuredClone(answers));

  const first = manager();
  const flow = first.begin("支持新人自行连接设备。", "owner");
  assert.ok(flow);
  await first.settled();
  const originals = structuredClone(flow.outputs.flatMap(output => output.artifacts));
  assert.equal(originals.length, 6);
  assert.deepEqual(flow.clarifications, [clarification]);
  revision = newBase;
  const feedback = { batchId: "blocked-batch", findings: "补齐登录前置" };
  assert.equal(first.replan(flow, feedback, "other"), 409);
  rejectWrite = true;
  assert.equal(first.replan(flow, feedback, "owner"), 503);
  assert.equal(flow.project?.repository?.revision, oldBase);
  assert.deepEqual(flow.outputs.flatMap(output => output.artifacts), originals);
  rejectWrite = false;
  interruption = true;
  assert.equal(first.replan(flow, feedback, "owner"), 200);
  assert.equal(first.replan(flow, feedback, "owner"), 409);
  await first.settled();
  assert.equal(flow.status, "interrupted");
  assert.equal(flow.project?.repository?.revision, newBase);

  const restarted = manager();
  const resumed = restarted.list()[0];
  assert.ok(resumed);
  interruption = false;
  assert.equal(restarted.resume(resumed), 200);
  await restarted.settled();
  assert.equal(resumed.id, flow.id);
  assert.deepEqual(resumed.planHistory, originals);
  assert.deepEqual(resumed.clarifications, [clarification, corrected]);
  for (const artifact of resumed.outputs.flatMap(output => output.artifacts)) {
    assert.equal(artifact.version, 2);
    assert.deepEqual(artifact.replaces, { id: artifact.id, version: 1 });
    assert.ok(artifact.upstream.every(ref => ref.version === (ref.id === resumed.source.id ? 1 : 2)));
    const linked = artifact.kind === "research" ? [clarification] : [clarification, corrected];
    assert.deepEqual(artifact.clarificationInputs, linked.map(({ cardId, questionId }) => ({ cardId, questionId })));
  }
  assert.deepEqual(planned, [{ version: 1, base: oldBase }, { version: 2, base: newBase }]);
});
