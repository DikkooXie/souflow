import { createDispatchLinks } from "./dispatch-links.mjs";
import { accountLabel, assignmentDetail } from "./account-assignment.mjs";
import { createRemoteWorkers, remoteJobStatus, remoteProgress, remoteTopologyJobs } from "./remote-workers.mjs";

const labels = {
  connecting: "连接中", running: "执行中", waiting: "等人回答", queued: "排队中",
  completed: "会话结束", failed: "失败", interrupted: "已中断", "needs-reconciliation": "回执待核对",
  ready: "产物就绪", blocked: "前置未通过", reviewing: "待验收", rejected: "产物未通过",
  invalid: "补丁已失效", preparing: "正在分配", finalizing: "正在整理产物", dependencies: "等待前置",
};
const clock = new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const pollMs = 1500;
// 最近通信覆盖两个调度状态轮询周期，避免一次刷新间隔就让连线停下。
const remoteActivityMs = 2 * pollMs;
const codeStages = {
  offered: "已派发", accepted: "设备已接收", started: "Codex 已开工", tested: "设备测试通过",
  declined: "设备拒绝", failed: "设备执行失败", interrupted: "已中断，待核对",
};
const codeActive = new Set(["offered", "accepted", "started"]);
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
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  let timer;
  let activityTimer;
  let latestData;
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
      node("p", "monitor-meta", `工单 ${job.id}`),
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
    const { rows, history, jobs, bySession, remoteJobs, codeAttempts } = snapshot;
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
    const deliveries = codeAttempts.filter(item => selection.kind === "调度器"
      || (selection.kind === "设备" && item.device === key) || (selection.kind === "工单" && item.id === key));
    const state = JSON.stringify([selection, filtered, finished, additional, selectedJob, handoffs, deliveries,
      [...filtered, ...finished].map(item => jobs.get(jobKey(item.session)))]);
    if (state === renderedDetail) return;
    renderedDetail = state;
    detailTitle.textContent = selection.title;
    detailKind.textContent = selection.kind;
    detailMeta.textContent = selectedJob?.title ?? (selection.kind === "设备" && !handoffs.length ? `${filtered.length} 条活动会话` : "");
    detailMeta.hidden = !detailMeta.textContent;
    const primary = [...filtered, ...(selection.kind === "Agent" || selection.kind === "工单" ? finished : [])];
    active.replaceChildren(...primary.map(({ session, host }) => sessionRow(session, host, jobs.get(jobKey(session)))),
      ...additional.map(job => sessionRow(job, undefined, job)), ...handoffs.map(remoteRow),
      ...deliveries.map(item => {
        const row = node("li", "monitor-session");
        row.dataset.state = codeActive.has(item.state) ? "running" : item.state === "tested" ? "completed" : "failed";
        row.append(node("strong", "", `GitHub #${item.issue} · ${codeStages[item.state]}`),
          node("p", "monitor-meta", `${item.name} · 分配时 ${item.slots} 个执行位，已有 ${item.assignedLoad} 个修改文件的工作量`),
          node("p", "monitor-meta", `计划 v${item.plan.version} · 提交 ${item.revision.slice(0, 8)} · 上下文 ${item.digest.slice(0, 8)}`));
        if (item.receipt?.thread) row.append(node("p", "monitor-meta", `Codex 会话 …${item.receipt.thread.slice(-8)}`));
        return row;
      }));
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
    latestData = data;
    clearTimeout(activityTimer);
    const at = Date.now();
    const foreground = document.visibilityState === "visible";
    let nextExpiry = Infinity;
    remoteWorkers(data.remote);
    const deviceStates = new Map(data.remote?.devices.map(device => [device.id, device.status]));
    const remoteJobs = (data.remote?.jobs ?? []).map(job => ({ ...job, deviceStatus: deviceStates.get(job.deviceId) }));
    const codeDevices = new Map((data.codeWorkers?.devices ?? []).map(device => [device.id, device]));
    const primaryDevice = [...codeDevices.values()].find(device => device.local);
    const primaryHost = primaryDevice && data.hosts.find(host => host.kind === "local");
    const codeAttempts = data.codeWorkers?.attempts ?? [];
    const remote = (data.remote?.devices ?? []).map(device => {
      const code = codeDevices.get(device.id);
      const status = code ? (code.online ? "online" : "offline") : device.status;
      const assigned = codeAttempts.filter(item => item.device === device.id);
      const lastMessage = Math.max(device.lastSeen ?? -Infinity, ...assigned.map(item => item.updatedAt));
      const expiresAt = lastMessage + remoteActivityMs;
      const communicating = status === "online" && expiresAt > at;
      if (communicating) nextExpiry = Math.min(nextExpiry, expiresAt);
      const animateLink = communicating && foreground && !reducedMotion.matches;
      const codeJobs = assigned.filter(item => codeActive.has(item.state)).map(item => ({
        id: item.id, ticketId: `#${item.issue}`, task: "开发与测试", label: codeStages[item.state],
        status: status === "online" ? "running" : "waiting",
        linkState: animateLink && item.updatedAt + remoteActivityMs > at ? "running" : "idle",
      }));
      const onHost = primaryDevice?.id === device.id ? primaryHost : undefined;
      return {
        id: device.id, name: device.name, kind: "remote", status, communicating, animateLink, onHost: !!onHost,
        active: [...(onHost?.active ?? []), ...remoteTopologyJobs(remoteJobs, device.id, animateLink), ...codeJobs],
        recent: [],
      };
    });
    if (foreground && Number.isFinite(nextExpiry)) activityTimer = setTimeout(() => render(data), nextExpiry - at);
    const hosts = [...data.hosts.filter(host => host !== primaryHost), ...remote];
    const onlineHosts = hosts.filter(host => host.kind === "local" || host.onHost || host.status === "online");
    const agentCount = data.hosts.reduce((sum, host) => sum + host.active.length, 0) +
      codeAttempts.filter(item => item.state === "started" && codeDevices.get(item.device)?.online).length;
    const online = `${onlineHosts.length} 台设备在线 · ${agentCount} 个活动 Agent`;
    if (connection.textContent !== online) connection.textContent = online;
    dialog.dataset.connection = "online";
    links.setOnline(true);
    const key = JSON.stringify([hosts, data.jobs, remoteJobs, codeAttempts]);
    if (rendered === key) return;
    rendered = key;
    const entries = field => data.hosts.flatMap(host => host[field].map(session => ({
      session, host: host.name, hostId: host === primaryHost ? primaryDevice.id : host.id ?? host.name,
    })));
    const rows = entries("active");
    const history = entries("recent");
    const jobs = new Map(data.jobs.map(job => [jobKey(job), job]));
    const bySession = new Map([...history.toReversed(), ...rows].filter(item => item.session.ticketId)
      .map(item => [jobKey(item.session), item.session]));
    snapshot = { rows, history, jobs, bySession, remoteJobs, codeAttempts };
    const selectedKey = topology.contains(document.activeElement) || work.contains(document.activeElement)
      ? document.activeElement.dataset.nodeKey : undefined;
    const hub = topologyNode("hub", "", "souflow", "任务调度", "", "idle");
    const machines = node("div", "monitor-machines");
    const routes = [];
    for (const host of hosts) {
      const group = node("div", "monitor-machine");
      const remoteStates = { online: host.communicating ? "局域网在线 · 近期收发" : "局域网在线 · 空闲",
        pending: "待接入", offline: "局域网离线" };
      const state = host.onHost ? `本机 · 连接器${host.status === "online" ? "在线" : "离线"}`
        : host.kind === "local" ? "本机" : remoteStates[host.status];
      const device = topologyNode("device", host.id ?? host.name, host.name, "执行设备", state, "idle");
      const agents = node("div", "monitor-agents");
      const running = host.animateLink || host.active.some(session => !session.linkState && session.status === "running");
      routes.push({ from: hub, to: device, state: running ? "running" : "idle", trunk: true });
      for (const session of host.active) {
        const remoteJob = !!session.linkState;
        const title = remoteJob ? "设备工单"
          : session.threadId ? `Codex Agent · …${session.threadId.slice(-8)}` : "Codex Agent";
        const stage = stageFor(jobs.get(jobKey(session)), session);
        const task = [session.ticketId, session.task].filter(Boolean).join(" · ");
        const agent = topologyNode(remoteJob ? "job" : "agent", session.id, title, task,
          remoteJob ? session.label : `${labels[stage]} · ${accountLabel(session)}`, session.status);
        const routeState = remoteJob ? session.linkState : session.status;
        routes.push({ from: device, to: agent, state: routeState });
        agents.append(agent);
      }
      if (!host.active.length) agents.append(node("p", "monitor-idle", host.kind === "remote" ? "暂无执行中工单" : "暂无活动 Agent"));
      group.append(device, agents);
      machines.append(group);
    }
    topology.replaceChildren(hub, machines);
    links.setRoutes(routes);
    const items = data.overview;
    const deliveries = codeAttempts.map(job => {
      const row = node("li");
      const title = `GitHub #${job.issue} · ${job.name}`;
      const button = node("button", "monitor-job");
      button.type = "button";
      button.dataset.state = codeActive.has(job.state) ? "running" : job.state === "tested" ? "completed" : "failed";
      button.dataset.nodeKey = `job/${job.id}`;
      button.setAttribute("aria-haspopup", "dialog");
      button.append(node("strong", "", title), node("span", "monitor-badge", codeStages[job.state]));
      button.addEventListener("click", () => openDetail({ kind: "工单", id: job.id, title }));
      row.append(button);
      return row;
    });
    work.replaceChildren(...deliveries, ...items.map(job => {
      const row = node("li");
      if (job.deviceId) {
        const title = `文件核验 · ${job.deviceName}`;
        const button = node("button", "monitor-job");
        button.type = "button";
        button.dataset.state = job.status;
        button.dataset.nodeKey = `job/${job.id}`;
        button.setAttribute("aria-haspopup", "dialog");
        button.append(node("strong", "", title), node("span", "monitor-badge", remoteJobStatus({ ...job, deviceStatus: deviceStates.get(job.deviceId) })),
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
    if (!items.length && !deliveries.length) work.append(node("li", "monitor-empty", "暂无已派发工单。"));
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
        latestData = undefined;
        clearTimeout(activityTimer);
        dialog.dataset.connection = "offline";
        links.setOnline(false);
        connection.textContent = rendered ? "连接中断 · 下方为最后一次读取的状态" : "无法连接本机 souflow，正在重试";
      }
    }
    if (dialog.open && id === generation) timer = setTimeout(() => void refresh(id), pollMs);
  }

  function updateRemoteMotion() {
    if (dialog.open && latestData) render(latestData);
  }

  reducedMotion.addEventListener("change", updateRemoteMotion);
  document.addEventListener("visibilitychange", () => {
    updateRemoteMotion();
    if (dialog.open && document.visibilityState === "visible") {
      clearTimeout(timer);
      void refresh(++generation);
    }
  });

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
    clearTimeout(activityTimer);
    latestData = undefined;
    links.hide();
    links.setOnline(false);
    onViewChange();
  });
  return {
    get visible() { return dialog.open; },
    setAvailable(visible) { trigger.hidden = !visible; },
  };
}
