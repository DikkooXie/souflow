const states = {
  queued: "排队中", running: "执行中", ready: "产物待验收", failed: "失败", blocked: "前置任务未完成",
};
const reviews = { accepted: "前置产物已通过", rejected: "前置产物未通过", invalid: "补丁版本已失效" };
const deliveryStates = { submitted: "待最终验收", returned: "已退回修订", accepted: "最终验收已通过" };
const time = new Intl.DateTimeFormat("zh-CN", { dateStyle: "short", timeStyle: "medium" });

export function createDispatchPanel(node, post, openDecisions) {
  const dialog = document.querySelector("#dispatch-dialog");
  const trigger = document.querySelector("#open-dispatch");
  const prepare = document.querySelector("#prepare-dispatch");
  const kind = document.querySelector("#dispatch-kind");
  const history = document.querySelector("#dispatch-history");
  const version = document.querySelector("#dispatch-version");
  const start = document.querySelector("#start-dispatch");
  const review = document.querySelector("#review-dispatch");
  const status = document.querySelector("#dispatch-status");
  const list = document.querySelector("#dispatch-jobs");
  const delivery = document.querySelector("#delivery-review");
  const deliveryStatus = document.querySelector("#delivery-status");
  const deliveryHistory = document.querySelector("#delivery-history");
  const deliveryForm = document.querySelector("#delivery-actions");
  const note = document.querySelector("#delivery-note");
  let currentFlow;
  let currentRuns = [];
  let currentRun;
  let hasPendingReview = false;
  let rendered;
  let member;
  let displayedRun;
  let submitting = false;
  let kindTouched = false;

  function path(action) {
    return `/api/workflows/${currentFlow.id}/local-dispatch/${action}`;
  }
  trigger.addEventListener("click", () => {
    if (!currentFlow) return;
    const submitted = currentRuns.find(run => run.flowId === currentFlow.id && run.acceptance?.at(-1)?.decision === "submitted");
    if (submitted) {
      kind.value = submitted.kind;
      version.value = "";
      render();
    }
    dialog.showModal();
  });
  document.querySelector("#close-dispatch").addEventListener("click", () => dialog.close());
  prepare.addEventListener("click", () => { if (currentFlow) void post(path("prepare"), { kind: kind.value }); });
  start.addEventListener("click", () => {
    if (currentFlow && !version.value && currentRun?.status === "ready") void post(path("start"), { id: currentRun.id });
  });
  review.addEventListener("click", () => {
    dialog.close();
    openDecisions("code-review");
  });
  kind.addEventListener("change", () => {
    kindTouched = true;
    render();
  });
  version.addEventListener("change", render);
  deliveryForm.addEventListener("submit", async event => {
    event.preventDefault();
    if (!displayedRun || !event.submitter || submitting) return;
    submitting = true;
    try {
      if (await post(`/api/acceptance/${displayedRun.id}/${event.submitter.value}`, { note: note.value })) {
        deliveryForm.reset();
      }
    } finally {
      submitting = false;
    }
  });

  function renderDelivery(run, locked, historical) {
    if (displayedRun?.id !== run?.id) deliveryForm.reset();
    displayedRun = run;
    delivery.hidden = !member || run?.status !== "finished";
    if (delivery.hidden) return;
    const receipts = run.acceptance;
    const state = receipts.at(-1)?.decision;
    deliveryStatus.textContent = state === "returned" && !historical ? "已退回。请修改开发计划并重新执行工单。"
      : deliveryStates[state] ?? (historical ? "历史批次未提交验收。" : "产物已就绪，等待实施成员提交。");
    deliveryHistory.replaceChildren(...receipts.map(receipt => {
      const item = node("li");
      const stamp = node("time", "muted", time.format(new Date(receipt.at)));
      stamp.dateTime = receipt.at;
      item.append(node("strong", "", `${receipt.actor.label} · ${deliveryStates[receipt.decision]}`),
        stamp, node("p", "archive-text", receipt.note));
      return item;
    }));
    const submit = !historical && !locked && !state && member.id === "implementer";
    const decide = !historical && state === "submitted" && member.id === "reviewer";
    deliveryForm.hidden = !submit && !decide;
    for (const button of deliveryForm.querySelectorAll("button")) button.hidden = button.value === "submit" ? !submit : !decide;
  }

  function render() {
    const plan = currentFlow?.outputs.flatMap(output => output.artifacts).find(artifact => artifact.kind === "development-plan");
    const candidates = currentRuns.filter(run => run.flowId === currentFlow?.id && run.kind === kind.value);
    currentRun = candidates.find(run => run.plan.id === plan?.id && run.plan.version === plan.version);
    const older = candidates.filter(run => run.plan.version < plan?.version).toReversed();
    const versionsKey = JSON.stringify([currentFlow?.id, kind.value, plan?.version, older.map(run => run.id)]);
    if (version.dataset.key !== versionsKey) {
      version.dataset.key = versionsKey;
      const previous = version.value;
      const latest = node("option", "", `当前计划 v${plan?.version ?? ""}`);
      latest.value = "";
      version.replaceChildren(latest, ...older.map(run => {
        const option = node("option", "", `计划 v${run.plan.version}（历史）`);
        option.value = run.id;
        return option;
      }));
      version.value = older.some(run => run.id === previous) ? previous : "";
    }
    history.hidden = !older.length;
    const past = older.find(run => run.id === version.value);
    const run = past ?? currentRun;
    const locked = currentRuns.some(item => item.flowId === currentFlow?.id && item.plan.version === plan?.version
      && ["submitted", "accepted"].includes(item.acceptance?.at(-1)?.decision));
    review.hidden = !!past || run?.kind !== "code" || !hasPendingReview;
    const key = JSON.stringify([currentFlow?.id, plan?.version, run, !!past, member?.id, locked]);
    if (rendered === key) return;
    rendered = key;
    prepare.hidden = member?.id === "reviewer" || locked || !!past || (!!run && run.status !== "failed");
    prepare.textContent = run?.status === "failed" ? "重新准备工单" : "准备工单";
    start.hidden = member?.id === "reviewer" || locked || !!past || run?.status !== "ready";
    status.textContent = past ? `计划 v${past.plan.version} 的历史批次。请切回当前版本准备或执行工单。`
      : !run ? `从开发计划 v${plan?.version ?? ""} 准备本地工单。代码补丁留在独立工作区，供人工复核。`
      : run.status === "preparing" ? "正在生成工单…"
        : run.status === "ready" ? `核对${run.kind === "code" ? "代码" : "核验"}工单后确认执行。使用开发计划 v${run.plan.version} 和仓库提交 ${run.revision.slice(0, 8)}，工作区未提交内容不在本轮资料内。`
          : run.status === "waiting" ? "前往「待决策」验收前置补丁，通过后继续执行。"
            : run.status === "running" ? "正在按依赖派发本机 Codex 会话…"
            : run.status === "finished" ? (run.kind === "code" ? "代码补丁已生成。" : "核验报告已生成。") : run.error ?? "部分工单未完成。";
    renderDelivery(run, locked, !!past);
    const previouslyOpen = new Set([...list.querySelectorAll("details[open]")].map(item => item.dataset.job));
    list.replaceChildren(...(run?.jobs ?? []).map(job => {
      const row = node("li");
      const item = node("details", "dispatch-job");
      item.dataset.job = job.id;
      item.open = previouslyOpen.has(job.id) || run.status === "ready";
      const accepted = run.acceptance?.at(-1)?.decision === "accepted";
      item.append(node("summary", "", `${job.id} · ${job.title} · ${accepted ? "随批次验收通过" : reviews[job.artifact?.review] ?? states[job.status]}`),
        node("p", "muted", job.dependsOn.length ? `前置工单 ${job.dependsOn.join("、")}` : "可独立执行"),
        node("p", "archive-text", job.instructions));
      if (job.sources.length) item.append(node("p", "muted", job.sources.join("、")));
      if (job.editPaths?.length) item.append(node("p", "archive-text", `允许编辑 · ${job.editPaths.join("、")}`));
      if (job.changedFiles?.length) item.append(node("p", "archive-text", `已修改 · ${job.changedFiles.join("、")}`));
      if (job.patchPath) item.append(node("p", "archive-text", `本地补丁 · ${job.patchPath}`));
      if (job.artifact?.upstream.length) {
        item.append(node("p", "muted", `使用的已验收补丁 · ${job.artifact.upstream.map(item => `${item.ticketId} ${item.patchSha256.slice(0, 12)}`).join("、")}`));
      }
      if (job.error) item.append(node("p", "error", job.error));
      if (job.modelRoute) item.append(node("p", "muted", `计划模型 ${job.modelRoute.requestedModel} · ${job.modelRoute.reason}`));
      if (job.model) item.append(node("p", "muted", `实际模型 ${job.model}`));
      if (job.report) item.append(node("p", "archive-text", job.report));
      row.append(item);
      return row;
    }));
  }

  return {
    get visible() { return dialog.open; },
    update(flow, runs, live, pendingReview, currentMember, noteLimit) {
      const next = live && flow?.status === "ready" ? flow : undefined;
      if (currentFlow?.id !== next?.id) kindTouched = false;
      currentFlow = next;
      currentRuns = runs;
      hasPendingReview = pendingReview;
      member = currentMember;
      if (member?.id === "reviewer" && !kindTouched) {
        const related = runs.filter(run => run.flowId === currentFlow?.id);
        const preferred = related.find(run => run.acceptance?.at(-1)?.decision === "submitted") ?? related.at(-1);
        if (preferred) kind.value = preferred.kind;
      }
      if (noteLimit) note.maxLength = noteLimit;
      trigger.hidden = !currentFlow;
      trigger.textContent = currentFlow && currentRuns.some(run => run.flowId === currentFlow.id
        && run.acceptance?.at(-1)?.decision === "submitted") ? "本地执行工单 · 待最终验收" : "本地执行工单";
      if (!currentFlow && dialog.open) dialog.close();
      render();
    },
  };
}
