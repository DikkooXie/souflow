import { createArchive } from "./archive.mjs";
import { createAuditView } from "./audit.mjs";
import { createDispatchPanel } from "./dispatch.mjs";
import { createMonitorView } from "./dispatch-monitor.mjs";
import { createGithubPanel } from "./github-issues.mjs";
import { renderDeliveryReviews, renderQualityDetails } from "./quality-details.mjs";

const list = document.querySelector("#requests");
const queue = document.querySelector("#decision-queue");
const detail = document.querySelector("#detail");
const feedback = document.querySelector("#decision-feedback");
const errors = document.querySelectorAll(".error");
const count = document.querySelector("#count");
const reset = document.querySelector("#reset");
const modeLabel = document.querySelector("#mode");
const memberLabel = document.querySelector("#member-label");
const personalButton = document.querySelector("#open-personal");
const personalPanel = document.querySelector("#personal-home");
const personalTitle = document.querySelector("#personal-title");
const personalIdentity = document.querySelector("#personal-identity");
const personalStatus = document.querySelector("#personal-status");
const personalDevices = document.querySelector("#personal-devices");
const personalDeviceList = document.querySelector("#personal-device-list");
const personalDevicesEmpty = document.querySelector("#personal-devices-empty");
const personalHash = "#personal";
const start = document.querySelector("#start-session");
const promptBox = document.querySelector("#new-prompt");
const template = document.querySelector("#detail-template");
const welcome = document.querySelector("#welcome");
const conversation = document.querySelector("#conversation");
const conversationMessage = document.querySelector("#conversation-message");
const conversationStatus = document.querySelector("#conversation-status");
const conversationIssues = document.querySelector("#conversation-issues");
const conversationIssueList = document.querySelector("#conversation-issue-list");
const conversationQuality = document.querySelector("#conversation-quality");
const conversationDeliveryReviews = document.querySelector("#conversation-delivery-reviews");
const resumeWorkflow = document.querySelector("#resume-workflow");
const interruptedDecisions = document.querySelector("#interrupted-decisions");
const interruptedDecisionList = document.querySelector("#interrupted-decision-list");
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
const dispatch = createDispatchPanel(node, post, openDecisions);
const monitor = createMonitorView(node, selectFlow, reportView);
const github = createGithubPanel(node, reportView);
const clock = new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const drafts = new Map();
let requests = [];
let flows = [];
let dispatches = [];
let issuePlans = [];
let deliveryReviews = [];
let answerMaxLength;
let planMaxLength;
let selectedFlow;
let selected;
let renderedDetail;
let renderedQueue;
let busy = false;
let cycle = 0;
let poll;
let refreshing = 0;
let requestNumber = 0;
let latestResponse = 0;
let rejectedPoll;
let live = false;
let member;
let memberReadState = "loading";
let acceptanceNoteMaxLength;
let active = 0;
let auditOpen = false;
let recordedView = "home";
let actionError = false;

function setError(message = "", fromAction = false) {
  actionError = fromAction;
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
  if (monitor.visible) return "dispatch-monitor";
  if (github.visible) return "github-issues";
  if (auditOpen) return "audit";
  if (location.hash === personalHash) return "home";
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
  if (location.hash === personalHash) {
    history.replaceState(history.state, "", `${location.pathname}${location.search}`);
  }
  render();
}

function renderPage() {
  const personalOpen = location.hash === personalHash;
  workspace.hidden = auditOpen || personalOpen;
  auditPanel.hidden = !auditOpen;
  auditButton.setAttribute("aria-pressed", String(auditOpen));
  personalPanel.hidden = !personalOpen;
  personalButton.hidden = !member && !personalOpen;
  if (personalOpen) personalButton.setAttribute("aria-current", "page");
  else personalButton.removeAttribute("aria-current");

  const key = member?.login ?? member?.id;
  const label = member?.label ?? "";
  const identity = key && key !== label ? `${label}（${key}）` : label;
  memberLabel.hidden = !member;
  if (memberLabel.textContent !== label) memberLabel.textContent = label;
  personalIdentity.hidden = !member;
  if (personalIdentity.textContent !== identity) personalIdentity.textContent = identity;
  const status = {
    loading: "正在读取成员身份…",
    retrying: "暂时无法读取成员身份，正在自动重试…",
    unauthorized: "成员登录已失效，请重新登录。",
    ready: "当前没有成员身份。",
  }[memberReadState];
  personalStatus.hidden = !!member;
  if (personalStatus.textContent !== status) personalStatus.textContent = status;
  personalDevices.hidden = !member;
  personalDeviceList.hidden = !personalDeviceList.childElementCount;
  personalDevicesEmpty.hidden = !personalDeviceList.hidden;
  start.hidden = memberReadState === "unauthorized" || member?.id === "reviewer";
}

