import { createDispatchLinks } from "./dispatch-links.mjs";
import { accountLabel, assignmentDetail } from "./account-assignment.mjs";
import { createRemoteWorkers, remoteJobStatus, remoteProgress } from "./remote-workers.mjs";

const labels = {
  connecting: "连接中", running: "执行中", waiting: "等人回答", queued: "排队中",
  completed: "会话结束", failed: "失败", interrupted: "已中断", "needs-reconciliation": "回执待核对",
  ready: "产物就绪", blocked: "前置未通过", reviewing: "待验收", rejected: "产物未通过",
  invalid: "补丁已失效", preparing: "正在分配", finalizing: "正在整理产物", dependencies: "等待前置",
};
const clock = new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const pollMs = 1500;
const overviewJobLimit = 6;
const jobKey = item => item.ticketId ? `${item.batchId}/${item.ticketId}` : undefined;

function stageFor(job, session) {
  if (job?.status === "ready") {
    if (job.reviewing) return "reviewing";
    return job.review === "rejected" || job.review === "invalid" ? job.review : "ready";
  }
  if (job?.status === "queued") return job.waitingOn.length ? "dependencies" : "queued";
  if (job?.status === "failed" || job?.status === "blocked") return job.status;
  if (session?.status === "completed" && job?.status === "running") return "finalizing";
  return session?.status ?? "preparing";
}

