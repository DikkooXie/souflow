import { createArchive } from "./archive.mjs";
import { createAuditView } from "./audit.mjs";
import { createDispatchPanel } from "./dispatch.mjs";

const list = document.querySelector("#requests");
const queue = document.querySelector("#decision-queue");
const detail = document.querySelector("#detail");
const feedback = document.querySelector("#decision-feedback");
const errors = document.querySelectorAll(".error");
const count = document.querySelector("#count");
const reset = document.querySelector("#reset");
const modeLabel = document.querySelector("#mode");
const start = document.querySelector("#start-session");
const promptBox = document.querySelector("#new-prompt");
const template = document.querySelector("#detail-template");
const welcome = document.querySelector("#welcome");
const conversation = document.querySelector("#conversation");
const conversationMessage = document.querySelector("#conversation-message");
const conversationStatus = document.querySelector("#conversation-status");
const projectContext = document.querySelector("#project-context");
const projectSources = document.querySelector("#project-sources");
const sidebarToggle = document.querySelector("#toggle-conversations");
const sidebar = document.querySelector("#conversation-sidebar");
const sidebarScrim = document.querySelector("#sidebar-scrim");
const recent = document.querySelector("#recent-conversations");
const recentEmpty = document.querySelector("#recent-empty");
const compactLayout = matchMedia("(max-width: 680px)");
const openArchive = document.querySelector("#open-archive");
const dialog = document.querySelector("#decision-dialog");
const decisionBody = dialog.querySelector(".decision-body");
const auditButton = document.querySelector("#open-audit");
const auditPanel = document.querySelector("#audit");
const workspace = document.querySelector("#workspace");
const audit = createAuditView(node);
const archive = createArchive(node, reportView, post);
const dispatch = createDispatchPanel(node, post);
const clock = new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const drafts = new Map();
let requests = [];
let flows = [];
let dispatches = [];
let answerMaxLength;
let planMaxLength;
let selectedFlow;
let selected;
let renderedDetail;
let renderedQueue;
let busy = false;
let cycle = 0;
let poll;
let live = false;
let active = 0;
let auditOpen = false;
let recordedView = "home";

function setError(message = "") {
  for (const error of errors) {
    error.textContent = message;
    error.hidden = !message;
  }
}

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function actionButton(text, style, handler) {
  const button = node("button", `button ${style}`, text);
  button.type = handler ? "button" : "submit";
  if (handler) button.addEventListener("click", handler);
  return button;
}

function view() {
  if (dialog.open) return "decisions";
  if (archive.visible) return "archive";
  if (auditOpen) return "audit";
  return selectedFlow ? "conversation" : "home";
}

function reportView() {
  const next = view();
  if (next === recordedView) return;
  audit.navigate(recordedView, next);
  recordedView = next;
}

function showAudit(visible) {
  auditOpen = visible;
  workspace.hidden = visible;
  auditPanel.hidden = !visible;
  auditButton.setAttribute("aria-pressed", String(visible));
  render();
}

function openDecisions() {
  selected = pendingDecisions()[0]?.id;
  feedback.textContent = "";
  setError();
  render();
  dialog.showModal();
  decisionBody.scrollTop = 0;
  queue.scrollTop = 0;
  reportView();
}

function updateSidebarOverlay() {
  const overlays = compactLayout.matches && !sidebar.hidden;
  sidebarScrim.hidden = !overlays;
  workspace.inert = overlays;
  auditPanel.inert = overlays;
}

function showSidebar(visible) {
  sidebar.hidden = !visible;
  sidebarToggle.setAttribute("aria-expanded", String(visible));
  const label = visible ? "收起最近对话" : "展开最近对话";
  sidebarToggle.setAttribute("aria-label", label);
  sidebarToggle.title = label;
  updateSidebarOverlay();
}

function selectFlow(id) {
  selectedFlow = id;
  if (compactLayout.matches) showSidebar(false);
  showAudit(false);
  if (!id) promptBox.focus();
  else if (compactLayout.matches) document.querySelector("#conversation-title").focus();
}

