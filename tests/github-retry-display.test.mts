import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { setImmediate } from "node:timers/promises";
import { runInNewContext } from "node:vm";
import test from "node:test";

test("工单面板按实际累计次数显示重试，不把恢复描述为自动执行或补丁格式修复", async () => {
  function element() {
    return Object.assign(new EventTarget(), { open: false, hidden: false, textContent: "", disabled: false,
      showModal() { this.open = true; }, close() { this.open = false; },
      contains: () => false, append() {}, replaceChildren() {}, querySelectorAll: () => [] });
  }
  const elements = new Map<string, ReturnType<typeof element>>();
  const get = (selector: string) => {
    const value = elements.get(selector) ?? element();
    elements.set(selector, value);
    return value;
  };
  const texts: string[] = [];
  const node = (_tag: string, _className?: string, text?: string) => {
    if (text) texts.push(text);
    return element();
  };
  let retryCount = 1;
  const source = await readFile(new URL("../src/workbench/public/github-issues.mjs", import.meta.url), "utf8");
  runInNewContext(`${source.replace(/^import .*;\n/gm, "").replace("export function", "function")}\ncreateGithubPanel(node, () => {});`, {
    node, URL, AbortSignal, document: { querySelector: get, createTextNode: (text: string) => node("text", "", text) },
    sessionStorage: { getItem: () => undefined }, setTimeout() {}, clearTimeout() {},
    fetch: async () => ({ ok: true, json: async () => ({ repo: "fixture/recovery", canClaim: false, conversationEnabled: true,
      items: [{ number: 2, title: "下游工单", url: "https://github.com/fixture/recovery/issues/2", state: "OPEN", assignees: [],
        mode: "delivery", progress: "开发或测试失败", pulls: [], retryCount }] }) }),
  });
  get("#open-github").dispatchEvent(new Event("click"));
  await setImmediate();
  assert.ok(texts.includes("已安排 1 次重试"));
  texts.length = 0;
  retryCount = 3;
  get("#refresh-github").dispatchEvent(new Event("click"));
  await setImmediate();
  assert.ok(texts.includes("已安排 3 次重试"));
  assert.doesNotMatch(texts.join("\n"), /自动重试|补丁格式修复/);
});
