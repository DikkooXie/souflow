const statuses = {
  pending: "待回答",
  submitted: "等待会话回执",
  acknowledged: "会话已收到",
  closed: "原提问已关闭",
  expired: "提问已失效",
  uncertain: "待核对",
};

const list = document.querySelector("#requests");
const detail = document.querySelector("#detail");
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
const decisionSelect = document.querySelector("#decision-select");
const dialog = document.querySelector("#decision-dialog");
const dock = document.querySelector("#bubble-dock");
const more = document.querySelector("#more-decisions");
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

function openDecision(id) {
  selected = id ?? pendingDecisions()[0]?.id ?? requests.at(-1)?.id;
  setError();
  render();
  if (!dialog.open) dialog.showModal();
}

function pickOption(entry) {
  const option = node("option", "", entry.title);
  option.value = entry.id;
  return option;
}

function renderQueue(pending) {
  const queueKey = JSON.stringify(pending.map(request => request.id));
  if (queueKey === renderedQueue) return;
  renderedQueue = queueKey;
  count.textContent = String(pending.length);
  dock.hidden = !pending.length;
  more.hidden = pending.length <= 2;
  more.textContent = `查看其余 ${Math.max(0, pending.length - 2)} 条`;
  list.replaceChildren(...pending.slice(0, 2).map(request => {
    const item = node("li");
    const button = node("button", "request-button");
    button.type = "button";
    button.addEventListener("click", () => openDecision(request.id));
    const summary = node("span");
    summary.append(
      node("strong", "request-title", request.title), node("span", "row-key", request.questions[0]?.prompt),
    );
    const arrow = node("span", "row-arrow", "›");
    arrow.setAttribute("aria-hidden", "true");
    button.append(summary, arrow);
    item.append(button);
    return item;
  }));
}

function pendingDecisions() {
  const pending = requests.filter(request => request.status === "pending");
  return selectedFlow ? pending.sort((a, b) => Number(b.flowId === selectedFlow) - Number(a.flowId === selectedFlow)) : pending;
}

function render() {
  const pending = pendingDecisions();
  renderQueue(pending);
  renderConversation(pending);
  const current = requests.find(request => request.id === selected);
  const entries = current && !pending.includes(current) ? [current, ...pending] : pending;
  const ids = entries.map(request => request.id).join(",");
  if (decisionSelect.dataset.ids !== ids) {
    decisionSelect.replaceChildren(...entries.map(pickOption));
    decisionSelect.dataset.ids = ids;
  }
  decisionSelect.hidden = entries.length < 2;
  decisionSelect.value = selected ?? "";
  if (!current) {
    detail.replaceChildren(node("p", "muted", "目前没有待决策事项。"));
    renderedDetail = undefined;
    return;
  }
  // 另一会话收到回执时，保留当前会话表单的焦点及正在输入的文字。
  const detailKey = [current.id, current.status, current.timeline.length].join(":");
  if (detailKey === renderedDetail) return;
  renderedDetail = detailKey;
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
    section.append(node("summary", "", output.title));
    for (const { sections } of output.artifacts) {
      for (const item of sections) section.append(node("h3", "", item.title), node("p", "", item.text));
    }
    return section;
  });
  conversation.replaceChildren(node("h1", "visually-hidden", "需求对话"), node("p", "user-message", flow.prompt), ...outputs, status);
}

function renderDetail(current) {
  const fragment = template.content.cloneNode(true);
  const status = fragment.querySelector(".status");
  status.textContent = statuses[current.status];
  status.dataset.status = current.status;
  status.setAttribute("aria-live", "polite");
  fragment.querySelector(".ticket-key").textContent = current.session;
  fragment.querySelector(".ticket-title").textContent = current.title;
  fragment.querySelector(".source-message").textContent = current.prompt;

  const form = fragment.querySelector("form");
  const actions = fragment.querySelector(".actions");
  const questions = fragment.querySelector(".questions");
  const path = ["/api/decisions", current.id].join("/");
  if (current.status === "pending") {
    const draft = drafts.get(current.id) ?? new Map();
    drafts.set(current.id, draft);
    const readers = current.questions.map(question => addQuestion(questions, question, draft));
    actions.append(actionButton("发送回答", "button-primary"));
    form.addEventListener("submit", async event => {
      event.preventDefault();
      const answers = Object.fromEntries(current.questions.map((question, index) => [question.id, readers[index]()]));
      if (await post(`${path}/answer`, answers)) {
        dialog.close();
        document.querySelector("#open-decisions").focus();
      }
    });
  } else {
    for (const question of current.questions) {
      const section = node("div", "answer-result");
      section.append(node("h3", "", question.title), node("p", "", current.answers?.[question.id] ?? "尚无答复"));
      questions.append(section);
    }
  }
  if (!live && (current.status === "pending" || current.status === "submitted")) {
    actions.append(actionButton("模拟断线", "disconnect", () => void post(`${path}/disconnect`)));
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
  const current = draft.get(question.id) ?? { choice: "", text: "" };
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
  for (const control of detail.querySelectorAll("button,input")) control.disabled = true;
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
    for (const control of detail.querySelectorAll("button,input")) control.disabled = false;
    later();
  }
}

reset.addEventListener("click", async () => {
  if (await post("/api/demo/reset")) dialog.close();
});
document.querySelector("#home").addEventListener("click", () => { selectedFlow = undefined; render(); promptBox.focus(); });
document.querySelector("#open-decisions").addEventListener("click", () => openDecision());
document.querySelector("#close-decision").addEventListener("click", () => dialog.close());
more.addEventListener("click", () => openDecision(pendingDecisions()[2]?.id));
decisionSelect.addEventListener("change", () => openDecision(decisionSelect.value));
flowSelect.addEventListener("change", () => { selectedFlow = flowSelect.value || undefined; render(); });
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
