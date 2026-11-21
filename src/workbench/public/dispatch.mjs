const states = {
  queued: "排队中", running: "执行中", ready: "产物待验收", failed: "失败", blocked: "前置任务未完成",
};
const reviews = { accepted: "前置产物已通过", rejected: "前置产物未通过", invalid: "补丁版本已失效" };

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
  let currentFlow;
  let currentRuns = [];
  let currentRun;
  let hasPendingReview = false;
  let rendered;

  function path(action) {
    return `/api/workflows/${currentFlow.id}/local-dispatch/${action}`;
  }
  trigger.addEventListener("click", () => { if (currentFlow) dialog.showModal(); });
  document.querySelector("#close-dispatch").addEventListener("click", () => dialog.close());
  prepare.addEventListener("click", () => { if (currentFlow) void post(path("prepare"), { kind: kind.value }); });
  start.addEventListener("click", () => {
    if (currentFlow && !version.value && currentRun?.status === "ready") void post(path("start"), { id: currentRun.id });
  });
  review.addEventListener("click", () => {
    dialog.close();
    openDecisions("code-review");
  });
  kind.addEventListener("change", render);
  version.addEventListener("change", render);

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
    review.hidden = !!past || run?.kind !== "code" || !hasPendingReview;
    const key = JSON.stringify([currentFlow?.id, plan?.version, run, !!past]);
    if (rendered === key) return;
    rendered = key;
    prepare.hidden = !!past || (!!run && run.status !== "failed");
    prepare.textContent = run?.status === "failed" ? "重新准备工单" : "准备工单";
    start.hidden = !!past || run?.status !== "ready";
    status.textContent = past ? `计划 v${past.plan.version} 的历史批次。请切回当前版本准备或执行工单。`
      : !run ? `从开发计划 v${plan?.version ?? ""} 准备本地工单。代码补丁留在独立工作区，供人工复核。`
      : run.status === "preparing" ? "正在生成工单…"
        : run.status === "ready" ? `核对${run.kind === "code" ? "代码" : "核验"}工单后确认执行。使用开发计划 v${run.plan.version} 和仓库提交 ${run.revision.slice(0, 8)}，工作区未提交内容不在本轮资料内。`
          : run.status === "waiting" ? "前往「待决策」验收前置补丁，通过后继续执行。"
            : run.status === "running" ? "正在按依赖派发本机 Codex 会话…"
            : run.status === "finished" ? (run.kind === "code" ? "代码补丁已就绪，等待复核。" : "报告已就绪，等待验收。") : run.error ?? "部分工单未完成。";
    const previouslyOpen = new Set([...list.querySelectorAll("details[open]")].map(item => item.dataset.job));
    list.replaceChildren(...(run?.jobs ?? []).map(job => {
      const row = node("li");
      const item = node("details", "dispatch-job");
      item.dataset.job = job.id;
      item.open = previouslyOpen.has(job.id) || run.status === "ready";
      item.append(node("summary", "", `${job.id} · ${job.title} · ${reviews[job.artifact?.review] ?? states[job.status]}`),
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
    update(flow, runs, live, pendingReview) {
      currentFlow = live && flow?.status === "ready" ? flow : undefined;
      currentRuns = runs;
      hasPendingReview = pendingReview;
      trigger.hidden = !currentFlow;
      if (!currentFlow && dialog.open) dialog.close();
      render();
    },
  };
}
