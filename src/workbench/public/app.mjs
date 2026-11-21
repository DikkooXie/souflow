import { createAuditView } from "./audit.mjs";

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
const phasesList = document.querySelector("#phases");
const flowSelect = document.querySelector("#flow-select");
const dialog = document.querySelector("#decision-dialog");
const decisionBody = dialog.querySelector(".decision-body");
const auditButton = document.querySelector("#open-audit");
const auditPanel = document.querySelector("#audit");
const workspace = document.querySelector("#workspace");
const audit = createAuditView(node);
const clock = new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const drafts = new Map();
let requests = [];
let flows = [];
let phases = [];
let selectedFlow;
let selected;
let renderedDetail;
let renderedConversation;
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

function pickOption(entry) {
  const option = node("option", "", entry.title);
  option.value = entry.id;
  return option;
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
  renderConversation(pending);
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

function renderConversation(pending) {
  const ids = flows.map(flow => flow.id).join(",");
  if (flowSelect.dataset.ids !== ids) {
    const newFlow = node("option", "", "新需求");
    newFlow.value = "";
    flowSelect.replaceChildren(newFlow, ...flows.map(pickOption));
    flowSelect.dataset.ids = ids;
  }
  flowSelect.hidden = !flows.length;
  flowSelect.value = selectedFlow ?? "";
  const flow = flows.find(entry => entry.id === selectedFlow);
  welcome.hidden = !!flow;
  conversation.hidden = !flow;
  promptBox.placeholder = flow ? "描述下一项需求…" : "描述你的需求…";
  const waiting = !!flow && pending.some(request => request.flowId === flow.id);
  const key = JSON.stringify([flow?.id, flow?.status, flow?.outputs.length, waiting, phases]);
  if (key === renderedConversation) return;
  renderedConversation = key;
  phasesList.replaceChildren(...phases.map((phase, index) => {
    const step = node("li", "phase", phase);
    if (flow && index < flow.outputs.length) step.dataset.state = "done";
    if (flow?.status === "running" && index === flow.outputs.length) step.setAttribute("aria-current", "step");
    return step;
  }));
  if (!flow) {
    conversation.replaceChildren();
    return;
  }
  const open = new Set([...conversation.querySelectorAll("details[open]")].map(item => item.dataset.phase));
  const note = flow.status === "ready" ? "草稿已就绪，可展开审阅。"
    : flow.status === "failed" ? `${phases[flow.outputs.length]}阶段未取得有效结果，流程已停止。`
      : waiting ? `${phases[flow.outputs.length]}正在等待你的决策。` : `正在推进${phases[flow.outputs.length]}…`;
  const status = node("p", "flow-status", note);
  status.setAttribute("role", "status");
  const previousFlow = conversation.dataset.flow;
  conversation.dataset.flow = flow.id;
  const outputs = flow.outputs.map((output, index) => {
    const section = node("details", "flow-output");
    section.dataset.phase = output.title;
    section.open = (previousFlow === flow.id && open.has(output.title)) || index === flow.outputs.length - 1;
    const heading = node("summary", "", output.title);
    heading.dataset.track = "open-artifact";
    heading.dataset.subject = output.artifacts[0]?.id;
    section.append(heading);
    for (const { sections } of output.artifacts) {
      for (const item of sections) section.append(node("h3", "", item.title), node("p", "", item.text));
    }
    return section;
  });
  conversation.replaceChildren(node("h1", "visually-hidden", "需求对话"), node("p", "user-message", flow.prompt), ...outputs, status);
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
  custom.maxLength = 1000;
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
  if (active > 0 || flows.some(flow => flow.status === "running") || requests.some(request => request.status === "submitted")) {
    poll = setTimeout(() => void refresh(), 400);
  }
}

function applySnapshot(snapshot) {
  if (snapshot.requests) {
    requests = snapshot.requests;
    flows = snapshot.flows ?? [];
    phases = snapshot.phases ?? [];
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
document.querySelector("#home").addEventListener("click", () => { selectedFlow = undefined; showAudit(false); promptBox.focus(); });
auditButton.addEventListener("click", () => {
  showAudit(!auditOpen);
  if (auditOpen) {
    document.querySelector("#audit-title").focus();
    void audit.refresh();
  }
});
document.querySelector("#open-decisions").addEventListener("click", openDecisions);
document.querySelector("#close-decision").addEventListener("click", () => dialog.close());
dialog.addEventListener("close", () => {
  reportView();
  if (auditOpen) void audit.refresh();
});
flowSelect.addEventListener("change", () => {
  audit.click(view(), "select-flow", flowSelect.value);
  selectedFlow = flowSelect.value || undefined;
  showAudit(false);
});
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
