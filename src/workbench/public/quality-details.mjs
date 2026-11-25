const labels = { scope: "范围", evidence: "依据", verification: "验证" };

export function renderQualityDetails(details, node, quality, batchAcceptance = [], sourceFindings = []) {
  const sourceChecks = quality?.sourceChecks ?? sourceFindings;
  const hasEvidence = !!quality || sourceChecks.length > 0;
  const key = hasEvidence ? JSON.stringify([quality?.batchDigest, sourceChecks, batchAcceptance]) : "";
  details.hidden = !hasEvidence;
  if (details.dataset.batch === key) return;
  details.dataset.batch = key;
  details.open = false;
  details.replaceChildren();
  if (!hasEvidence) return;

  const checks = [...Object.entries(quality?.checks ?? {}).map(([dimension, check]) => [labels[dimension], check]),
    ...(quality?.breakdown ?? []).map(check => [`工单 ${check.ticket} · 拆分与排序`, check]),
    ...sourceChecks.map(check => [`工单 ${check.ticket} · 固定源码 ${check.revision.slice(0, 8)}`, check])];
  const blocked = checks.some(([, check]) => check.status === "block");
  const incomplete = !quality || quality.sourceChecks && quality.sourceChecks.length !== quality.breakdown?.length;
  const documents = node("ul");
  for (const { kind, id, version } of quality?.documents ?? []) {
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
  details.append(node("summary", "", `质量复核依据 · ${blocked ? "已拦截" : incomplete ? "证据不足" : "已通过"}`));
  if (quality) details.append(node("p", "", "绑定的产物版本"), documents);
  details.append(findings);
  if (batchAcceptance.length) {
    const pending = node("ul");
    for (const { criterion, owner, issue, procedure, expected } of batchAcceptance) {
      const location = owner === "batch" ? "整批验收" : `关联 Issue #${issue}`;
      pending.append(node("li", "archive-text", `${criterion} · ${location} · ${procedure} → ${expected}`));
    }
    details.append(node("p", "", "另行待验收（不建 Issue）"), pending);
  }
}

const reviewStates = { pass: "通过", block: "有阻塞", incomplete: "证据不完整" };

export function renderDeliveryReviews(details, node, flowId, entries) {
  details.hidden = !entries.length;
  const key = JSON.stringify([flowId, entries]);
  if (details.dataset.reviews === key) return;
  if (details.dataset.flow !== flowId) details.open = false;
  details.dataset.flow = flowId ?? "";
  details.dataset.reviews = key;
  details.replaceChildren();
  if (!entries.length) return;

  details.append(node("summary", "", "交付复核"));
  for (const entry of entries) {
    const current = entry.reviews.find(review => review.current);
    const state = entry.running ? "正在复核" : current ? reviewStates[current.status] : entry.unavailable ? "证据暂不可用" : "等待复核";
    details.append(node("p", "", `Issue #${entry.number} · PR #${entry.pull} · ${entry.head.slice(0, 8)} · ${state}`));
    for (const review of [...entry.reviews].reverse()) {
      const row = node("details");
      const when = review.current ? "当前" : "历史";
      row.append(node("summary", "", `${when} · ${review.key.head.slice(0, 8)} · 计划 v${review.key.plan.version} · ${reviewStates[review.status]}`));
      row.append(reviewAxis(node, "代码与测试质量", review.implementation ? [["实现", review.implementation]] : []),
        reviewAxis(node, "需求与验收", (review.requirements?.criteria ?? []).map(check => [check.criterion, check])));
      details.append(row);
    }
  }
}

function reviewAxis(node, title, findings) {
  const section = node("details");
  section.append(node("summary", "", title));
  if (!findings.length) section.append(node("p", "", "未取得可核查的复核结论。"));
  for (const [label, finding] of findings) {
    section.append(node("p", "archive-text", `${label} · ${reviewStates[finding.status]} · ${finding.summary}`));
    const references = node("ul");
    for (const { ref, quote } of finding.evidence) references.append(node("li", "archive-text", `${ref} · ${quote}`));
    section.append(references);
  }
  return section;
}
