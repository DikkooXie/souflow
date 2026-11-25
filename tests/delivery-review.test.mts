import assert from "node:assert/strict";
import test from "node:test";
import { type DeliveryReviewPacket, reviewDelivery } from "../src/planning/delivery-review.mts";

const sha = "a".repeat(40);
const packet: DeliveryReviewPacket = {
  key: { repo: "test/souflow", issue: 33, issueRevision: "b".repeat(64), pull: 34, head: sha, mergeBase: "c".repeat(40),
    plan: { id: "approved-plan", version: 2, quality: { policy: 1, flowDigest: "flow", batchDigest: "batch" } } },
  request: "让成员在自己的设备上连接工作台",
  criteria: [
    { criterion: "AC-1", text: "自己的设备重新上线", procedure: "关闭进程并重连", expected: "显示在线" },
    { criterion: "AC-2", text: "撤销的设备无法重连", procedure: "撤销凭据后重连", expected: "拒绝登录" },
  ],
  evidence: [
    { id: "src/devices.mts", kind: "change", text: "+if (isRevoked) return deny()" },
    { id: "reconnect", kind: "verification", criteria: ["AC-1"], text: "重连后显示在线" },
    { id: "revocation", kind: "verification", criteria: ["AC-2"], text: "重连返回拒绝登录" },
  ],
};

function code(status: "pass" | "block" = "pass") {
  return JSON.stringify({ status, summary: status === "block" ? "数据库失败路径缺少测试" : "实现覆盖关键路径",
    evidence: [{ ref: "src/devices.mts", quote: "if (isRevoked) return deny()" }] });
}
function requirements(status: "pass" | "block" = "pass", useWrongTest = false) {
  return JSON.stringify({ criteria: [
    { criterion: "AC-1", status: "pass", summary: "重新连接后上线",
      evidence: [{ ref: "criterion:AC-1", quote: "重新上线" }, { ref: "reconnect", quote: "显示在线" }] },
    { criterion: "AC-2", status, summary: status === "block" ? "遗漏撤销后的再次登录检查" : "撤销后拒绝连接",
      evidence: [{ ref: "criterion:AC-2", quote: "无法重连" }, ...(status === "block" ? [] : [
        useWrongTest ? { ref: "reconnect", quote: "显示在线" } : { ref: "revocation", quote: "拒绝登录" },
      ])] },
  ] });
}

test("实现和需求分别复核，同一快照上任一维度拦截都不能通过", async () => {
  for (const [implementation, product] of [["pass", "pass"], ["block", "pass"], ["pass", "block"]] as const) {
    const seen: DeliveryReviewPacket[] = [];
    const receipt = await reviewDelivery(packet, async (axis, snapshot) => {
      seen.push(snapshot);
      return axis === "implementation" ? code(implementation) : requirements(product);
    }, new AbortController().signal);
    assert.deepEqual(seen, [packet, packet]);
    assert.notEqual(seen[0], seen[1]);
    assert.equal(receipt.implementation?.status, implementation);
    assert.equal(receipt.requirements?.criteria[1]?.status, product);
    assert.equal(receipt.status, implementation === "pass" && product === "pass" ? "pass" : "block");
  }
});

test("引用其它验收项的测试或不存在的代码时保留可信的一侧，不能标记通过", async () => {
  const signal = new AbortController().signal;
  const wrongTest = await reviewDelivery(packet, async axis => axis === "implementation" ? code() : requirements("pass", true), signal);
  assert.equal(wrongTest.status, "incomplete");
  assert.equal(wrongTest.implementation?.status, "pass");
  assert.equal(wrongTest.requirements, undefined);
  const falseCode = await reviewDelivery(packet, async axis => axis === "implementation" ? code().replace("return deny()", "return allow()") : requirements(), signal);
  assert.equal(falseCode.status, "incomplete");
  assert.equal(falseCode.implementation, undefined);
  assert.equal(falseCode.requirements?.criteria.length, 2);
});

test("同一个文件的两处有效引文可并存，重复同一引文仍会被拦截", async () => {
  const signal = new AbortController().signal;
  const excerpt = { ref: "src/devices.mts", quote: "return deny()" };
  const withQuotes = (quote: string) => JSON.stringify({ ...JSON.parse(code()), evidence: [excerpt, { ...excerpt, quote }] });
  const distinct = await reviewDelivery(packet, async axis => axis === "implementation" ? withQuotes("isRevoked") : requirements(), signal);
  assert.equal(distinct.status, "pass");
  const duplicate = await reviewDelivery(packet, async axis => axis === "implementation" ? withQuotes(excerpt.quote) : requirements(), signal);
  assert.equal(duplicate.status, "incomplete");
});

test("同一 PR 的新提交或验收版本变化产生不同的复核标识", async () => {
  const run = async () => undefined;
  const signal = new AbortController().signal;
  const first = await reviewDelivery(packet, run, signal);
  const head = await reviewDelivery({ ...packet, key: { ...packet.key, head: "e".repeat(40) } }, run, signal);
  const plan = await reviewDelivery({ ...packet, key: { ...packet.key, plan: { ...packet.key.plan, version: 3 } } }, run, signal);
  assert.equal(new Set([first.packetId, head.packetId, plan.packetId]).size, 3);
});
