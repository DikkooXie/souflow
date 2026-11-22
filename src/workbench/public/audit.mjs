const controls = {
  "open-home": "返回首页", "open-audit": "打开看板", "select-flow": "切换需求对话",
  "open-decisions": "打开决策收件箱", "open-card": "打开决策气泡", "more-decisions": "查看其余决策",
  "close-decisions": "关闭决策", "select-decision": "切换决策事项", "send-request": "发送需求",
  "send-answer": "发送回答", "select-option": "选择回答", "simulation-disconnect": "模拟断线",
  "reset-demo": "重置演示", "open-artifact": "查看阶段产物", "open-history": "查看决策时间线",
  "change-audit-range": "切换统计范围", "change-log-type": "切换记录类型", "refresh-audit": "刷新看板",
  "toggle-audit-log": "展开或收起最近记录",
  "toggle-conversations": "展开或收起最近对话", "new-conversation": "新建对话",
  "open-archive": "打开项目文档", "close-archive": "关闭项目文档",
  "open-local-dispatch": "查看本地工单", "prepare-local-dispatch": "准备本地工单", "start-local-dispatch": "确认并执行工单", "edit-plan": "修改开发计划",
  "open-monitor": "打开调度面板", "resume-workflow": "继续未完成的规划",
  "open-github": "打开 GitHub 工单", "close-github": "关闭 GitHub 工单", "claim-github": "领取 GitHub 工单", "refresh-github": "同步 GitHub 工单",
};
const names = { home: "首页", conversation: "需求对话", decisions: "决策收件箱", audit: "数据看板", archive: "项目文档", "dispatch-monitor": "调度面板", "github-issues": "GitHub 工单" };
const events = {
  "github.issue": "GitHub 工单认领与派发",
  "request.submitted": "提交需求", "phase.started": "开始阶段", "phase.completed": "完成阶段", "plan.revised": "更新开发计划",
  "flow.finished": "流程结束", "flow.resumed": "继续未完成的规划", "decision.opened": "发出决策请求", "decision.answered": "提交决策答复",
  "decision.updated": "决策状态更新", "demo.reset": "重置演示",
  "attempt.started": "启动 Codex 尝试", "attempt.finished": "Codex 尝试结束", "model.started": "Codex 模型配置",
  "dispatch.prepared": "工单已就绪", "dispatch.started": "确认本地派发", "dispatch.reviewed": "验收前置补丁", "dispatch.finished": "本地派发结束",
  "dispatch.account-assigned": "分配 Codex 账号",
  "remote.device": "局域网设备接入", "remote.job": "远端工单交接",
  "member.denied": "成员越权被拒", "member.revised": "成员修订开发计划", "acceptance.decided": "成员批次验收",
};