function openDecisions(kind) {
  const pending = pendingDecisions();
  selected = (pending.find(item => item.kind === kind && item.flowId === selectedFlow) ?? pending[0])?.id;
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
  personalPanel.inert = overlays;
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
  const pending = requests.filter(request => request.status === "pending"
    && (!member || (request.kind === "code-review") === (member.id === "reviewer")));
  return selectedFlow ? pending.sort((a, b) => Number(b.flowId === selectedFlow) - Number(a.flowId === selectedFlow)) : pending;
}

function render() {
  renderPage();
  reportView();
  const pending = pendingDecisions();
  const current = pending.find(request => request.id === selected) ?? pending[0];
  selected = current?.id;
  renderQueue(pending);
  renderRecent();
  const flow = flows.find(entry => entry.id === selectedFlow);
  renderConversation(flow, pending);
  const canEdit = member?.id !== "reviewer" && !issuePlans.some(plan => plan.flowId === flow?.id && plan.approved) && !dispatches.some(run => run.flowId === flow?.id
    && ["submitted", "accepted"].includes(run.acceptance?.at(-1)?.decision));
  archive.update(flow, planMaxLength, canEdit);
  dispatch.update(flow, dispatches, live, pending.some(item => item.kind === "code-review" && item.flowId === flow?.id),
    member, acceptanceNoteMaxLength);
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

function workflowAction(flow, proposal) {
  if (flow?.canReplan) return { path: "replan", label: "按当前版本重新规划" };
  if (proposal?.status === "uncertain" && proposal.approved && proposal.createsIssues) {
    return { path: "github-publication/resume", label: "核对建单并继续派发" };
  }
  if (["uncertain", "blocked"].includes(proposal?.status) && !proposal.approved) {
    return { path: "github-selection/retry", label: "重新准备并校验工单" };
  }
  if (flow?.status === "interrupted") return { path: "resume", label: "继续规划" };
}

function renderConversation(flow, pending) {
  welcome.hidden = !!flow;
  conversation.hidden = !flow;
  promptBox.placeholder = flow ? "发起另一项需求…" : "描述你的需求…";
  const proposal = issuePlans.find(item => item.flowId === flow?.id);
  renderQualityDetails(conversationQuality, node, flow?.status === "ready" ? proposal?.quality : undefined,
    proposal?.batchAcceptance, proposal?.sourceFindings);
  renderDeliveryReviews(conversationDeliveryReviews, node, flow?.id, deliveryReviews.find(entry => entry.flowId === flow?.id)?.reviews ?? []);
  if (!flow) return;
  const action = workflowAction(flow, proposal);
  resumeWorkflow.hidden = !live || member?.id === "reviewer" || !action;
  if (action) resumeWorkflow.textContent = action.label;
  resumeWorkflow.dataset.subject = flow.id;
  renderInterruptedDecisions(flow);
  if (conversationMessage.textContent !== flow.prompt) conversationMessage.textContent = flow.prompt;
  const waiting = pending.some(request => request.flowId === flow.id);
  const deliveryStatus = { selecting: "正在根据开发计划准备工单…",
    reviewing: "正在复核项目文档和 GitHub 工单…",
    blocked: "GitHub 工单未通过质量校验。",
    pending: proposal?.createsIssues ? "新工单已复核。请在「待决策」核对建单和派发范围。" : "已选好 GitHub 工单。请在「待决策」确认授权范围。",
    authorizing: proposal?.createsIssues ? "授权已记录，正在创建并认领 GitHub Issue…" : "授权已记录，正在认领 GitHub 工单…",
    submitted: "已派发到 GitHub 工单，可查看会话、依赖和 PR 进度。",
    declined: "本轮 GitHub 工单未授权执行。",
    empty: "这轮计划暂无符合条件的未认领 GitHub 工单。",
    uncertain: proposal?.createsIssues && proposal.approved ? "" : "GitHub 工单状态待核对。请查看工单列表。",
  };
  const note = flow.status === "ready" ? [deliveryStatus[proposal?.status] ?? "项目文档已就绪。", proposal?.error, proposal?.sourceError].filter(Boolean).join(" ")
    : flow.status === "interrupted" ? "规划已中断，已完成的项目文档已保留。"
      : flow.status === "failed" ? "这项需求暂未完成。"
        : waiting ? "有一个问题需要你决定。" : "正在推进你的需求…";
  if (conversationStatus.textContent !== note) conversationStatus.textContent = note;
  renderPublishedIssues(flow, proposal);
  renderProjectSources(flow);
  openArchive.hidden = !flow.outputs.some(output => output.artifacts.length) && !flow.planHistory?.length;
  openArchive.dataset.subject = flow.id;
}

function renderPublishedIssues(flow, proposal) {
  const repo = flow.project?.github.repo;
  const issues = proposal?.createsIssues ? proposal.issues : [];
  conversationIssues.hidden = !repo || !issues.length;
  const key = JSON.stringify([flow.id, repo, issues]);
  if (conversationIssues.dataset.key === key) return;
  conversationIssues.dataset.key = key;
  if (conversationIssues.dataset.flow !== flow.id) conversationIssues.open = false;
  conversationIssues.dataset.flow = flow.id;
  conversationIssueList.replaceChildren(...issues.map(number => {
    const link = node("a", "", `#${number}`);
    link.href = `https://github.com/${repo}/issues/${number}`;
    link.target = "_blank";
    link.rel = "noreferrer";
    const item = node("li");
    item.append(link);
    return item;
  }));
}

function renderInterruptedDecisions(flow) {
  const cards = requests.filter(card => card.flowId === flow.id && ["expired", "uncertain"].includes(card.status));
  interruptedDecisions.hidden = cards.length === 0;
  const key = JSON.stringify([flow.id, cards.map(card => [card.id, card.status])]);
  if (interruptedDecisions.dataset.key === key) return;
  if (interruptedDecisions.dataset.flow !== flow.id) interruptedDecisions.open = false;
  interruptedDecisions.dataset.key = key;
  interruptedDecisions.dataset.flow = flow.id;
  interruptedDecisionList.replaceChildren(...cards.map(card => {
    const item = node("li");
    item.append(node("strong", "", card.status === "expired" ? "原会话提问已失效" : "答复回执待核对"),
      node("p", "archive-text", card.questions.map(question => question.prompt).join("\n")));
    return item;
  }));
}

function renderProjectSources(flow) {
  const project = flow.project;
  projectContext.hidden = !project;
  const key = JSON.stringify([flow.id, project?.repository?.revision, project?.plan, project?.github,
    project?.relatedIssues, project?.relatedPullRequests, project?.relatedIssueOmissions, project?.planningSources]);
  if (projectContext.dataset.key === key) return;
  projectContext.dataset.key = key;
  projectContext.dataset.flow = flow.id;
  projectContext.open = false;
  if (!project) return;
  const { repository, plan, github } = project;
  projectSources.replaceChildren(
    node("li", "", repository ? `仓库提交 ${repository.revision.slice(0, 8)}` : "仓库提交未能读取"),
    node("li", "", plan.status === "read" ? `计划 ${plan.path}` : plan.status === "unavailable" ? "计划未能读取" : "未配置项目计划"),
    node("li", "", github.status === "read" ? `GitHub · 最近 ${github.pullRequests?.length ?? 0} 条 PR`
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
  for (const issue of project.relatedIssues ?? []) {
    const summary = issue.status === "read" ? `${issue.source.title} · ${issue.state === "CLOSED" ? "已关闭" : issue.assigned ? "已分配" : "开放"} · ${issue.source.revision.slice(0, 8)}`
      : "正文未能读取";
    const label = issue.status === "read" ? "关联 Issue" : "关联条目";
    const link = node("a", "", `${label} #${issue.number} · ${summary}`);
    link.href = issue.url;
    link.target = "_blank";
    link.rel = "noreferrer";
    const item = node("li");
    item.append(link);
    projectSources.append(item);
  }
  for (const pr of project.relatedPullRequests ?? []) {
    const label = { OPEN: "开放", MERGED: "已合并", CLOSED: "已关闭" }[pr.state];
    const link = node("a", "", `关联 PR #${pr.number} · ${pr.title} · ${label} · ${(pr.mergeCommit ?? pr.head).slice(0, 8)}`);
    link.href = pr.url;
    link.target = "_blank";
    link.rel = "noreferrer";
    const item = node("li");
    item.append(link);
    projectSources.append(item);
  }
  if (project.relatedIssueOmissions) {
    const { count, examples } = project.relatedIssueOmissions;
    projectSources.append(node("li", "", `${count} 条关联条目超出本轮资料范围，包括 ${examples.map(id => `#${id}`).join("、")}`));
  }
  for (const entry of project.planningSources?.files ?? []) {
    const status = entry.status === "read" ? `已读 · ${entry.sha256.slice(0, 8)}` : "未读 · 文件限制或读取失败";
    projectSources.append(node("li", "", `固定源码 ${entry.path} · ${status}`));
  }
  if (project.planningSources?.omitted) {
    projectSources.append(node("li", "", `${project.planningSources.omitted} 个源码引用超出本轮文件数量上限`));
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
  const send = actionButton(current.kind === "code-review" ? "提交验收" : current.kind === "github-authorization" ? "确认交付决定" : "发送回答", "button-primary");
  send.dataset.track = "send-answer";
  send.dataset.subject = current.id;
  actions.append(send);
  form.addEventListener("submit", async event => {
    event.preventDefault();
    feedback.textContent = "";
    const answers = Object.fromEntries(current.questions.map((question, index) => [question.id, readers[index]()]));
    if (await post(`${path}/answer`, answers) && dialog.open) {
      feedback.textContent = current.kind === "code-review" ? "验收已记录。" : "回答已提交。";
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
    || issuePlans.some(item => ["selecting", "reviewing", "authorizing"].includes(item.status))
    || dispatches.some(run => ["preparing", "running", "waiting"].includes(run.status))) {
    poll = setTimeout(() => void refresh(), 400);
  } else {
    poll = setTimeout(() => void refresh(), 1500);
  }
}

function acceptResponse(requestId) {
  if (requestId <= latestResponse) return false;
  latestResponse = requestId;
  return true;
}

function clearMemberState() {
  promptBox.value = "";
  personalDeviceList.replaceChildren();
  drafts.clear();
  selected = undefined;
  selectedFlow = undefined;
  renderedDetail = undefined;
  feedback.textContent = "";
}

function rejectAuthentication(requestId, fromPoll = false) {
  if (!acceptResponse(requestId)) return;
  // 已失效成员的在途响应不能恢复旧状态，后发的另一成员仍可用自己的快照登录。
  if (fromPoll) rejectedPoll = { through: requestNumber, member: member?.login ?? member?.id ?? rejectedPoll?.member };
  else cycle += 1;
  clearMemberState();
  memberReadState = "unauthorized";
  member = undefined;
  requests = [];
  flows = [];
  dispatches = [];
  issuePlans = [];
  deliveryReviews = [];
  active = 0;
  reset.hidden = true;
  monitor.setAvailable(false);
  github.setAvailable(false);
  setError();
  render();
}

function applySnapshot(snapshot) {
  if (snapshot.requests) {
    const nextMember = snapshot.member;
    if (memberReadState === "ready" && (member?.login ?? member?.id) !== (nextMember?.login ?? nextMember?.id)) clearMemberState();
    member = nextMember;
    rejectedPoll = undefined;
    memberReadState = "ready";
    promptBox.maxLength = snapshot.inputLimits.promptMaxLength;
    answerMaxLength = snapshot.inputLimits.answerMaxLength;
    planMaxLength = snapshot.planMaxLength;
    requests = snapshot.requests;
    flows = snapshot.flows ?? [];
    dispatches = snapshot.dispatches ?? [];
    issuePlans = snapshot.issuePlans ?? [];
    deliveryReviews = snapshot.deliveryReviews ?? [];
    if (snapshot.flowId) selectedFlow = snapshot.flowId;
    if (selectedFlow && !flows.some(flow => flow.id === selectedFlow)) selectedFlow = undefined;
    live = snapshot.mode === "codex";
    acceptanceNoteMaxLength = snapshot.acceptanceNoteMaxLength;
    monitor.setAvailable(live);
    github.setAvailable(snapshot.githubEnabled === true);
    active = snapshot.active ?? 0;
    modeLabel.textContent = live ? "Codex · 规划" : "本地演示";
    reset.hidden = live;
    const pending = new Set(requests.filter(request => request.status === "pending").map(request => request.id));
    for (const id of drafts.keys()) if (!pending.has(id)) drafts.delete(id);
  }
}

async function refresh() {
  if (busy) return;
  // 即使上一条快照滞留，下一轮也能读取最新的认证状态。
  later();
  if (refreshing >= 2) return;
  const revision = cycle;
  const requestId = ++requestNumber;
  refreshing += 1;
  try {
    const response = await fetch("/api/decisions", { signal: AbortSignal.timeout(10_000) });
    if (revision !== cycle) return;
    if (response.status === 401) {
      rejectAuthentication(requestId, true);
      return;
    }
    if (!response.ok) throw Error();
    const snapshot = await response.json();
    if (revision !== cycle) return;
    if (rejectedPoll && requestId <= rejectedPoll.through
      && (snapshot.member?.login ?? snapshot.member?.id) === rejectedPoll.member) return;
    if (!acceptResponse(requestId)) return;
    applySnapshot(snapshot);
    if (!actionError) setError();
    render();
  } catch {
    if (revision !== cycle || requestId <= latestResponse) return;
    if (memberReadState === "loading" || memberReadState === "retrying") {
      // 首次读取失败后，较早发出的轮询不能恢复身份。
      acceptResponse(requestId);
      memberReadState = "retrying";
    }
    if (!actionError) setError("无法读取会话提问，请重新加载页面。");
    if (!requests.length) render();
  } finally {
    refreshing -= 1;
  }
}

async function post(path, answers) {
  if (busy) return;
  busy = true;
  cycle += 1;
  const requestId = ++requestNumber;
  reset.disabled = true;
  start.querySelector("button").disabled = true;
  detail.inert = true;
  try {
    const options = answers ? {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(answers),
    } : { method: "POST" };
    const response = await fetch(path, options);
    if (response.status === 401) {
      rejectAuthentication(requestId);
      return false;
    }
    const snapshot = await response.json();
    if (!acceptResponse(requestId)) return false;
    applySnapshot(snapshot);
    setError(response.ok ? "" : snapshot.error, !response.ok);
    return response.ok;
  } catch {
    if (requestId > latestResponse) setError("发送失败，请刷新页面核对答复状态。", true);
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
  if (event.key === "Escape" && !sidebar.hidden && !dialog.open && !archive.visible && !dispatch.visible && !monitor.visible && !github.visible) {
    showSidebar(false);
    sidebarToggle.focus();
  }
});
personalButton.addEventListener("click", () => {
  if (location.hash === personalHash) personalTitle.focus();
  else location.hash = personalHash;
});
window.addEventListener("hashchange", () => {
  const personalOpen = location.hash === personalHash;
  if (personalOpen) {
    if (compactLayout.matches) showSidebar(false);
    auditOpen = false;
  }
  render();
  if (personalOpen) personalTitle.focus();
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
resumeWorkflow.addEventListener("click", () => {
  const flow = flows.find(item => item.id === selectedFlow);
  const proposal = issuePlans.find(item => item.flowId === selectedFlow);
  const action = workflowAction(flow, proposal);
  if (flow && action) void post(`/api/workflows/${flow.id}/${action.path}`);
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
renderPage();
void refresh();
