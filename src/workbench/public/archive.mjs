const documentNames = {
  research: "调研记录", requirements: "需求说明", technology: "技术选型",
  prd: "PRD", "development-plan": "开发计划", "ticket-drafts": "工单草稿",
};

export function createArchive(node, reportView) {
  const dialog = document.querySelector("#archive-dialog");
  const project = document.querySelector("#archive-project");
  const list = document.querySelector("#archive-list");
  const reader = document.querySelector("#archive-document");
  let selectedId;

  function render(flow) {
    const artifacts = flow?.outputs.flatMap(output => output.artifacts) ?? [];
    if (!artifacts.length) return false;
    if (project.textContent !== flow.title) project.textContent = flow.title;
    const key = artifacts.map(artifact => `${artifact.id}:${artifact.version}`).join(",");
    if (list.dataset.key !== key) {
      list.dataset.key = key;
      const focusedId = list.contains(document.activeElement) ? document.activeElement.dataset.subject : undefined;
      list.replaceChildren(...artifacts.map(artifact => {
        const entry = node("li");
        const button = node("button", "archive-item", documentNames[artifact.kind] ?? artifact.sections[0]?.title);
        button.type = "button";
        button.dataset.track = "open-artifact";
        button.dataset.subject = artifact.id;
        button.addEventListener("click", () => {
          selectedId = artifact.id;
          render(flow);
        });
        entry.append(button);
        return entry;
      }));
      if (focusedId) [...list.querySelectorAll("button")].find(button => button.dataset.subject === focusedId)?.focus({ preventScroll: true });
    }
    const artifact = artifacts.find(entry => entry.id === selectedId) ?? artifacts.find(entry => entry.kind === "prd") ?? artifacts[0];
    selectedId = artifact.id;
    for (const button of list.querySelectorAll("button")) {
      if (button.dataset.subject === artifact.id) button.setAttribute("aria-current", "true");
      else button.removeAttribute("aria-current");
    }
    const documentKey = `${artifact.id}:${artifact.version}`;
    if (reader.dataset.key === documentKey) return true;
    reader.dataset.key = documentKey;
    const title = documentNames[artifact.kind] ?? artifact.sections[0]?.title;
    const heading = node("h3", "", title);
    heading.id = "archive-document-title";
    reader.replaceChildren(heading, node("p", "archive-version", `v${artifact.version}`));
    for (const section of artifact.sections) {
      if (section.title !== title) reader.append(node("h4", "", section.title));
      reader.append(node("p", "archive-text", section.text));
    }
    reader.scrollTop = 0;
    return true;
  }

  document.querySelector("#close-archive").addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", reportView);
  return {
    get visible() { return dialog.open; },
    show(flow) {
      selectedId = undefined;
      if (render(flow)) {
        dialog.showModal();
        reportView();
      }
    },
    update(flow) {
      if (dialog.open && !render(flow)) dialog.close();
    },
  };
}