export function createAuditView(node) {
  const session = crypto.randomUUID();
  const range = document.querySelector("#audit-range");
  const logType = document.querySelector("#audit-log-type");
  const logCount = document.querySelector("#audit-log-count");
  const status = document.querySelector("#audit-status");
  const formatNumber = new Intl.NumberFormat("zh-CN");
  const formatTime = new Intl.DateTimeFormat("zh-CN", { dateStyle: "short", timeStyle: "medium" });
  let pending = Promise.resolve();
  let revision = 0;
  let dropped = 0;
  let latest;

  function send(event) {
    const payload = JSON.stringify({ ...event, id: crypto.randomUUID(), session, elapsed: Math.floor(performance.now()) });
    pending = pending.then(async () => {
      try {
        const response = await fetch("/api/activity", {
          method: "POST", headers: { "Content-Type": "application/json" }, body: payload,
          keepalive: true, signal: AbortSignal.timeout(3000),
        });
        if (!response.ok) dropped += 1;
      } catch {
        dropped += 1;
      }
    });
  }

  async function refresh() {
    const current = ++revision;
    const days = range.value;
    try {
      await pending;
      const response = await fetch(`/api/audit?days=${encodeURIComponent(days)}`, { signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw Error();
      const report = await response.json();
      if (current !== revision) return;
      status.textContent = `统计更新于 ${formatTime.format(report.generatedAt)} · 本机记录`;
      if (report.missed || dropped) status.textContent += " · 有记录写入失败，统计可能不完整";
      latest = report;
      render(report);
    } catch {
      if (current === revision) status.textContent = "刷新失败，已显示的数据可能过期。";
    }
  }

  function ranking(selector, entries, label, secondary, empty) {
    const list = document.querySelector(selector);
    const max = Math.max(1, ...entries.map(entry => entry.count));
    list.replaceChildren(...entries.map(entry => {
      const row = node("li", "audit-row");
      const title = label(entry);
      const meter = node("meter");
      meter.max = max;
      meter.value = entry.count;
      meter.setAttribute("aria-hidden", "true");
      const metadata = node("div", "audit-row-meta");
      metadata.append(node("strong", "", title), node("span", "", `${formatNumber.format(entry.count)} 次 · ${secondary(entry)}`));
      row.append(metadata, meter);
      return row;
    }));
    if (!entries.length) list.append(node("li", "audit-empty", empty));
  }

  function render(report) {
    const { repeatClickMs, quickReturnMs, insightMinCount } = report.thresholds;
    const seconds = ms => formatNumber.format(ms / 1000);
    document.querySelector("#audit-click-rule").textContent =
      `同一标签页、同一视图，${seconds(repeatClickMs)} 秒内连续操作同一控件和对象，计为重复。`;
    document.querySelector("#audit-return-rule").textContent =
      `同一标签页内，${seconds(quickReturnMs)} 秒内切回上一个视图，计为一次快速返回。`;
    const metrics = [["提交需求", "request.submitted"], ["决策答复", "decision.answered"], ["控件操作", "ui.click"], ["视图切换", "ui.navigate"]];
    document.querySelector("#audit-totals").replaceChildren(...metrics.map(([label, key]) => {
      const pair = node("div", "audit-total");
      pair.append(node("dt", "", label), node("dd", "", formatNumber.format(report.totals[key] ?? 0)));
      return pair;
    }));
    const pathName = entry => `${names[entry.first]} ↔ ${names[entry.second]}`;
    const clickName = entry => controls[entry.control] ?? entry.control;
    ranking("#audit-clicks", report.clicks, clickName, entry => `${entry.repeated} 次重复`, "暂无控件操作。");
    ranking("#audit-paths", report.transitions, pathName, entry => `${entry.reversals} 次快速返回`, "暂无视图切换。");
    const frequent = report.transitions.filter(entry => entry.reversals >= insightMinCount).slice(0, 3).map(entry =>
      `${pathName(entry)}有 ${entry.reversals} 次快速返回。可以试验把常用内容并排展示，或在当前页面内展开。`);
    const repeated = report.clicks.filter(entry => entry.repeated >= insightMinCount).slice(0, 2).map(entry =>
      `「${clickName(entry)}」有 ${entry.repeated} 次连续重复。可检查是否缺少操作反馈，或是否适合合并操作。`);
    const insights = [...frequent, ...repeated];
    const empty = `当前范围暂无达到 ${formatNumber.format(insightMinCount)} 次的重复或快速返回。`;
    document.querySelector("#audit-insights").replaceChildren(...(insights.length ? insights : [empty])
      .map(insight => node("li", "", insight)));
    renderLog(report);
  }

  function renderLog(report) {
    const interaction = logType.value === "interaction";
    const entries = interaction ? report.interactions : report.recent;
    logCount.textContent = `显示 ${formatNumber.format(entries.length)} 条`;
    const log = document.querySelector("#audit-events");
    const previous = new Set([...log.querySelectorAll("details[open]")].map(item => item.dataset.event));
    log.replaceChildren(...entries.map(entry => {
      const row = node("li", "audit-event");
      const time = node("time", "", formatTime.format(entry.at));
      time.dateTime = new Date(entry.at).toISOString();
      const content = node("details");
      content.dataset.event = String(entry.id);
      content.open = previous.has(content.dataset.event);
      const shortFlow = entry.flowId?.slice(0, 8);
      const shortAttempt = entry.attemptId?.slice(0, 8);
      const jobCounts = entry.kind === "dispatch.finished" ? entry.jobCounts : undefined;
      const title = interaction ? entry.kind === "ui.click" ? controls[entry.control] : `${names[entry.view]} → ${names[entry.destination]}`
        : [
          events[entry.kind] ?? entry.kind,
          shortFlow && `流程 ${shortFlow}`,
          shortAttempt && `尝试 ${shortAttempt}`,
          jobCounts && `待验收 ${formatNumber.format(jobCounts.ready)}`,
          jobCounts && `失败 ${formatNumber.format(jobCounts.failed)}`,
          jobCounts && `阻塞 ${formatNumber.format(jobCounts.blocked)}`,
        ].filter(Boolean).join(" · ");
      const detail = interaction ? [names[entry.view], entry.subject].filter(Boolean).join(" · ")
        : entry.details?.text ?? (entry.details ? JSON.stringify(entry.details, null, 2) : entry.subject);
      content.append(node("summary", "", title));
      if (detail) content.append(node("pre", "", detail));
      row.append(time, content);
      return row;
    }));
    if (!entries.length) log.append(node("li", "audit-empty", interaction ? "暂无操作记录。" : "暂无流程记录。"));
  }

  document.querySelector("#refresh-audit").addEventListener("click", () => void refresh());
  range.addEventListener("change", () => {
    send({ kind: "ui.click", view: "audit", control: "change-audit-range" });
    void refresh();
  });
  logType.addEventListener("change", () => {
    send({ kind: "ui.click", view: "audit", control: "change-log-type" });
    if (latest) renderLog(latest);
  });
  return {
    refresh,
    click(view, control, subject) { send({ kind: "ui.click", view, control, ...(subject ? { subject } : {}) }); },
    navigate(view, destination) { send({ kind: "ui.navigate", view, destination }); },
  };
}
