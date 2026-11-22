import assert from "node:assert/strict";
import test from "node:test";
import type { QualityReceipt } from "../src/planning/dispatch-quality.mts";

class Element {
  dataset: Record<string, string> = {};
  children: Element[] = [];
  hidden = true;
  open = false;
  readonly text: string;
  constructor(text = "") { this.text = text; }
  append(...children: Element[]) { this.children.push(...children); }
  replaceChildren() { this.children = []; }
  get textContent(): string { return [this.text, ...this.children.map(child => child.textContent)].join(" "); }
}

const node = (_tag: string, _className?: string, text?: string) => new Element(text);

test("质量依据使用纯文本，轮询保留展开状态，切换批次或缺回执时清理旧详情", async () => {
  const { renderQualityDetails }: {
    renderQualityDetails(details: Element, createNode: typeof node, quality?: QualityReceipt): void;
  } = await import(new URL("../src/workbench/public/quality-details.mjs", import.meta.url).href);
  const pass = { status: "pass" as const, summary: "符合验收要求", evidence: [{ ref: "request", quote: "<b>引用原文</b>" }] };
  const quality: QualityReceipt = {
    policy: 1, flowDigest: "flow", batchDigest: "first",
    documents: [{ kind: "development-plan", id: "plan", version: 2 }],
    checks: { scope: pass, evidence: pass, verification: pass },
  };
  const details = new Element();
  renderQualityDetails(details, node, quality);
  assert.equal(details.hidden, false);
  assert.equal(details.open, false);
  assert.match(details.children[0]?.text ?? "", /已通过/);
  assert.match(details.textContent, /development-plan · v2 · plan/);
  assert.match(details.textContent, /request · <b>引用原文<\/b>/);
  const summary = details.children[0];
  details.open = true;
  renderQualityDetails(details, node, structuredClone(quality));
  assert.equal(details.open, true);
  assert.equal(details.children[0], summary);
  renderQualityDetails(details, node, { ...quality, batchDigest: "second", checks: {
    ...quality.checks, scope: { ...pass, status: "block", summary: "超出范围" },
  } });
  assert.equal(details.open, false);
  assert.match(details.children[0]?.text ?? "", /已拦截/);
  assert.match(details.textContent, /范围 · 拦截 · 超出范围/);
  renderQualityDetails(details, node);
  assert.equal(details.hidden, true);
  assert.deepEqual(details.children, []);
});
