import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import { createConversationFlows, phases, readPhaseOutput } from "../src/planning/conversation-flow.mts";

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
  assert.equal(flow.outputs[3]?.sections[0]?.text, "产物 PRD");
  assert.ok(manager.begin("第二条需求"));
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
  assert.deepEqual(readPhaseOutput(research, '```json\n{"场景与已有依据":"场景","待核实事项":"来源"}\n```'), ["场景", "来源"]);
  for (const output of ["no json", "[]", '{"场景与已有依据":"场景"}', '{"场景与已有依据":"场景","待核实事项":" "}']) {
    assert.equal(readPhaseOutput(research, output), undefined);
  }
});