function renderRecent() {
  const ids = flows.map(flow => flow.id).join(",");
  if (recent.dataset.ids !== ids) {
    recent.dataset.ids = ids;
    recentEmpty.hidden = flows.length > 0;
    const focusedId = recent.contains(document.activeElement) ? document.activeElement.dataset.subject : undefined;
    recent.replaceChildren(...flows.toReversed().map(flow => {
      const entry = node("li");
      const button = node("button", "recent-entry", flow.title);
      button.type = "button";
      button.title = flow.title;
      button.dataset.track = "select-flow";
      button.dataset.subject = flow.id;
      button.addEventListener("click", () => selectFlow(flow.id));
      entry.append(button);
      return entry;
    }));
    if (focusedId) [...recent.querySelectorAll("button")].find(button => button.dataset.subject === focusedId)?.focus({ preventScroll: true });
  }
  for (const button of recent.querySelectorAll("button")) {
    if (button.dataset.subject === selectedFlow) button.setAttribute("aria-current", "true");
    else button.removeAttribute("aria-current");
  }
}

function renderQueue(pending) {
  const queueKey = JSON.stringify(pending.map(request => request.id));
  if (queueKey !== renderedQueue) {
    renderedQueue = queueKey;
    if (count.textContent !== String(pending.length)) count.textContent = String(pending.length);
    queue.hidden = !pending.length;
    const focused = list.contains(document.activeElement) ? document.activeElement.dataset.subject : undefined;
    list.replaceChildren(...pending.map(decisionRow));
    if (focused) [...list.querySelectorAll("button")].find(button => button.dataset.subject === focused)?.focus({ preventScroll: true });
  }
  for (const button of list.querySelectorAll("button")) {
    if (button.dataset.subject === selected) button.setAttribute("aria-current", "true");
    else button.removeAttribute("aria-current");
  }

  function decisionRow(request) {
    const item = node("li");
    const button = node("button", "request-button");
    button.type = "button";
    button.dataset.track = "select-decision";
    button.dataset.subject = request.id;
    button.addEventListener("click", () => {
      selected = request.id;
      setError();
      render();
    });
    const summary = node("span");
    summary.append(
      node("strong", "request-title", request.title),
      node("span", "row-key", `${request.session} · ${request.questions[0]?.prompt ?? "待回答"}`),
    );
    const arrow = node("span", "row-arrow", "›");
    arrow.setAttribute("aria-hidden", "true");
    button.append(summary, arrow);
    item.append(button);
    return item;
  }
}

function pendingDecisions() {
  const pending = requests.filter(request => request.status === "pending");
  return selectedFlow ? pending.sort((a, b) => Number(b.flowId === selectedFlow) - Number(a.flowId === selectedFlow)) : pending;
}

function render() {
  reportView();
  const pending = pendingDecisions();
  const current = pending.find(request => request.id === selected) ?? pending[0];
  selected = current?.id;
  renderQueue(pending);
  renderRecent();
  const flow = flows.find(entry => entry.id === selectedFlow);
  renderConversation(flow, pending);
  archive.update(flow, planMaxLength);
  dispatch.update(flow, dispatches, live);
  // 另一会话收到回执时，保留当前会话表单的焦点及正在输入的文字。
  const detailKey = current ? `${current.id}:${current.timeline.length}` : "empty";
  if (detailKey === renderedDetail) return;
  renderedDetail = detailKey;
  if (!current) {
    const empty = node("p", "muted", "目前没有待决策事项。");
    empty.tabIndex = -1;
    detail.replaceChildren(empty);
    return;
  }
  renderDetail(current);
}

function renderConversation(flow, pending) {
  welcome.hidden = !!flow;
  conversation.hidden = !flow;
  promptBox.placeholder = flow ? "发起另一项需求…" : "描述你的需求…";
  if (!flow) return;
  if (conversationMessage.textContent !== flow.prompt) conversationMessage.textContent = flow.prompt;
  const waiting = pending.some(request => request.flowId === flow.id);
  const note = flow.status === "ready" ? "项目文档已就绪。"
    : flow.status === "failed" ? "这项需求暂未完成。"
      : waiting ? "有一个问题需要你决定。" : "正在推进你的需求…";
  if (conversationStatus.textContent !== note) conversationStatus.textContent = note;
  renderProjectSources(flow);
  openArchive.hidden = !flow.outputs.some(output => output.artifacts.length);
  openArchive.dataset.subject = flow.id;
}

