import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import { createConversationFlows, makePhasePrompt, phases, readPhaseOutput } from "../src/planning/conversation-flow.mts";

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