export function createMonitorView(node, selectFlow, onViewChange) {
  const dialog = document.querySelector("#monitor-dialog");
  const trigger = document.querySelector("#open-monitor");
  const connection = document.querySelector("#monitor-link");
  const topology = document.querySelector("#monitor-topology");
  const work = document.querySelector("#monitor-work");
  const detail = document.querySelector("#monitor-node-dialog");
  const detailTitle = document.querySelector("#monitor-node-title");
  const detailKind = document.querySelector("#monitor-node-kind");
  const detailMeta = document.querySelector("#monitor-node-meta");
  const detailHistory = document.querySelector("#monitor-node-history");
  const active = document.querySelector("#monitor-active");
  const recent = document.querySelector("#monitor-recent");
  const links = createDispatchLinks(document.querySelector("#monitor-map"), document.querySelector("#monitor-connections"));
  const remoteWorkers = createRemoteWorkers(node);
  let timer;
  let generation = 0;
  let rendered;
  let snapshot;
  let selection;
  let renderedDetail;

  function sessionRow(item, host, job) {
    const row = node("li", "monitor-session");
    row.dataset.state = stageFor(job, item);
    const heading = node("div", "monitor-session-heading");
    const title = node("strong", "", [item.ticketId, item.task].filter(Boolean).join(" · "));
    heading.append(title, node("span", "monitor-badge", labels[row.dataset.state]));
    const detail = node("p", "monitor-project", [item.title, item.planVersion ? `计划 v${item.planVersion}` : "", host].filter(Boolean).join(" · "));
    row.append(heading, detail);
    if (job?.dependsOn.length) row.append(node("p", "monitor-meta", `依赖 ${job.dependsOn.join("、")}`));
    if (item.model || item.threadId || item.accountRef || item.accountAssignment) {
      const thread = item.threadId ? `会话 …${item.threadId.slice(-8)}` : "";
      const meta = node("p", "monitor-meta", [accountLabel(item), item.model, thread].filter(Boolean).join(" · "));
      if (item.threadId) meta.title = item.threadId;
      row.append(meta);
    }
    if (item.accountAssignment) row.append(node("p", "monitor-meta", assignmentDetail(item.accountAssignment)));
    const steps = [["发起", item.startedAt ?? job?.startedAt], ["Agent 接入", item.connectedAt],
      [item.threadId ? "会话结束" : "工单结束", item.finishedAt], ["工单结束", item.threadId ? job?.finishedAt : undefined]]
      .filter(([, at]) => at !== undefined);
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
        detail.close();
        dialog.close();
        selectFlow(item.flowId);
      });
      row.append(button);
    }
    return row;
  }

  function openDetail(target) {
    selection = target;
    renderedDetail = undefined;
    detailHistory.open = false;
    renderDetail();
    detail.showModal();
  }

  function remoteRow(job) {
    const row = node("li", "monitor-session");
    row.dataset.state = job.status;
    row.append(node("strong", "", `${job.deviceName} · ${remoteJobStatus(job)}`),
      node("p", "monitor-meta", `提交 ${job.revision.slice(0, 8)} · ${remoteProgress(job)}`));
    for (const [index, file] of job.files.entries()) {
      const receipt = job.receipts[index];
      const result = receipt ? `${receipt.sha256 === file.sha256 && receipt.bytes === file.bytes ? "摘要一致" : "摘要不一致"} · ${receipt.headings} 个标题` : "待回传";
      row.append(node("p", "monitor-meta", `${file.path} · ${result}`));
    }
    return row;
  }

  function renderDetail() {
    if (!selection || !snapshot) return;
    const { rows, history, jobs, bySession, remoteJobs } = snapshot;
    const key = selection.id;
    const forHost = item => item.hostId === key;
    const forAgent = item => item.session.id === key;
    const forJob = item => jobKey(item.session) === key;
    const filtered = selection.kind === "调度器" ? rows
      : rows.filter(selection.kind === "设备" ? forHost : selection.kind === "Agent" ? forAgent : forJob);
    const finished = selection.kind === "调度器" ? history
      : history.filter(selection.kind === "设备" ? forHost : selection.kind === "Agent" ? forAgent : forJob);
    const selectedJob = selection.kind === "工单" ? jobs.get(key)
      : selection.kind === "Agent" ? jobs.get(jobKey((filtered[0] ?? finished[0])?.session ?? {})) : undefined;
    const additional = selection.kind === "调度器" ? [...jobs.values()].filter(job => !bySession.has(jobKey(job)))
      : selectedJob && !filtered.length && !finished.length ? [selectedJob] : [];
    const handoffs = remoteJobs.filter(job => selection.kind === "调度器"
      || (selection.kind === "设备" && job.deviceId === key) || (selection.kind === "工单" && job.id === key));
    const state = JSON.stringify([selection, filtered, finished, additional, selectedJob, handoffs,
      [...filtered, ...finished].map(item => jobs.get(jobKey(item.session)))]);
    if (state === renderedDetail) return;
    renderedDetail = state;
    detailTitle.textContent = selection.title;
    detailKind.textContent = selection.kind;
    detailMeta.textContent = selectedJob?.title ?? (selection.kind === "设备" && !handoffs.length ? `${filtered.length} 条活动会话` : "");
    detailMeta.hidden = !detailMeta.textContent;
    const primary = [...filtered, ...(selection.kind === "Agent" || selection.kind === "工单" ? finished : [])];
    active.replaceChildren(...primary.map(({ session, host }) => sessionRow(session, host, jobs.get(jobKey(session)))),
      ...additional.map(job => sessionRow(job, undefined, job)), ...handoffs.map(remoteRow));
    if (!active.children.length) active.append(node("li", "monitor-empty", "目前没有活动会话或待处理工单。"));
    recent.replaceChildren(...finished.map(({ session, host }) => sessionRow(session, host, jobs.get(jobKey(session)))));
    detailHistory.hidden = !finished.length || primary.includes(finished[0]);
  }

  function topologyNode(kind, id, title, subtitle, description, state) {
    const button = node("button", "monitor-node");
    button.type = "button";
    button.dataset.kind = kind;
    button.dataset.state = state;
    button.setAttribute("aria-haspopup", "dialog");
    const icon = node("span", kind === "hub" ? "monitor-node-icon brand-mark" : "monitor-node-icon", kind === "hub" ? "✦" : "");
    icon.setAttribute("aria-hidden", "true");
    const text = node("span", "monitor-node-text");
    text.append(node("strong", "", title), node("span", "monitor-node-subtitle", subtitle));
    if (description) text.append(node("span", "monitor-node-note", description));
    button.append(icon, text);
    const name = { hub: "调度器", device: "设备", agent: "Agent", job: "工单" }[kind];
    button.dataset.nodeKey = `${kind}/${id}`;
    button.addEventListener("click", () => openDetail({ kind: name, id, title }));
    return button;
  }

  function render(data) {
    remoteWorkers(data.remote);
    const deviceStates = new Map(data.remote?.devices.map(device => [device.id, device.status]));
    const remoteJobs = (data.remote?.jobs ?? []).map(job => ({ ...job, deviceStatus: deviceStates.get(job.deviceId) }));
    const remote = (data.remote?.devices ?? []).map(device => ({
      id: device.id, name: device.name, kind: "remote", status: device.status,
      active: remoteJobs.filter(job => job.deviceId === device.id && job.status === "running")
        .map(job => ({ id: job.id, status: device.status === "online" ? "running" : "interrupted",
          task: `文件核验 · ${job.receipts.length}/${job.files.length}`, label: remoteJobStatus(job) })),
      recent: [],
    }));
    const hosts = [...data.hosts, ...remote];
    const onlineHosts = hosts.filter(host => host.kind === "local" || host.status === "online");
    const agentCount = data.hosts.reduce((sum, host) => sum + host.active.length, 0);
    const online = `${onlineHosts.length} 台设备在线 · ${agentCount} 个活动 Agent`;
    if (connection.textContent !== online) connection.textContent = online;
    dialog.dataset.connection = "online";
    links.setOnline(true);
    const key = JSON.stringify([hosts, data.jobs, remoteJobs]);
    if (rendered === key) return;
    rendered = key;
    const entries = field => data.hosts.flatMap(host => host[field].map(session => ({ session, host: host.name, hostId: host.id ?? host.name })));
    const rows = entries("active");
    const history = entries("recent");
    const jobs = new Map(data.jobs.map(job => [jobKey(job), job]));
    const bySession = new Map([...history.toReversed(), ...rows].filter(item => item.session.ticketId)
      .map(item => [jobKey(item.session), item.session]));
    snapshot = { rows, history, jobs, bySession, remoteJobs };
    const selectedKey = topology.contains(document.activeElement) || work.contains(document.activeElement)
      ? document.activeElement.dataset.nodeKey : undefined;
    const hub = topologyNode("hub", "", "souflow", "任务调度", "", "idle");
    const machines = node("div", "monitor-machines");
    const routes = [];
    for (const host of hosts) {
      const group = node("div", "monitor-machine");
      const state = host.kind === "local" ? "本机" : host.status === "online" ? "局域网在线" : host.status === "pending" ? "待接入" : "局域网离线";
      const device = topologyNode("device", host.id ?? host.name, host.name, "执行设备", state, "idle");
      const agents = node("div", "monitor-agents");
      const running = host.active.some(session => session.status === "running");
      routes.push({ from: hub, to: device, state: running ? "running" : "idle", trunk: true });
      for (const session of host.active) {
        const title = host.kind === "remote" ? "远端工单"
          : session.threadId ? `Codex Agent · …${session.threadId.slice(-8)}` : "Codex Agent";
        const stage = stageFor(jobs.get(jobKey(session)), session);
        const task = [session.ticketId, session.task].filter(Boolean).join(" · ");
        const agent = topologyNode(host.kind === "remote" ? "job" : "agent", session.id, title, task,
          host.kind === "remote" ? session.label : `${labels[stage]} · ${accountLabel(session)}`, session.status);
        routes.push({ from: device, to: agent, state: session.status });
        agents.append(agent);
      }
      if (!host.active.length) agents.append(node("p", "monitor-idle", host.kind === "remote" ? "暂无执行中工单" : "暂无活动 Agent"));
      group.append(device, agents);
      machines.append(group);
    }
    topology.replaceChildren(hub, machines);
    links.setRoutes(routes);
    const priority = { running: 0, queued: 1, blocked: 2, failed: 2, ready: 3, revoked: 3 };
    const items = [...jobs.values(), ...remoteJobs].toReversed()
      .sort((a, b) => priority[a.status] - priority[b.status]).slice(0, overviewJobLimit);
    work.replaceChildren(...items.map(job => {
      const row = node("li");
      if (job.deviceId) {
        const title = `文件核验 · ${job.deviceName}`;
        const button = node("button", "monitor-job");
        button.type = "button";
        button.dataset.state = job.status;
        button.dataset.nodeKey = `job/${job.id}`;
        button.setAttribute("aria-haspopup", "dialog");
        button.append(node("strong", "", title), node("span", "monitor-badge", remoteJobStatus(job)),
          node("span", "monitor-meta", remoteProgress(job)));
        button.addEventListener("click", () => openDetail({ kind: "工单", id: job.id, title }));
        row.append(button);
        return row;
      }
      const session = bySession.get(jobKey(job));
      const state = stageFor(job, session);
      const button = node("button", "monitor-job");
      button.type = "button";
      button.dataset.state = state;
      button.dataset.nodeKey = `job/${jobKey(job)}`;
      button.setAttribute("aria-haspopup", "dialog");
      button.append(node("strong", "", `${job.ticketId} · ${job.task}`), node("span", "monitor-badge", labels[state]));
      if (state === "dependencies") button.append(node("span", "monitor-meta", job.waitingOn.join("、")));
      if (job.accountAssignment) button.append(node("span", "monitor-meta", accountLabel(job)));
      button.addEventListener("click", () => openDetail({ kind: "工单", id: jobKey(job), title: `${job.ticketId} · ${job.task}` }));
      row.append(button);
      return row;
    }));
    if (!items.length) work.append(node("li", "monitor-empty", "暂无已派发工单。"));
    if (selectedKey) [...dialog.querySelectorAll("[data-node-key]")].find(item => item.dataset.nodeKey === selectedKey)?.focus();
    if (detail.open) renderDetail();
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
        links.setOnline(false);
        connection.textContent = rendered ? "连接中断 · 下方为最后一次读取的状态" : "无法连接本机 souflow，正在重试";
      }
    }
    if (dialog.open && id === generation) timer = setTimeout(() => void refresh(id), pollMs);
  }

  trigger.addEventListener("click", () => {
    connection.textContent = "正在读取调度状态…";
    dialog.dataset.connection = "loading";
    dialog.showModal();
    links.show();
    onViewChange();
    void refresh(++generation);
  });
  document.querySelector("#close-monitor-node").addEventListener("click", () => detail.close());
  detail.addEventListener("close", () => {
    if (detail.open) return;
    const key = selection && { 调度器: "hub", 设备: "device", Agent: "agent", 工单: "job" }[selection.kind];
    if (dialog.open) {
      const match = [...dialog.querySelectorAll("[data-node-key]")].find(item => item.dataset.nodeKey === `${key}/${selection?.id}`);
      (match ?? topology.querySelector("button"))?.focus();
    }
    selection = undefined;
  });
  document.querySelector("#close-monitor").addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => {
    ++generation;
    clearTimeout(timer);
    links.hide();
    links.setOnline(false);
    onViewChange();
  });
  return {
    get visible() { return dialog.open; },
    setAvailable(visible) { trigger.hidden = !visible; },
  };
}
