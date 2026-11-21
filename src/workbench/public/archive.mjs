const documentNames = {
  research: "调研记录", requirements: "需求说明", technology: "技术选型",
  prd: "PRD", "development-plan": "开发计划", "ticket-drafts": "工单草稿",
};

export function createArchive(node, reportView, post) {
  const dialog = document.querySelector("#archive-dialog");
  const project = document.querySelector("#archive-project");
  const list = document.querySelector("#archive-list");
  const reader = document.querySelector("#archive-document");
  const drafts = new Map();
  let selection;
  let planMaxLength;
  let canEdit;
  let displayedFlow;
  const versionKey = artifact => `${artifact.id}:${artifact.version}`;

  function render(flow) {
    displayedFlow = flow;
    const current = flow?.outputs.flatMap(output => output.artifacts) ?? [];
    if (!current.length) return false;
    const archived = (flow.planHistory ?? []).toReversed();
    const artifacts = [...current, ...archived];
    if (project.textContent !== flow.title) project.textContent = flow.title;
    const key = artifacts.map(versionKey).join(",");
    if (list.dataset.key !== key) {
      list.dataset.key = key;
      const focusedKey = list.contains(document.activeElement) ? document.activeElement.dataset.key : undefined;
      list.replaceChildren(...artifacts.map(artifact => {
        const entry = node("li");
        const historical = archived.includes(artifact);
        const label = documentNames[artifact.kind] ?? artifact.sections[0]?.title;
        const button = node("button", "archive-item", historical ? `${label} v${artifact.version}（历史）` : label);
        button.type = "button";
        button.dataset.key = versionKey(artifact);
        button.dataset.track = "open-artifact";
        button.dataset.subject = artifact.id;
        button.addEventListener("click", () => {
          selection = { id: artifact.id, version: historical ? artifact.version : undefined };
          render(flow);
        });
        entry.append(button);
        return entry;
      }));
      if (focusedKey) [...list.querySelectorAll("button")].find(button => button.dataset.key === focusedKey)?.focus({ preventScroll: true });
    }
    const selectedEntries = selection?.version === undefined ? current : archived;
    const artifact = selectedEntries.find(entry => entry.id === selection?.id && (selection?.version === undefined || entry.version === selection.version))
      ?? current.find(entry => entry.kind === "prd") ?? current[0];
    const historical = archived.includes(artifact);
    selection = { id: artifact.id, version: historical ? artifact.version : undefined };
    const documentKey = `${versionKey(artifact)}:${historical}:${flow.status}:${canEdit}`;
    for (const button of list.querySelectorAll("button")) {
      if (button.dataset.key === versionKey(artifact)) button.setAttribute("aria-current", "true");
      else button.removeAttribute("aria-current");
    }
    if (reader.dataset.key === documentKey) return true;
    reader.dataset.key = documentKey;
    const title = documentNames[artifact.kind] ?? artifact.sections[0]?.title;
    const heading = node("h3", "", title);
    heading.id = "archive-document-title";
    reader.replaceChildren(heading, node("p", "archive-version", `v${artifact.version}${historical ? " · 历史版本" : ""}`));
    if (canEdit && artifact.kind === "development-plan" && !historical && flow.status === "ready") {
      const tools = node("div", "plan-edit-tools");
      const edit = node("button", "button plan-edit-button", "修改计划");
      edit.type = "button";
      edit.dataset.track = "edit-plan";
      edit.dataset.subject = artifact.id;
      edit.addEventListener("click", () => editPlan(flow, artifact, tools));
      tools.append(edit);
      const draft = drafts.get(artifact.id);
      if (draft && draft.version !== artifact.version) {
        const notice = node("p", "error", `计划已更新到 v${artifact.version}，你的 v${draft.version} 草稿已保留。请先核对当前计划。`);
        notice.setAttribute("role", "alert");
        const preview = node("details", "history");
        const useDraft = node("button", "button plan-edit-button", "带入草稿修改当前版本");
        useDraft.type = "button";
        useDraft.addEventListener("click", () => editPlan(flow, artifact, tools, draft.text));
        preview.append(node("summary", "", "查看未保存的草稿"), node("p", "archive-text", draft.text), useDraft);
        tools.append(notice, preview);
      }
      reader.append(tools);
    }
    for (const section of artifact.sections) {
      if (section.title !== title) reader.append(node("h4", "", section.title));
      reader.append(node("p", "archive-text", section.text));
    }
    reader.scrollTop = 0;
    return true;
  }

  function editPlan(flow, artifact, tools, carriedText) {
    const original = artifact.sections[0]?.text ?? "";
    const prior = drafts.get(artifact.id);
    const form = node("form", "plan-editor");
    const label = node("label", "", "开发计划内容");
    label.htmlFor = "plan-revision-text";
    const input = node("textarea");
    input.id = label.htmlFor;
    input.value = carriedText ?? (prior?.version === artifact.version ? prior.text : original);
    input.maxLength = planMaxLength;
    input.required = true;
    const save = node("button", "button button-primary", `保存为 v${artifact.version + 1}`);
    save.type = "submit";
    const unchanged = () => !input.value.trim() || input.value.trim() === original.trim();
    save.disabled = unchanged();
    const cancel = node("button", "button", "取消编辑");
    cancel.type = "button";
    const feedback = node("p", "error");
    feedback.setAttribute("role", "alert");
    feedback.hidden = true;
    const actions = node("div", "actions");
    actions.append(save, cancel);
    form.append(label, input, node("p", "muted", "保存后，旧计划和工单草稿移入历史。重新拆单后才能确认执行。"), actions, feedback);
    tools.hidden = true;
    tools.after(form);
    input.focus();
    function retainDraft() {
      drafts.set(artifact.id, { version: artifact.version, text: input.value });
    }
    if (carriedText !== undefined) retainDraft();
    input.addEventListener("input", () => {
      retainDraft();
      save.disabled = unchanged();
    });
    cancel.addEventListener("click", () => {
      if (prior && prior.version !== artifact.version) drafts.set(artifact.id, prior);
      else drafts.delete(artifact.id);
      reader.dataset.key = "";
      render(displayedFlow);
      reader.querySelector(".plan-edit-button")?.focus();
    });
    form.addEventListener("submit", async event => {
      event.preventDefault();
      retainDraft();
      save.disabled = cancel.disabled = input.disabled = true;
      if (await post(`/api/workflows/${flow.id}/plan/revise`, { version: artifact.version, text: input.value })) {
        drafts.delete(artifact.id);
        reader.dataset.key = "";
        render(displayedFlow);
        reader.focus();
        return;
      }
      if (!form.isConnected) return;
      save.disabled = cancel.disabled = input.disabled = false;
      feedback.textContent = "无法保存，请核对当前版本和工单运行状态。";
      feedback.hidden = false;
    });
  }

  document.querySelector("#close-archive").addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", reportView);
  return {
    get visible() { return dialog.open; },
    show(flow) {
      selection = undefined;
      if (render(flow)) {
        dialog.showModal();
        reportView();
      }
    },
    update(flow, maxLength, allowEdit) {
      planMaxLength = maxLength;
      canEdit = allowEdit;
      if (dialog.open && !render(flow)) dialog.close();
    },
  };
}