function renderProjectSources(flow) {
  const project = flow.project;
  projectContext.hidden = !project;
  if (projectContext.dataset.flow === flow.id && projectContext.dataset.loaded === String(!!project)) return;
  projectContext.dataset.flow = flow.id;
  projectContext.dataset.loaded = String(!!project);
  projectContext.open = false;
  if (!project) return;
  const { repository, plan, github } = project;
  projectSources.replaceChildren(
    node("li", "", repository ? `仓库提交 ${repository.revision.slice(0, 8)}` : "仓库提交未能读取"),
    node("li", "", plan.status === "read" ? `计划 ${plan.path}` : plan.status === "unavailable" ? "计划未能读取" : "未配置项目计划"),
    node("li", "", github.status === "read" ? `GitHub · 最近 ${github.pullRequests.length} 条 PR`
      : github.status === "unavailable" ? "GitHub PR 未能读取" : "未配置 GitHub 仓库"),
  );
  for (const pr of github.pullRequests ?? []) {
    const link = node("a", "", `#${pr.number} ${pr.title} · ${{ OPEN: "开放", MERGED: "已合并", CLOSED: "已关闭" }[pr.state]}`);
    link.href = pr.url;
    link.target = "_blank";
    link.rel = "noreferrer";
    const item = node("li");
    item.append(link);
    projectSources.append(item);
  }
}

function renderDetail(current) {
  const fragment = template.content.cloneNode(true);
  fragment.querySelector(".ticket-key").textContent = current.session;
  fragment.querySelector(".ticket-title").textContent = current.title;
  fragment.querySelector(".source-message").textContent = current.prompt;

  const form = fragment.querySelector("form");
  const actions = fragment.querySelector(".actions");
  const questions = fragment.querySelector(".questions");
  fragment.querySelector(".history summary").dataset.subject = current.id;
  const path = ["/api/decisions", current.id].join("/");
  const draft = drafts.get(current.id) ?? new Map();
  drafts.set(current.id, draft);
  const readers = current.questions.map(question => addQuestion(questions, question, draft));
  const send = actionButton("发送回答", "button-primary");
  send.dataset.track = "send-answer";
  send.dataset.subject = current.id;
  actions.append(send);
  form.addEventListener("submit", async event => {
    event.preventDefault();
    feedback.textContent = "";
    const answers = Object.fromEntries(current.questions.map((question, index) => [question.id, readers[index]()]));
    if (await post(`${path}/answer`, answers) && dialog.open) {
      feedback.textContent = "回答已提交。";
      if (!dialog.contains(document.activeElement)) detail.querySelector('[tabindex="-1"]')?.focus();
    }
  });
  if (!live) {
    const disconnect = actionButton("模拟断线", "disconnect", () => void post(`${path}/disconnect`));
    disconnect.dataset.track = "simulation-disconnect";
    disconnect.dataset.subject = current.id;
    actions.append(disconnect);
  }
  const timeline = fragment.querySelector(".timeline");
  for (const entry of current.timeline) {
    const row = node("li");
    const stamp = node("time", "", clock.format(new Date(entry.at)));
    stamp.dateTime = entry.at;
    row.append(node("b", "", entry.label), stamp);
    timeline.append(row);
  }
  detail.replaceChildren(fragment);
}

function addQuestion(container, question, draft) {
  const current = draft.get(question.id) ?? { choice: "", text: "", optionIds: new Map() };
  draft.set(question.id, current);
  const fieldset = node("fieldset", "question");
  const legend = node("legend", "", question.prompt);
  fieldset.append(legend);
  const options = node("div", "options");
  const choices = question.options.map(option => option.label);
  const hasFreeText = choices.length === 0;
  const custom = node("input", "custom-answer");
  custom.type = "text";
  custom.maxLength = answerMaxLength;
  custom.value = current.text;
  custom.placeholder = "填写你的回答";
  custom.setAttribute("aria-label", `${question.prompt} 自定义回答`);
  custom.addEventListener("input", () => { current.text = custom.value; });

  const showCustom = () => {
    const visible = hasFreeText || current.choice === "custom";
    custom.hidden = !visible;
    custom.required = visible;
  };

  for (const [index, label] of choices.entries()) {
    options.append(choiceRow(String(index), label, question.options[index].description));
  }
  if (question.allowCustom && !hasFreeText) options.append(choiceRow("custom", "其他", ""));
  if (!hasFreeText) fieldset.append(options);
  if (question.allowCustom || hasFreeText) fieldset.append(custom);
  showCustom();
  container.append(fieldset);
  return () => hasFreeText || current.choice === "custom" ? current.text : choices[Number(current.choice)];

  function choiceRow(value, label, description) {
    const row = node("label", "option");
    const radio = node("input");
    radio.type = "radio";
    radio.name = question.id;
    radio.value = value;
    if (!current.optionIds.has(value)) current.optionIds.set(value, crypto.randomUUID());
    radio.dataset.track = "select-option";
    radio.dataset.subject = current.optionIds.get(value);
    radio.required = true;
    radio.checked = current.choice === value;
    radio.addEventListener("change", () => {
      current.choice = value;
      showCustom();
    });
    row.append(radio, node("strong", "", label));
    if (description) row.append(node("span", "option-description", description));
    return row;
  }
}

