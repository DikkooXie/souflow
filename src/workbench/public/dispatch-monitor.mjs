const labels = {
  connecting: "连接中", running: "执行中", waiting: "等人回答", queued: "排队中",
  completed: "会话结束", failed: "失败", interrupted: "已中断", "needs-reconciliation": "回执待核对",
};
const clock = new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const pollMs = 1500;

export function createMonitorView(node, selectFlow, onViewChange) {
  const dialog = document.querySelector("#monitor-dialog");
  const trigger = document.querySelector("#open-monitor");
  const connection = document.querySelector("#monitor-link");
  const hosts = document.querySelector("#monitor-hosts");
  const active = document.querySelector("#monitor-active");
  const recent = document.querySelector("#monitor-recent");
  let timer;
  let generation = 0;
  let rendered;

  function sessionRow(item, host) {
    const row = node("li", "monitor-session");
    row.dataset.state = item.status;
    const heading = node("div", "monitor-session-heading");
    const title = node("strong", "", [item.ticketId, item.task].filter(Boolean).join(" · "));
    heading.append(title, node("span", "monitor-badge", labels[item.status]));
    const detail = node("p", "monitor-project", [item.title, item.planVersion ? `计划 v${item.planVersion}` : "", host].filter(Boolean).join(" · "));
    row.append(heading, detail);
    if (item.dependsOn?.length) row.append(node("p", "monitor-meta", `依赖 ${item.dependsOn.join("、")}`));
    if (item.model || item.threadId) {
      const thread = item.threadId ? `会话 …${item.threadId.slice(-8)}` : "";
      const meta = node("p", "monitor-meta", [item.model, thread].filter(Boolean).join(" · "));
      if (item.threadId) meta.title = item.threadId;
      row.append(meta);
    }
    const steps = [["发起", item.startedAt], ["连接", item.connectedAt], ["结束", item.finishedAt]].filter(([, at]) => at !== undefined);
    if (steps.length) {
      const timeline = node("ol", "monitor-timeline");
      for (const [label, at] of steps) {
        const step = node("li", "", label);
        const stamp = node("time", "", clock.format(at));
        stamp.dateTime = new Date(at).toISOString();
        step.append(stamp);
        timeline.append(step);
      }
      row.append(timeline);
    }
    if (item.flowId) {
      const button = node("button", "monitor-open-flow", "打开需求对话");
      button.type = "button";
      button.dataset.track = "select-flow";
      button.dataset.subject = item.flowId;
      button.addEventListener("click", () => {
        dialog.close();
        selectFlow(item.flowId);
      });
      row.append(button);
    }
    return row;
  }

  function render(data) {
    connection.textContent = `${data.hosts.length} 台机器已连接 · 本机 souflow`;
    dialog.dataset.connection = "online";
    const key = JSON.stringify([data.hosts, data.waiting]);
    if (rendered === key) return;
    rendered = key;
    const rows = data.hosts.flatMap(host => host.active.map(session => ({ session, host: host.name })));
    const history = data.hosts.flatMap(host => host.recent.map(session => ({ session, host: host.name })));
    hosts.replaceChildren(...data.hosts.map(host => {
      const name = node("li", "monitor-host");
      name.append(node("strong", "", host.name), node("span", "monitor-meta", `本机 · ${host.active.length} 条活动会话`));
      return name;
    }));
    const busy = [
      ...rows.map(({ session, host }) => sessionRow(session, host)),
      ...data.waiting.map(item => sessionRow({ ...item, status: "queued" })),
    ];
    active.replaceChildren(...(busy.length ? busy : [node("li", "monitor-empty", "目前没有正在执行或排队的工单。")]));
    recent.replaceChildren(...(history.length
      ? history.map(({ session, host }) => sessionRow(session, host)) : [node("li", "monitor-empty", "本次启动后暂无已结束会话。")]));
  }

  async function refresh(id) {
    try {
      const response = await fetch("/api/dispatch-status", { signal: AbortSignal.timeout(3000) });
      if (!response.ok) throw Error();
      const data = await response.json();
      if (dialog.open && id === generation) render(data);
    } catch {
      if (dialog.open && id === generation) {
        dialog.dataset.connection = "offline";
        connection.textContent = rendered ? "连接中断 · 下方为最后一次读取的状态" : "无法连接本机 souflow，正在重试";
      }
    }
    if (dialog.open && id === generation) timer = setTimeout(() => void refresh(id), pollMs);
  }

  trigger.addEventListener("click", () => {
    dialog.showModal();
    onViewChange();
    void refresh(++generation);
  });
  document.querySelector("#close-monitor").addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => {
    ++generation;
    clearTimeout(timer);
    onViewChange();
  });
  return {
    get visible() { return dialog.open; },
    setAvailable(visible) { trigger.hidden = !visible; },
  };
}
