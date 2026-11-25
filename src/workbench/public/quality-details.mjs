const labels = { scope: "范围", evidence: "依据", verification: "验证" };

export function renderQualityDetails(details, node, quality) {
  const key = quality ? JSON.stringify([quality.batchDigest, quality.sourceChecks]) : "";
  details.hidden = !quality;
  if (details.dataset.batch === key) return;
  details.dataset.batch = key;
  details.open = false;
  details.replaceChildren();
  if (!quality) return;

  const checks = [...Object.entries(quality.checks).map(([dimension, check]) => [labels[dimension], check]),
    ...(quality.breakdown ?? []).map(check => [`工单 ${check.ticket} · 拆分与排序`, check]),
    ...(quality.sourceChecks ?? []).map(check => [`工单 ${check.ticket} · 固定源码 ${check.revision.slice(0, 8)}`, check])];
  const blocked = checks.some(([, check]) => check.status === "block");
  const incomplete = quality.sourceChecks && quality.sourceChecks.length !== quality.breakdown?.length;
  const documents = node("ul");
  for (const { kind, id, version } of quality.documents) {
    documents.append(node("li", "", `${kind} · v${version} · ${id}`));
  }
  const findings = node("ul");
  for (const [label, check] of checks) {
    const finding = node("li", "archive-text",
      `${label} · ${check.status === "block" ? "拦截" : "通过"} · ${check.summary}`);
    const quotes = node("ul");
    for (const { ref, quote } of check.evidence) {
      quotes.append(node("li", "", `${ref} · ${quote}`));
    }
    finding.append(quotes);
    findings.append(finding);
  }
  details.append(node("summary", "", `质量复核依据 · ${blocked ? "已拦截" : incomplete ? "证据不足" : "已通过"}`),
    node("p", "", "绑定的产物版本"), documents, findings);
}