function later() {
  clearTimeout(poll);
  if (active > 0 || flows.some(flow => flow.status === "running") || requests.some(request => request.status === "submitted")
    || dispatches.some(run => run.status === "preparing" || run.status === "running")) {
    poll = setTimeout(() => void refresh(), 400);
  }
}

function applySnapshot(snapshot) {
  if (snapshot.requests) {
    promptBox.maxLength = snapshot.inputLimits.promptMaxLength;
    answerMaxLength = snapshot.inputLimits.answerMaxLength;
    planMaxLength = snapshot.planMaxLength;
    requests = snapshot.requests;
    flows = snapshot.flows ?? [];
    dispatches = snapshot.dispatches ?? [];
    if (snapshot.flowId) selectedFlow = snapshot.flowId;
    if (selectedFlow && !flows.some(flow => flow.id === selectedFlow)) selectedFlow = undefined;
    live = snapshot.mode === "codex";
    active = snapshot.active ?? 0;
    modeLabel.textContent = live ? "Codex · 规划" : "本地演示";
    reset.hidden = live;
    const pending = new Set(requests.filter(request => request.status === "pending").map(request => request.id));
    for (const id of drafts.keys()) if (!pending.has(id)) drafts.delete(id);
  }
}

async function refresh() {
  if (busy) return;
  const revision = cycle;
  try {
    const response = await fetch("/api/decisions");
    if (!response.ok) throw Error();
    const snapshot = await response.json();
    if (revision !== cycle) return;
    applySnapshot(snapshot);
    setError();
    render();
  } catch {
    if (revision !== cycle) return;
    setError("无法读取会话提问，请重新加载页面。");
    if (!requests.length) render();
  }
  if (revision === cycle) later();
}

async function post(path, answers) {
  if (busy) return;
  busy = true;
  cycle += 1;
  reset.disabled = true;
  start.querySelector("button").disabled = true;
  detail.inert = true;
  try {
    const options = answers ? {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(answers),
    } : { method: "POST" };
    const response = await fetch(path, options);
    const snapshot = await response.json();
    applySnapshot(snapshot);
    setError(response.ok ? "" : snapshot.error);
    return response.ok;
  } catch {
    setError("发送失败，请刷新页面核对答复状态。");
    return false;
  } finally {
    busy = false;
    reset.disabled = false;
    start.querySelector("button").disabled = false;
    render();
    detail.inert = false;
    later();
  }
}

reset.addEventListener("click", async () => {
  if (await post("/api/demo/reset")) dialog.close();
});
document.addEventListener("click", event => {
  const control = event.target.closest?.("[data-track]");
  if (control) audit.click(view(), control.dataset.track, control.dataset.subject);
}, { capture: true });
document.querySelector("#home").addEventListener("click", () => selectFlow());
document.querySelector("#new-conversation").addEventListener("click", () => selectFlow());
sidebarToggle.addEventListener("click", () => showSidebar(sidebar.hidden));
sidebarScrim.addEventListener("click", () => { showSidebar(false); sidebarToggle.focus(); });
compactLayout.addEventListener("change", updateSidebarOverlay);
document.addEventListener("keydown", event => {
  if (event.key === "Escape" && !sidebar.hidden && !dialog.open && !archive.visible && !dispatch.visible) {
    showSidebar(false);
    sidebarToggle.focus();
  }
});
auditButton.addEventListener("click", () => {
  if (compactLayout.matches) showSidebar(false);
  showAudit(!auditOpen);
  if (auditOpen) {
    document.querySelector("#audit-title").focus();
    void audit.refresh();
  }
});
document.querySelector("#open-decisions").addEventListener("click", () => {
  if (compactLayout.matches) showSidebar(false);
  openDecisions();
});
document.querySelector("#close-decision").addEventListener("click", () => dialog.close());
dialog.addEventListener("close", () => {
  reportView();
  if (auditOpen) void audit.refresh();
});
openArchive.addEventListener("click", () => archive.show(flows.find(entry => entry.id === selectedFlow)));
promptBox.addEventListener("keydown", event => {
  if (event.key === "Enter" && !event.isComposing && !event.shiftKey) {
    event.preventDefault();
    start.requestSubmit();
  }
});
start.addEventListener("submit", async event => {
  event.preventDefault();
  if (await post("/api/workflows", { prompt: promptBox.value })) start.reset();
});
void refresh();
