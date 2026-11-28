import { accountLabel, assignmentDetail } from "./account-assignment.mjs";

const issueStates = { OPEN: "开放", CLOSED: "已关闭" };
const pullStates = { OPEN: "待合并", CLOSED: "已关闭", MERGED: "已合并" };
const ciStates = { NONE: "暂无检查", PENDING: "等待检查", EXPECTED: "等待检查", SUCCESS: "通过", FAILURE: "失败", ERROR: "异常" };

export function createGithubPanel(node, reportView) {
  const panel = document.querySelector("#github-dialog");
  const trigger = document.querySelector("#open-github");
  const claim = document.querySelector("#claim-github");
  const reload = document.querySelector("#refresh-github");
  const status = document.querySelector("#github-status");
  const error = document.querySelector("#github-error");
  const items = document.querySelector("#github-issues");
  const repo = document.querySelector("#github-repo");
  const mode = document.querySelector("#github-mode");
  const requestKey = "souflow.github.claimRequestId";
  let requestId = sessionStorage.getItem(requestKey);
  let canClaim = false;
  let pending = false;
  let generation = 0;
  let timer;
  let lastRendered;
  let stickyError = false;

  // 后端的诊断内容可能包含本机路径，界面只显示去除路径后的文本。
  function safeText(value) {
    return String(value ?? "").replace(/(?:[A-Za-z]:\\|(?<![:\w/])\/)[^\s，。；、]*/g, "[本机路径]");
  }

  function link(url, label) {
    const text = safeText(label);
    try {
      const target = new URL(url);
      if (target.protocol === "https:" && target.hostname === "github.com" && !target.username && !target.password && !target.port) {
        const anchor = node("a", "", text);
        anchor.href = target.href;
        anchor.target = "_blank";
        anchor.rel = "noopener noreferrer";
        return anchor;
      }
    } catch { /* 无效链接仅显示文本。 */ }
    return node("span", "", text);
  }

  function render(snapshot) {
    canClaim = snapshot.canClaim === true;
    claim.hidden = snapshot.conversationEnabled === true;
    const claimStatus = snapshot.conversationEnabled ? "从对话提交需求，在待决策授权工单。"
      : canClaim ? "可领取下一张工单。" : "当前成员没有领取权限。";
    repo.textContent = safeText(snapshot.repo);
    mode.textContent = snapshot.deliveryEnabled ? "领取计划内的 Issue 后，本机 Codex 在独立工作区开发并开草稿 PR。CI 与合并状态自动同步。"
      : "领取后将在本机启动 Codex 只读核验。GitHub 数据可手动同步。";
    const key = JSON.stringify(snapshot.items);
    if (key === lastRendered) {
      status.textContent = claimStatus;
      return;
    }
    lastRendered = key;
    const focusedLink = items.contains(document.activeElement) ? document.activeElement.href : undefined;
    const rows = snapshot.items.map(issue => {
      const row = node("li", "github-issue");
      const title = node("h3");
      title.append(link(issue.url, `#${issue.number} · ${issue.title}`));
      row.append(title, node("p", "github-meta", `状态：${safeText(issueStates[issue.state] ?? issue.state)} · GitHub 负责人：${safeText(issue.assignees.join("、") || "未分配")}`));
      row.append(node("p", "", `${issue.mode === "delivery" ? "交付进度" : "本机 Codex"}：${safeText(issue.progress)}`));
      if (issue.failureMessage) row.append(node("p", "github-meta", `最近失败：${safeText(issue.failureMessage)}`));
      if (issue.failureEvidence) {
        const evidence = node("details", "github-meta");
        evidence.append(node("summary", "", safeText(issue.failureEvidence.summary)));
        if (issue.failureEvidence.diagnostics?.length) {
          const lines = node("pre");
          lines.textContent = issue.failureEvidence.diagnostics.map(safeText).join("\n");
          evidence.append(lines);
        }
        if (issue.failureEvidence.candidateDigest) {
          evidence.append(node("p", "", `已保存候选摘要：${safeText(issue.failureEvidence.candidateDigest)}`));
          if (issue.failureEvidence.candidateFiles?.length) {
            evidence.append(node("p", "", `候选文件：${issue.failureEvidence.candidateFiles.map(file => safeText(file.path)).join("、")}`));
          }
        }
        row.append(evidence);
      }
      if (issue.retryCount) row.append(node("p", "github-meta",
        `已安排 ${issue.retryCount} 次重试`));
      if (issue.dependsOn?.length) row.append(node("p", "github-meta", `上游：${issue.dependsOn.map(number => `#${number}`).join("、")}`));
      if (/^feat\/\d+-[a-f0-9]{12}$/.test(issue.target?.branch ?? "")) {
        row.append(node("p", "github-meta", `分支：${issue.target.branch}`));
      }
      if (issue.claimedBy) row.append(node("p", "github-meta", `本地实施成员：${safeText(issue.claimedBy)}`));
      if (issue.accountAssignment) row.append(node("p", "github-meta",
        `Codex ${accountLabel(issue)} · ${assignmentDetail(issue.accountAssignment)}`));
      if (Number.isFinite(issue.syncedAt) && Number.isFinite(new Date(issue.syncedAt).getTime())) {
        row.append(node("p", "github-meta", `GitHub 同步于：${new Date(issue.syncedAt).toLocaleString("zh-CN")}`));
      }
      if (typeof issue.sessionId === "string" && /^[\w-]+$/.test(issue.sessionId)) {
        row.append(node("p", "github-meta", `会话：…${issue.sessionId.slice(-8)}`));
      }
      const pulls = node("p", "github-meta");
      pulls.append(document.createTextNode("关联 PR："));
      if (!issue.pulls.length) pulls.append(document.createTextNode(issue.claimedBy ? "暂无" : "认领后核对"));
      issue.pulls.forEach((pull, index) => {
        if (index) pulls.append(document.createTextNode(" · "));
        const state = pull.draft && pull.state === "OPEN" ? "草稿" : pullStates[pull.state] ?? pull.state;
        pulls.append(link(pull.url, `#${pull.number} · ${state}${pull.ci ? ` · CI ${ciStates[pull.ci] ?? pull.ci}` : ""}`));
        if (pull.mergeCommit) pulls.append(document.createTextNode(` · 合并 ${safeText(pull.mergeCommit.slice(0, 7))}`));
      });
      row.append(pulls);
      if (issue.report) {
        const details = node("details");
        details.append(node("summary", "", "查看核验清单"), node("p", "github-meta", safeText(issue.report)));
        row.append(details);
      }
      return row;
    });
    items.replaceChildren(...rows);
    if (focusedLink) [...items.querySelectorAll("a")].find(anchor => anchor.href === focusedLink)?.focus();
    if (!rows.length) items.append(node("li", "github-meta", "暂无工单。"));
    status.textContent = claimStatus;
  }

  async function load(action) {
    if (pending) return;
    clearTimeout(timer);
    pending = true;
    claim.disabled = true;
    reload.disabled = true;
    if (action !== "poll") { error.hidden = true; stickyError = false; }
    if (action !== "poll") status.textContent = action === "claim" ? "正在领取工单…" : "正在读取工单…";
    const revision = generation;
    try {
      if (action === "claim" && !requestId) {
        requestId = crypto.randomUUID();
        sessionStorage.setItem(requestKey, requestId);
      }
      const options = action === "read" || action === "poll" ? { signal: AbortSignal.timeout(5000) } : {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(action === "claim" ? { requestId } : {}),
        signal: AbortSignal.timeout(60_000),
      };
      const response = await fetch(action === "read" || action === "poll" ? "/api/github/issues" : `/api/github/issues/${action}`, options);
      const result = await response.json();
      if (!response.ok) throw new Error(safeText(result.error || "请求失败，请重试。"));
      if (action === "claim") {
        requestId = undefined;
        sessionStorage.removeItem(requestKey);
      }
      if (revision === generation && panel.open) {
        if (!stickyError) error.hidden = true;
        render(result);
      }
    } catch (problem) {
      if (revision === generation && panel.open) {
        status.textContent = action === "claim" ? "领取结果未确认；可重试以核对结果。" : "读取失败，列表可能不是最新状态。";
        if (action !== "poll" || error.hidden) {
          error.textContent = problem instanceof TypeError || problem.name === "TimeoutError" ? "请求未完成，请重试。" : safeText(problem.message);
          error.hidden = false;
          stickyError = action !== "poll";
        }
      }
    } finally {
      pending = false;
      claim.disabled = !canClaim;
      reload.disabled = false;
      if (revision !== generation && panel.open) void load("read");
      else if (panel.open) timer = setTimeout(() => void load("poll"), 2000);
    }
  }

  trigger.addEventListener("click", () => { panel.showModal(); reportView(); void load("read"); });
  document.querySelector("#close-github").addEventListener("click", () => panel.close());
  panel.addEventListener("close", () => { generation += 1; clearTimeout(timer); reportView(); });
  claim.addEventListener("click", () => void load("claim"));
  reload.addEventListener("click", () => void load("refresh"));
  return {
    get visible() { return panel.open; },
    setAvailable(visible) { trigger.hidden = !visible; if (!visible && panel.open) panel.close(); },
  };
}
