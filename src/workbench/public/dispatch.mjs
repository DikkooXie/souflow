const states = {
  queued: "排队中", running: "执行中", ready: "产物待验收", failed: "失败", blocked: "前置任务未完成",
};

export function createDispatchPanel(node, post) {
  const dialog = document.querySelector("#dispatch-dialog");
  const trigger = document.querySelector("#open-dispatch");
  const prepare = document.querySelector("#prepare-dispatch");
  const start = document.querySelector("#start-dispatch");
  const status = document.querySelector("#dispatch-status");
  const list = document.querySelector("#dispatch-jobs");
  let currentFlow;
  let currentRun;
  let rendered;

  function path(action) {
    return `/api/workflows/${currentFlow.id}/local-dispatch/${action}`;
  }
  trigger.addEventListener("click", () => { if (currentFlow) dialog.showModal(); });
  document.querySelector("#close-dispatch").addEventListener("click", () => dialog.close());
  prepare.addEventListener("click", () => { if (currentFlow) void post(path("prepare")); });
  start.addEventListener("click", () => { if (currentFlow && currentRun?.status === "ready") void post(path("start"), { id: currentRun.id }); });

  return {
    get visible() { return dialog.open; },
    update(flow, runs, live) {
      currentFlow = live && flow?.status === "ready" ? flow : undefined;
      currentRun = currentFlow && runs.find(run => run.flowId === currentFlow.id);
      trigger.hidden = !currentFlow;
      if (!currentFlow && dialog.open) dialog.close();
      const run = currentRun;
      const key = JSON.stringify([currentFlow?.id, run]);
      if (rendered === key) return;
      rendered = key;
      prepare.hidden = !!run && run.status !== "failed";
      prepare.textContent = run?.status === "failed" ? "重新准备工单" : "准备工单";
      start.hidden = run?.status !== "ready";
      status.textContent = !run ? "从本轮开发计划生成本地只读核验工单。"
        : run.status === "preparing" ? "正在生成工单…"
          : run.status === "ready" ? `核对工单后确认执行。使用开发计划 v${run.plan.version} 和仓库提交 ${run.revision.slice(0, 8)}，工作区未提交内容不在本轮资料内。`
            : run.status === "running" ? "正在按依赖派发本机 Codex 会话…"
              : run.status === "finished" ? "报告已就绪，等待验收。" : run.error ?? "部分工单未完成。";
      const previouslyOpen = new Set([...list.querySelectorAll("details[open]")].map(item => item.dataset.job));
      list.replaceChildren(...(run?.jobs ?? []).map(job => {
        const row = node("li");
        const item = node("details", "dispatch-job");
        item.dataset.job = job.id;
        item.open = previouslyOpen.has(job.id) || run.status === "ready";
        item.append(node("summary", "", `${job.id} · ${job.title} · ${states[job.status]}`),
          node("p", "muted", job.dependsOn.length ? `前置工单 ${job.dependsOn.join("、")}` : "可独立执行"),
          node("p", "archive-text", job.instructions));
        if (job.sources.length) item.append(node("p", "muted", job.sources.join("、")));
        if (job.model) item.append(node("p", "muted", job.model));
        if (job.report) item.append(node("p", "archive-text", job.report));
        row.append(item);
        return row;
      }));
    },
  };
}
