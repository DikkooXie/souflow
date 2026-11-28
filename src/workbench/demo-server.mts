import { createGitHubSelector } from "../planning/github-selection.mts";
import { createConversationDelivery, type IssueProposal } from "./conversation-delivery.mts";
import { createPlannedIssuePublication, type IssuePublication } from "./planned-issue-publication.mts";
import { readFile } from "node:fs/promises";
import { X509Certificate } from "node:crypto";
import { createIssueDeveloper } from "../execution/issue-delivery.mts";
import { createRepairCandidateInspector } from "../execution/repair-candidate-inspection.mts";
import { createCodexDeliveryReviewer } from "../execution/codex-delivery-review.mts";
import { createCodexQualityReviewer, createCodexTicketSourceReviewer, qualitySources } from "../execution/codex-quality-review.mts";
import type { DeliveryReviewScope } from "../planning/delivery-review.mts";
import type { QualityReviewer, TicketSourceReviewer } from "../planning/dispatch-quality.mts";
import { createGitHubIssues } from "../connections/github.mts";
import type { IssueTracker } from "../connections/issue-tracker.mts";
import { createIssueVerifier, type VerifyIssue } from "../execution/issue-verification.mts";
import { createIssueDispatch, IssueActionError, type Claim, type IssueDeliveryOptions } from "./issue-dispatch.mts";
import { createGitHubDeliveryReviewer } from "./github-delivery-review.mts";
import { readApprovedReviewFixes } from "./approved-review-fix.mts";
import { readApprovedSourceRefresh } from "./approved-source-refresh.mts";
import { createPrePrAmendments, type PrePrAmendmentEvent } from "./pre-pr-amendment.mts";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import { hostname } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultAuditThresholds, openActivityStore, readActivity, scrubAuditText } from "../audit/activity-store.mts";
import { defaultAnswerMaxLength, maxQuestionsPerDecision } from "../decisions/questions.mts";
import { codeReviewOptions, createLocalDispatch, type Run } from "../execution/local-dispatch.mts";
import { createDispatchMonitor, dispatchOverview } from "../execution/dispatch-monitor.mts";
import { createRemoteHandoff, type RemoteDevice, type RemoteJob } from "../execution/remote-handoff.mts";
import { createCodeWorkerPool, type WorkerAttempt } from "../execution/code-worker-pool.mts";
import { loadLocalEnv, readCodeWorkerConfig, runtimeInteger } from "../config/runtime.mts";
import { workerCommit, workerId } from "../execution/code-worker-protocol.mts";
import { createRemoteWorkerIngress, readRemoteFiles, remoteWorkerNetwork, type RemoteLanConfig } from "./remote-worker-ingress.mts";
import { createCodexAccountDispatch, readCodexProfiles, type CodexAccountDispatch } from "../execution/codex-account-dispatch.mts";
import { createConversationFlows, currentDevelopmentPlan, maxArtifactTextLength, phases, readPlanRevision, type Flow, type StoredFlow } from "../planning/conversation-flow.mts";
import { createProjectContextReader, readRelatedIssues, snapshotIssueCandidates, type ProjectSettings } from "../planning/project-context.mts";
import { createCodexInbox } from "./codex-inbox.mts";
import { freezePlanningSources } from "../execution/frozen-planning-sources.mts";
import { createDecisionDemo, type DecisionCard } from "./demo-state.mts";
import { createAcceptance, maxAcceptanceNote, type AcceptanceAction, type StoredAcceptance } from "./acceptance.mts";
import { createMembers, type Member, type MemberKeys } from "./members.mts";
import { bindWorkbench, lockWorkbench } from "./recovery.mts";

const address = "127.0.0.1";
const defaultLimits = { demo: 24, codex: 4 };
const defaultDispatchConcurrency = 2;
const recentMonitorRuns = 4;
const defaultInputLimits = { promptMaxLength: 4000, answerMaxLength: defaultAnswerMaxLength };
const maxConfigurableInputLength = 16_000;
const jsonMetadataBudget = 16_384;
const files = [
  ["/", "index.html", "text/html"],
  ["/style.css", "style.css", "text/css"],
  ["/github-issues.mjs", "github-issues.mjs", "text/javascript"],
  ["/app.mjs", "app.mjs", "text/javascript"],
  ["/archive.mjs", "archive.mjs", "text/javascript"],
  ["/document-markdown.mjs", "document-markdown.mjs", "text/javascript"],
  ["/dispatch.mjs", "dispatch.mjs", "text/javascript"],
  ["/quality-details.mjs", "quality-details.mjs", "text/javascript"],
  ["/audit.mjs", "audit.mjs", "text/javascript"],
  ["/dispatch-monitor.mjs", "dispatch-monitor.mjs", "text/javascript"],
  ["/account-assignment.mjs", "account-assignment.mjs", "text/javascript"],
  ["/remote-workers.mjs", "remote-workers.mjs", "text/javascript"],
  ["/souflow-worker.mjs", "souflow-worker.mjs", "text/javascript"],
  ["/dispatch-links.mjs", "dispatch-links.mjs", "text/javascript"],
  ["/dispatch-monitor.css", "dispatch-monitor.css", "text/css"],
] as const;

async function readJson(request: IncomingMessage, maxBytes = jsonMetadataBudget): Promise<{ value: unknown } | { status: number; error: string }> {
  if (request.headers["content-type"] !== "application/json") return { status: 415, error: "请提交 JSON。" };
  try {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      size += chunk.length;
      if (size <= maxBytes) chunks.push(chunk);
    }
    if (size > maxBytes) return { status: 413, error: "内容太长。" };
    return { value: JSON.parse(Buffer.concat(chunks).toString("utf8")) };
  } catch {
    return { status: 400, error: "无法读取请求内容。" };
  }
}

type LiveOptions = [workspace: string, startAttempt?: Parameters<typeof createCodexInbox>[1]["startAttempt"]];
type WorkbenchOptions = {
  limits?: typeof defaultLimits;
  inputLimits?: typeof defaultInputLimits;
  auditThresholds?: typeof defaultAuditThresholds;
  dispatchConcurrency?: number;
  dispatchAdapters?: Omit<NonNullable<Parameters<typeof createLocalDispatch>[2]>, "record" | "store" | "artifactRoot">;
  project?: ProjectSettings;
  members?: MemberKeys;
  issueTracker?: IssueTracker;
  verifyIssue?: VerifyIssue;
  issueDelivery?: Omit<IssueDeliveryOptions, "prepare"> & { image: string; model?: string; planningModel?: string; timeoutMs: number };
  memberTrackers?: ReadonlyMap<string, IssueTracker>;
  hostName?: string;
  codexAccounts?: CodexAccountDispatch;
  remoteLan?: RemoteLanConfig;
  codeDevices?: ReadonlySet<string>;
  createWorkers?: typeof createCodeWorkerPool;
  qualityReviewer?: QualityReviewer;
  ticketSourceReviewer?: TicketSourceReviewer;
  qualityModel?: string;
};

export function createWorkbenchServer(receiptDelay?: number, live?: LiveOptions, auditPath?: string, {
  limits = defaultLimits, inputLimits = defaultInputLimits, auditThresholds = defaultAuditThresholds,
  dispatchConcurrency = defaultDispatchConcurrency, dispatchAdapters, project, members, issueTracker, verifyIssue, issueDelivery,
  memberTrackers, hostName = hostname(), codexAccounts, remoteLan, codeDevices, qualityReviewer, ticketSourceReviewer, qualityModel,
  createWorkers = createCodeWorkerPool,
}: WorkbenchOptions = {}) {
  if (codeDevices?.size && (!remoteLan || !issueDelivery || !issueTracker)) {
    throw Error("代码设备需要开启设备接入和 GitHub 对话工单交付。");
  }
  const memberFor = members && createMembers(members);
  if (memberFor && !live) throw Error("两位成员模式需要 Codex 工作台。");
  const loadProject = live && project ? createProjectContextReader(live[0], project) : undefined;
  const database = auditPath && auditPath !== ":memory:" ? resolve(auditPath) : undefined;
  const release = database ? lockWorkbench(database) : undefined;
  const audit = (() => {
    try {
      return openActivityStore(database, Date.now, auditThresholds);
    } catch (error) {
      release?.();
      throw error;
    }
  })();
  const closeStore = () => {
    try { audit.close(); } finally { release?.(); }
  };
  const { promptMaxLength, answerMaxLength } = inputLimits;
  // JSON 可能将每个 UTF-16 码元转义为六个字节，给包裹字段另留空间。
  const promptBodyBytes = jsonMetadataBudget + 6 * promptMaxLength;
  const answerBodyBytes = jsonMetadataBudget + 6 * answerMaxLength * maxQuestionsPerDecision;
  const demo = createDecisionDemo(receiptDelay, audit.record, answerMaxLength);
  const monitor = live ? createDispatchMonitor(hostName) : undefined;
  const recovery = !!(live && database);
  const remoteLink = (() => {
    if (!remoteLan) return undefined;
    try {
      if (!recovery) throw Error("局域网设备接入需要持久化的 Codex 工作台。");
      const handoff = createRemoteHandoff(audit.checkpoint<RemoteDevice>("remote-devices"),
        audit.checkpoint<RemoteJob>("remote-jobs"), remoteLan.offlineMs, Date.now, audit.record);
      const code = issueDelivery && issueTracker ? createWorkers(audit.checkpoint<WorkerAttempt>("remote-code"),
        codeDevices ?? new Set<string>(), readCodeWorkerConfig(), Date.now, audit.record,
        (id, repo, issue, flowId): boolean => {
          const claim = issueTracker.repo.toLowerCase() === repo.toLowerCase() ? github?.amendmentClaim(issue) : undefined;
          return !!claim && claim.approval?.flowId === flowId && claim.state === "OPEN"
            && claim.assignees.length === 1 && claim.assignees[0]?.toLowerCase() === claim.account.toLowerCase()
            && handoff.ownsDevice(id, claim.claimedBy);
        }) : undefined;
      return { handoff, code, ingress: createRemoteWorkerIngress(handoff, remoteLan, code), cert: new X509Certificate(remoteLan.cert).toString() };
    } catch (error) {
      closeStore();
      throw error;
    }
  })();
  const { codex, inbox, flows, dispatch, acceptance, github, issuePlanning, issueAmendments } = (() => {
    try {
      if (database) bindWorkbench(audit, live ? resolve(live[0]) : "", !!memberFor);
      const codex = live ? createCodexInbox(live[0], {
        limit: limits.codex, answerMaxLength, startAttempt: live[1], record: audit.record,
        ...(monitor ? { monitor } : {}),
        ...(recovery ? { store: audit.checkpoint<DecisionCard>("decisions") } : {}),
      }) : undefined;
      const inbox = codex ?? demo;
      const reviewQuality = live ? qualityReviewer ?? createCodexQualityReviewer(live[0], qualityModel ?? issueDelivery?.planningModel) : undefined;
      const dispatch = live ? createLocalDispatch(live[0], dispatchConcurrency, { ...dispatchAdapters, record: audit.record,
        ...(reviewQuality ? { qualityReviewer: reviewQuality } : {}),
        ...(monitor ? { monitor } : {}),
        ...(codexAccounts ? { codexAccounts } : {}),
        ...(recovery ? { store: audit.checkpoint<Run>("dispatch"), artifactRoot: `${database}.artifacts` } : {}),
      }) : undefined;
      const acceptance = memberFor && createAcceptance(audit.record, recovery ? audit.checkpoint<StoredAcceptance>("acceptance") : undefined);
      if (issueTracker && (!recovery || !monitor)) throw Error("GitHub 认领需要持久化的 Codex 工作台。");
      if (issueDelivery && !issueDelivery.conversation) throw Error("GitHub 代码交付需要使用对话规划与派发前质量校验。");
      const publishIssues = live && issueTracker?.creation
        ? createPlannedIssuePublication(audit.checkpoint<IssuePublication>(`github-publications:${issueTracker.repo.toLowerCase()}`)) : undefined;
      let reviewScope: ((claim: Claim) => DeliveryReviewScope | undefined) | undefined;
      let reviewSourceHandoff: NonNullable<IssueDeliveryOptions["reviewSourceHandoff"]> | undefined;
      const github = issueTracker && monitor ? createIssueDispatch(issueTracker,
        audit.checkpoint<Claim>(`github-issues:${issueTracker.repo.toLowerCase()}`),
        verifyIssue ?? createIssueVerifier(monitor, codexAccounts ? { codexAccounts } : {}),
        audit.record, dispatchConcurrency, memberTrackers, issueDelivery && {
          specs: issueDelivery.specs, pollMs: issueDelivery.pollMs, conversation: true, requireQuality: true,
          ...(issueDelivery.recoverFailedIssue ? { recoverFailedIssue: issueDelivery.recoverFailedIssue } : {}),
          ...(issueDelivery.recoverDeviceTestAttempts ? { recoverDeviceTestAttempts: issueDelivery.recoverDeviceTestAttempts } : {}),
          ...(issueDelivery.recoverCheckedHeads ? { recoverCheckedHeads: issueDelivery.recoverCheckedHeads } : {}),
          legacyReviewTestFailure: audit.legacyReviewTestFailure,
          ...(issueDelivery.reviewFix ? { reviewFix: issueDelivery.reviewFix } : {}),
          ...(issueDelivery.reviewFixes ? { reviewFixes: issueDelivery.reviewFixes } : {}),
          ...(issueDelivery.sourceRefresh ? { sourceRefresh: issueDelivery.sourceRefresh } : {}),
          ...(remoteLink?.code ? { hasWorkerAttempt: remoteLink.code.hasAttempt } : {}),
          ...(publishIssues ? { publishRepair: publishIssues } : {}),
          ...(remoteLink?.code ? { failedWorkerAttempt: remoteLink.code.failedAttempt } : {}),
          inspectRepairCandidate: createRepairCandidateInspector({ ...issueDelivery, root: `${database}.artifacts/github` }),
          async reviewSourceHandoff(claim, proof, sources, signal) {
            if (!reviewSourceHandoff) throw Error("无法复核上游源码交接。");
            return reviewSourceHandoff(claim, proof, sources, signal);
          },
          ...(live ? { review: issueDelivery.review ?? createGitHubDeliveryReviewer(live[0], claim => reviewScope?.(claim),
            createCodexDeliveryReviewer(live[0], issueDelivery.timeoutMs, qualityModel ?? issueDelivery.planningModel)),
            reviewScopeCurrent: issueDelivery.reviewScopeCurrent ?? (claim => !!reviewScope?.(claim)) } : {}),
          prepare: createIssueDeveloper(monitor, { ...issueDelivery, root: `${database}.artifacts/github`,
            ...(codexAccounts ? { codexAccounts } : {}),
            ...(codeDevices?.size && remoteLink?.code ? { workers: remoteLink.code } : {}) }),
        }) : undefined;
      const issuePlanning = live && github && issueTracker && issueDelivery?.conversation && reviewQuality
        ? createConversationDelivery(github, audit.checkpoint<IssueProposal>(`github-proposals:${issueTracker.repo.toLowerCase()}`),
          createGitHubSelector(live[0], { timeoutMs: issueDelivery.timeoutMs, newIssues: !!(dispatch && issueTracker.creation),
            ...(issueDelivery.planningModel ? { model: issueDelivery.planningModel } : {}) }), reviewQuality,
          (revision, paths, signal) => qualitySources(live[0], revision, paths, signal),
          dispatch && publishIssues ? {
            draft: dispatch.planGitHub,
            publish: publishIssues,
            connection: actor => github.permits(actor) ? memberTrackers?.get(actor) ?? issueTracker : undefined,
            ...(!qualityReviewer || ticketSourceReviewer ? { sourceReview: { concurrency: dispatchConcurrency,
              reviewer: ticketSourceReviewer ?? createCodexTicketSourceReviewer(live[0], qualityModel ?? issueDelivery.planningModel, issueDelivery.timeoutMs) } } : {}),
          } : undefined) : undefined;
      const projectContext = loadProject && live ? async (flow: Flow) => {
        const [context, issues] = await Promise.all([
          loadProject(), issuePlanning && github ? github.suggest().catch(() => undefined) : undefined,
        ]);
        if (issuePlanning && issueTracker) {
          context.evidence.issueCandidates = snapshotIssueCandidates(issues ?? []);
          if (context.evidence.github.repo?.toLowerCase() === issueTracker.repo.toLowerCase()) {
            const related = await readRelatedIssues(issueTracker, issues ?? [], context.planText);
            context.evidence.relatedIssues = related.issues;
            if (related.pullRequests.length) context.evidence.relatedPullRequests = related.pullRequests;
            if (related.omissions) context.evidence.relatedIssueOmissions = related.omissions;
          }
        }
        const revision = context.evidence.repository?.revision;
        if (revision) {
          const sources = await freezePlanningSources(live[0], revision,
            [flow.prompt, ...(flow.replan?.sourcePaths ?? []), flow.replan?.findings ?? "", context.planText ?? "",
              ...(context.evidence.issueCandidates ?? []).map(issue => issue.body ?? ""),
              ...(context.evidence.relatedIssues ?? []).flatMap(issue => issue.status === "read" ? [issue.source.body ?? ""] : []),
              ...(context.evidence.relatedPullRequests ?? []).map(pr => pr.source.body ?? "")]);
          if (sources) context.evidence.planningSources = sources;
        }
        return context;
      } : undefined;
      const flows = createConversationFlows(inbox.runPhase, codex ? limits.codex : limits.demo, audit.record, projectContext,
        recovery ? audit.checkpoint<StoredFlow>("flows") : undefined, issuePlanning?.begin,
        codex ? flowId => codex.snapshot().requests.flatMap(card => card.flowId === flowId && card.status === "closed"
          ? card.questions.flatMap(question => {
            const answer = card.answers?.[question.id];
            return answer === undefined ? [] : [{ cardId: card.id, questionId: question.id, question: scrubAuditText(question.prompt), answer,
              ...(card.clarificationOrigin ? { origin: card.clarificationOrigin } : {}) }];
          }) : []) : undefined);
      reviewScope = claim => {
        const scope = issuePlanning?.reviewScope(claim, flows.list().find(flow => flow.id === claim.approval?.flowId));
        return scope && { ...scope, files: [...scope.files, ...(claim.reviewTestFiles ?? [])] };
      };
      if (issuePlanning) reviewSourceHandoff = (claim, proof, sources, signal) =>
        issuePlanning.reviewHandoff(claim, flows.list().find(flow => flow.id === claim.approval?.flowId), proof, sources, signal);
      const issueAmendments = github && issuePlanning && issueTracker ? createPrePrAmendments(
        audit.checkpoint<PrePrAmendmentEvent>(`github-pre-pr-amendments:${issueTracker.repo.toLowerCase()}`), {
          candidate: github.amendmentCandidate, claim: github.amendmentClaim,
          scope: claim => issuePlanning.reviewScope(claim, flows.list().find(flow => flow.id === claim.approval?.flowId)),
          authorize: github.authorizeAmendment,
        }) : undefined;
      flows.reopenReady();
      return { codex, inbox, flows, dispatch, acceptance, github, issuePlanning, issueAmendments };
    } catch (error) {
      closeStore();
      throw error;
    }
  })();
  function replanFeedback(flow: ReturnType<typeof flows.list>[number], actor: string, member?: Member) {
    if (!loadProject || !codex || flow.status !== "ready" || member?.id === "reviewer"
      || (flow.requestedBy && flow.requestedBy !== actor) || (!flow.requestedBy && member)
      || issuePlanning?.locks(flow.id) || dispatch?.isRunning(flow.id)) return;
    const plan = currentDevelopmentPlan(flow);
    if (!plan) return;
    const runs = dispatch?.list() ?? [];
    if (runs.some(run => run.flowId === flow.id && run.status === "preparing")) return;
    const decision = acceptance?.decision(flow, runs);
    if (decision === "submitted" || decision === "accepted") return;
    const remote = issuePlanning?.replanFeedback(flow, actor);
    if (remote) return remote;
    const run = runs.reverse().find(item => item.flowId === flow.id && item.kind === "code"
      && item.plan.id === plan.id && item.plan.version === plan.version);
    if (run?.status === "failed" && run.error && run.quality
      && Object.values(run.quality.checks).some(check => check.status === "block")) {
      return { batchId: run.id, findings: run.error };
    }
  }
  const snapshot = (member?: Member) => {
    const conversations = flows.list();
    const reviewCards = dispatch?.reviews().map(({ run, job, artifact, patchPath, successors }): DecisionCard => ({
      id: artifact.id,
      kind: "code-review",
      flowId: run.flowId,
      title: `${job.id} ${job.title} · ${conversations.find(flow => flow.id === run.flowId)?.title ?? ""}`,
      session: `代码产物验收 · 计划 v${run.plan.version}`,
      prompt: [job.report, `本地补丁 ${patchPath}`, `SHA-256 ${artifact.patchSha256}`].filter(Boolean).join("\n"),
      status: "pending",
      questions: [{
        id: "review", title: "代码产物验收", prompt: `复核这份补丁，通过后可继续 ${successors.map(item => item.id).join("、")}。`,
        allowCustom: false,
        options: [{ label: codeReviewOptions[0], description: "仅允许后续工单使用这一版补丁。" },
          { label: codeReviewOptions[1], description: "阻止依赖这份补丁的工单。" }],
      }],
      timeline: [{ label: "前置补丁已就绪", at: new Date(job.finishedAt ?? 0).toISOString() }],
    })) ?? [];
    const state = inbox.snapshot();
    const actor = member?.login ?? member?.id ?? "personal";
    const issueCards = issuePlanning?.cards(conversations, actor) ?? [];
    const repairCards = github?.repairCards(actor) ?? [];
    const deliveryReviews = github ? conversations.flatMap(flow => {
      const reviews = github.reviewStatus(flow.id, actor, member?.id === "reviewer");
      return reviews.length ? [{ flowId: flow.id, reviews }] : [];
    }) : [];
    return {
      ...state, requests: [...state.requests, ...reviewCards, ...issueCards, ...repairCards, ...(issueAmendments?.cards(actor) ?? [])],
      ...(issuePlanning ? { issuePlans: issuePlanning.statuses(conversations, actor) } : {}),
      ...(deliveryReviews.length ? { deliveryReviews } : {}),
      flows: conversations.map(flow => ({ ...flow, ...(replanFeedback(flow, actor, member) ? { canReplan: true } : {}) })),
      phases: phases.map(phase => phase.title), inputLimits,
      member, githubEnabled: !!github,
      acceptanceNoteMaxLength: maxAcceptanceNote,
      planMaxLength: maxArtifactTextLength, dispatches: dispatch?.list().map(run =>
        acceptance ? { ...run, acceptance: acceptance.history(run.id) } : run) ?? [],
    };
  };
  const assets = new Map<string, { content: Buffer; mime: string }>(files.map(([path, name, mime]) => [
    path, { content: readFileSync(new URL(`./public/${name}`, import.meta.url)), mime },
  ]));
  assets.set("/vendor/markdown-it.mjs", {
    content: readFileSync(new URL(import.meta.resolve("markdown-it/browser"))), mime: "text/javascript",
  });
  const server = createServer(async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Content-Security-Policy", "default-src 'self'; img-src data:; frame-ancestors 'none'; base-uri 'none'");

    function send(status: number, body: object) {
      response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(body));
    }

    const local = server.address();
    const path = request.url ?? "";
    if (!local || typeof local === "string" || request.headers.host !== `${address}:${local.port}`) {
      return send(403, { error: "请从本机演示地址访问。" });
    }
    const member = memberFor?.(request.headers.authorization);
    if (memberFor && !member) {
      if (path === "/" && request.method === "GET") response.setHeader("WWW-Authenticate", 'Basic realm="souflow", charset="UTF-8"');
      return send(401, { error: "请以 souflow 成员身份登录。" });
    }
    const state = () => snapshot(member);
    const githubActor = member?.login ?? member?.id ?? "personal";
    const canClaim = member?.id !== "reviewer" && !!github?.permits(githubActor);
    function allowed(role: "implementer" | "reviewer", action: string, subject?: string) {
      if (!member || member.id === role) return true;
      audit.record({ kind: "member.denied", ...(subject ? { subject } : {}), details: { actor: member.login ?? member.id, action } });
      send(403, { error: "当前成员无权执行此操作。" });
      return false;
    }
    if (request.method === "GET") {
      if (path === "/api/remote/personal-devices" && remoteLink) {
        if (!member) return send(403, { error: "请以工作台成员身份登录。" });
        const code = remoteLink.code;
        const workers = new Map(code?.snapshot().devices.map(worker => [worker.id, worker]));
        const devices = remoteLink.handoff.snapshot().devices
          .filter(device => remoteLink.handoff.ownsDevice(device.id, githubActor))
          .map(({ id, name }) => {
            const worker = workers.get(id);
            const online = worker?.online === true;
            const slots = worker?.slots ?? 0;
            return { id, name, owner: githubActor, permitted: code?.permits(id) === true,
              online, ready: online && worker?.ready === true, slots,
              availableSlots: online ? Math.max(0, slots - (worker?.count ?? 0)) : 0 };
          });
        const identity = githubActor === member.label ? member.label : `${member.label}（${githubActor}）`;
        return send(200, { identity, devices });
      }
      if (path === "/api/github/issues" && github) return send(200, github.snapshot(canClaim));
      if (path === "/api/decisions") return send(200, state());
      if (path === "/api/dispatch-status" && monitor && dispatch) {
        const names = new Map(flows.list().map(flow => [flow.id, scrubAuditText(flow.title)]));
        const reviewing = new Set(dispatch.reviews().map(item => item.artifact.id));
        const runs = dispatch.list().filter(run => run.status !== "ready" && run.status !== "preparing");
        const jobs = runs.filter((run, index) => index >= runs.length - recentMonitorRuns || run.status === "running" || run.status === "waiting")
          .flatMap(run => {
            const byId = new Map(run.jobs.map(job => [job.id, job]));
            return run.jobs.map(job => {
              // 旧批次拦截时可能保留草稿状态。批次已失败，这些草稿只作为历史展示。
              const blockedByBatch = run.status === "failed" && job.status === "queued";
              const status = blockedByBatch ? "blocked" as const : job.status;
              return {
                flowId: run.flowId, batchId: run.id, planVersion: run.plan.version, ticketId: job.id, task: scrubAuditText(job.title),
                title: names.get(run.flowId), dependsOn: job.dependsOn, status, ...(blockedByBatch ? { blockedByBatch } : {}),
                waitingOn: status === "queued" ? job.dependsOn.filter(id => {
                  const input = byId.get(id);
                  return input?.status !== "ready" || (run.kind === "code" && input.artifact?.review !== "accepted");
                }) : [],
                startedAt: job.startedAt, finishedAt: job.finishedAt, accountRef: job.accountRef, accountAssignment: job.accountAssignment,
                reviewing: job.artifact ? reviewing.has(job.artifact.id) : false, review: job.artifact?.review,
              };
            });
          });
        const remote = remoteLink?.handoff.snapshot();
        const code = remoteLink?.code;
        return send(200, { ...monitor.snapshot(), jobs, overview: dispatchOverview(jobs, remote?.jobs ?? []),
          waiting: jobs.filter(job => job.status === "queued"), ...(remoteLink ? {
          remote: { ...remote, devices: remote?.devices.map(device => ({ ...device, code: code?.permits(device.id) ?? false })),
            endpoint: remoteLink.ingress.endpoint(), canManage: !member || member.id === "implementer" },
          ...(code ? { codeWorkers: code.snapshot() } : {}),
        } : {}) });
      }
      if (path === "/api/audit" || path.startsWith("/api/audit?")) {
        if (request.headers["sec-fetch-site"] === "cross-site") return send(403, { error: "请在本机工作台查看活动记录。" });
        const range = new URLSearchParams(path.split("?")[1]).get("days") ?? "7";
        if (!["1", "7", "30"].includes(range)) return send(422, { error: "请选择 1、7 或 30 天。" });
        try {
          return send(200, audit.report(Number(range)));
        } catch {
          return send(503, { error: "暂时无法读取活动记录。" });
        }
      }
      const asset = assets.get(path);
      if (asset) {
        response.writeHead(200, { "Content-Type": `${asset.mime}; charset=utf-8` });
        response.end(asset.content);
        return;
      }
    }
    if (request.method === "POST") {
      // 页面操作仅接受当前本机地址发起的请求。
      if (request.headers.origin !== `http://${address}:${local.port}`) {
        return send(403, { error: "请求来源与工作台地址不一致。" });
      }
      const pairing = /^\/api\/remote\/personal-devices\/(pair|confirm)$/.exec(path)?.[1];
      const revokeOwned = /^\/api\/remote\/personal-devices\/([a-f0-9-]{36})\/revoke$/.exec(path)?.[1];
      if (remoteLink && (pairing || revokeOwned)) {
        if (!member) return send(403, { error: "请以工作台成员身份登录。" });
        if (revokeOwned) {
          if (!remoteLink.handoff.ownsDevice(revokeOwned, githubActor)) return send(404, { error: "找不到可撤销的设备。" });
          const status = remoteLink.handoff.revoke(revokeOwned, githubActor);
          if (status === 200) remoteLink.code?.disconnect(revokeOwned);
          return send(status, status === 200 ? { revoked: true } : { error: "无法撤销设备接入。" });
        }
        const endpoint = remoteLink.ingress.endpoint();
        if (!endpoint) return send(503, { error: "设备 HTTPS 接口尚未启动。" });
        const body = await readJson(request);
        if ("status" in body) return send(body.status, { error: body.error });
        const input = body.value as { name?: unknown; code?: unknown } | null;
        if (pairing === "pair") {
          const result = remoteLink.handoff.startPairing(input?.name, githubActor);
          return send(result.status, result.status === 201 ? { code: result.code, expiresAt: result.expiresAt }
            : { error: result.status === 422 ? "请填写有效的设备名称。" : "暂时无法发起配对。" });
        }
        const result = remoteLink.handoff.confirmPairing(input?.code, githubActor);
        return send(result.status, result.status === 201 ? { ...result.bundle, endpoint, certificate: remoteLink.cert }
          : { error: result.status === 409 ? "配对码无效或已过期，或设备名称、数量与现有登记冲突。" : "暂时无法保存绑定。" });
      }
      const revokeDevice = /^\/api\/remote\/devices\/([a-f0-9-]{36})\/revoke$/.exec(path)?.[1];
      if (remoteLink && (path === "/api/remote/devices" || path === "/api/remote/jobs" || revokeDevice)) {
        if (!allowed("implementer", "remote.handoff")) return;
        const actor = member?.login ?? member?.id ?? "personal";
        if (revokeDevice) {
          const status = remoteLink.handoff.revoke(revokeDevice, actor);
          if (status === 200) remoteLink.code?.disconnect(revokeDevice);
          return send(status, status === 200 ? { revoked: true } : { error: "无法撤销设备接入。" });
        }
        const body = await readJson(request);
        if ("status" in body) return send(body.status, { error: body.error });
        if (path === "/api/remote/devices") {
          const endpoint = remoteLink.ingress.endpoint();
          if (!endpoint) return send(503, { error: "局域网设备接口尚未启动。" });
          const result = remoteLink.handoff.addDevice((body.value as { name?: unknown } | null)?.name, actor);
          if (result.status !== 201) return send(result.status, { error: "设备名称无效、已存在或暂时无法保存。" });
          return send(201, { ...result.bundle, endpoint, certificate: remoteLink.cert });
        }
        const selection = body.value as { deviceId?: unknown; paths?: unknown } | null;
        if (typeof selection?.deviceId === "string" && remoteLink.code?.permits(selection.deviceId)) {
          return send(422, { error: "此设备接收调度器派发的代码工单。" });
        }
        try {
          if (!live) return send(503, { error: "局域网设备接口尚未启动。" });
          const { revision, files } = await readRemoteFiles(live[0], selection?.paths);
          const result = remoteLink.handoff.enqueue(selection?.deviceId, revision, files, actor);
          return send(result.status, result.status === 201 ? { id: result.id } : { error: "请检查设备与当前未完成工单。" });
        } catch {
          return send(422, { error: "请选择已提交到 docs/ 的普通 Markdown 文件。" });
        }
      }
      if (github && (path === "/api/github/issues/refresh" || path === "/api/github/issues/claim")) {
        const claim = path.endsWith("/claim");
        if (claim && !allowed("implementer", "github.claim")) return;
        const body = await readJson(request);
        if ("status" in body) return send(body.status, { error: body.error });
        const id = (body.value as { requestId?: unknown } | null)?.requestId;
        if (claim && (typeof id !== "string" || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id))) {
          return send(422, { error: "认领请求缺少有效标识。" });
        }
        try {
          if (claim && typeof id === "string") await github.claim(id, githubActor);
          else await github.refresh();
          return send(200, github.snapshot(canClaim));
        } catch (error) {
          return error instanceof IssueActionError ? send(error.status, { error: error.message })
            : send(503, { error: "无法读取 GitHub。请核对仓库、网络与本机 gh 登录权限。" });
        }
      }
      if (path === "/api/activity") {
        const body = await readJson(request);
        if ("status" in body) return send(body.status, { error: body.error });
        const event = readActivity(body.value);
        if (!event) return send(422, { error: "无法识别操作。" });
        return audit.recordActivity(event) ? send(200, { recorded: true }) : send(503, { error: "暂时无法记录操作。" });
      }
      if (path === "/api/workflows" || (codex && path === "/api/sessions")) {
        if (!allowed("implementer", "request.start")) return;
        const body = await readJson(request, promptBodyBytes);
        if ("status" in body) return send(body.status, { error: body.error });
        const prompt = (body.value as { prompt?: unknown } | null)?.prompt;
        if (typeof prompt !== "string" || !prompt.trim() || prompt.length > promptMaxLength) {
          return send(422, { error: `请填写不超过 ${promptMaxLength} 字的需求。` });
        }
        if (path === "/api/workflows") {
          const flow = !codex || codex.canBegin() ? flows.begin(prompt.trim(), codex ? githubActor : undefined) : undefined;
          if (flow === null) return send(503, { error: "暂时无法保存需求。" });
          return flow ? send(200, { ...state(), flowId: flow.id }) : send(409, {
            ...state(), error: "进行中的需求已达上限，请先处理待决策事项。",
          });
        }
        const status = codex?.begin(prompt.trim()) ?? 404;
        return send(status, status === 200 ? state() : {
          ...state(),
          error: status === 409 ? `已有 ${limits.codex} 条会话进行中。` : "无法启动 Codex 会话。",
        });
      }
      if (!codex && path === "/api/demo/reset") {
        audit.record({ kind: "demo.reset", details: { flowIds: flows.list().filter(flow => flow.status === "running").map(flow => flow.id) } });
        demo.reset();
        flows.reset();
        return send(200, state());
      }
      const resumeFlow = /^\/api\/workflows\/([a-f0-9-]+)\/resume$/.exec(path)?.[1];
      if (resumeFlow && codex) {
        if (!allowed("implementer", "flow.resume", resumeFlow)) return;
        const flow = flows.list().find(item => item.id === resumeFlow);
        if (!flow) return send(404, { error: "需求对话不存在。" });
        const ownsReplan = !flow.replan || flow.requestedBy === githubActor;
        const status = ownsReplan && codex.canBegin() ? flows.resume(flow) : 409;
        return status === 200 ? send(200, { ...state(), flowId: flow.id }) : send(status, {
          ...state(), error: status === 503 ? "暂时无法保存规划状态。" : "需求当前不可恢复，或进行中的会话已达上限。",
        });
      }
      const replanFlow = /^\/api\/workflows\/([a-f0-9-]+)\/replan$/.exec(path)?.[1];
      if (replanFlow && codex) {
        if (!allowed("implementer", "flow.replan", replanFlow)) return;
        const flow = flows.list().find(item => item.id === replanFlow);
        const feedback = flow && replanFeedback(flow, githubActor, member);
        const status = flow && feedback && codex.canBegin() ? flows.replan(flow, feedback, githubActor) : flow ? 409 : 404;
        return status === 200 ? send(200, { ...state(), flowId: replanFlow }) : send(status, {
          ...state(), error: status === 503 ? "暂时无法保存重规划状态。" : "当前对话无法重新规划，请核对批次和授权状态。",
        });
      }
      const retrySelection = /^\/api\/workflows\/([a-f0-9-]+)\/github-selection\/retry$/.exec(path)?.[1];
      const amendmentFlow = /^\/api\/workflows\/([a-f0-9-]+)\/github-amendments$/.exec(path)?.[1];
      if (amendmentFlow && issueAmendments) {
        if (!allowed("implementer", "github.amendment.prepare", amendmentFlow)) return;
        const flow = flows.list().find(item => item.id === amendmentFlow && item.requestedBy === githubActor);
        if (!flow) return send(404, { error: "需求对话不存在。" });
        const body = await readJson(request);
        if ("status" in body) return send(body.status, { error: body.error });
        const status = issueAmendments.submit(flow.id, githubActor, body.value);
        return send(status, status === 200 ? state() : { error: status === 422 ? "请固定原批次、失败尝试、两个源码版本、测试范围和验证步骤。"
          : status === 503 ? "暂时无法保存修订。" : "原工单或修订版本已变化，请核对原对话。" });
      }
      if (retrySelection && issuePlanning) {
        if (!allowed("implementer", "github.selection.retry", retrySelection)) return;
        const flow = flows.list().find(item => item.id === retrySelection && item.requestedBy === githubActor);
        if (!flow) return send(404, { error: "需求对话不存在。" });
        return flows.retryIssueSelection(flow) ? send(200, state()) : send(409, { error: "当前选单无法重试。" });
      }
      const retryPublication = /^\/api\/workflows\/([a-f0-9-]+)\/github-publication\/resume$/.exec(path)?.[1];
      if (retryPublication && issuePlanning) {
        if (!allowed("implementer", "github.publication.resume", retryPublication)) return;
        const flow = flows.list().find(item => item.id === retryPublication && item.requestedBy === githubActor);
        if (!flow) return send(404, { error: "需求对话不存在。" });
        const status = await issuePlanning.resumePublication(flow, githubActor);
        return status === 200 ? send(200, state()) : send(status, { ...state(), error: "GitHub 建单或认领回执仍待核对。" });
      }
      const revisionRoute = /^\/api\/workflows\/([a-f0-9-]+)\/(plan|prd)\/revise$/.exec(path);
      const revisionFlow = revisionRoute?.[1];
      if (revisionFlow) {
        const isPrd = revisionRoute?.[2] === "prd";
        const action = isPrd ? "prd.revise" : "plan.revise";
        const label = isPrd ? "PRD" : "开发计划";
        if (!allowed("implementer", action, revisionFlow)) return;
        const flow = flows.list().find(item => item.id === revisionFlow);
        if (!flow) return send(404, { error: "需求对话不存在。" });
        if (issuePlanning && flow.requestedBy && flow.requestedBy !== githubActor) {
          audit.record({ kind: "member.denied", subject: revisionFlow, details: { actor: githubActor, action } });
          return send(403, { error: "请由对话发起者修订 GitHub 交付文档。" });
        }
        const body = await readJson(request, jsonMetadataBudget + 6 * maxArtifactTextLength);
        if ("status" in body) return send(body.status, { error: body.error });
        const revision = readPlanRevision(body.value);
        if (!revision) return send(422, { error: `请填写有效版本和 1 到 ${maxArtifactTextLength} 字的${label}内容。` });
        const decision = acceptance?.decision(flow, dispatch?.list() ?? []);
        const status = issuePlanning?.locks(flow.id) || dispatch?.isRunning(flow.id) || decision === "submitted" || decision === "accepted"
          ? 409 : flows.reviseDocument(flow, isPrd ? "prd" : "development-plan", revision);
        if (status === 200 && member) audit.record({ kind: "member.revised", flowId: flow.id,
          details: { actor: member.login ?? member.id, document: label, version: revision.version + 1,
            ...(isPrd ? {} : { plan: revision.version + 1 }) } });
        return status === 200 ? send(200, state()) : send(status, {
          ...state(),
          error: status === 409 ? "文档或引用的 PRD 版本已变更，或当前批次仍在执行、待验收或已通过。"
            : status === 503 ? `暂时无法保存${label}。` : `${label}内容没有变化。`,
        });
      }
      const dispatchAction = /^\/api\/workflows\/([a-f0-9-]+)\/local-dispatch\/(prepare|start)$/.exec(path);
      if (dispatchAction && dispatch) {
        if (!allowed("implementer", "dispatch.change", dispatchAction[1])) return;
        const flow = flows.list().find(item => item.id === dispatchAction[1]);
        if (!flow) return send(404, { error: "需求对话不存在。" });
        const body = dispatchAction[2] === "prepare" && request.headers["content-type"] === undefined
          ? { value: undefined } : await readJson(request);
        if ("status" in body) return send(body.status, { error: body.error });
        if (acceptance?.decision(flow, dispatch.list())) return send(409, { error: "当前计划已有验收记录。退回后请修订计划再派发。" });
        if (dispatchAction[2] === "prepare") {
          const kind = (body.value as { kind?: unknown } | null)?.kind ?? "report";
          if (kind !== "report" && kind !== "code") return send(422, { error: "请选择已支持的工单类型。" });
          const status = dispatch.prepare(flow, kind);
          return status === 200 ? send(200, state()) : send(status, {
            error: status === 503 ? "暂时无法保存工单。" : "请等待其他本地任务结束，再准备已完成计划的工单。",
          });
        }
        const id = (body.value as { id?: unknown } | null)?.id;
        const status = dispatch.start(flow, id);
        return status === 200 ? send(200, state()) : send(status, {
          error: status === 503 ? "暂时无法保存工单。" : "工单尚未就绪，或确认的计划已失效。",
        });
      }
      const delivery = /^\/api\/acceptance\/([a-f0-9-]+)\/(submit|return|accept)$/.exec(path);
      if (delivery && member && acceptance && dispatch) {
        const action = delivery[2] as AcceptanceAction;
        if (!allowed(action === "submit" ? "implementer" : "reviewer", `acceptance.${action}`, delivery[1])) return;
        const run = dispatch.list().find(item => item.id === delivery[1]);
        const flow = run && flows.list().find(item => item.id === run.flowId);
        if (!run || !flow) return send(404, { error: "工单批次不存在。" });
        const body = await readJson(request);
        if ("status" in body) return send(body.status, { error: body.error });
        const status = await acceptance.decide(action, run, member, body.value, () => {
          const plan = currentDevelopmentPlan(flow);
          return plan?.id === run.plan.id && plan.version === run.plan.version && !dispatch.isRunning(flow.id)
            && (action !== "submit" || !acceptance.decision(flow, dispatch.list()));
        });
        return status === 200 ? send(200, state()) : send(status, {
          error: status === 422 ? `请填写有效的交付说明或验收备注（最多 ${maxAcceptanceNote} 字）。`
            : status === 503 ? "暂时无法写入验收记录。" : "批次状态、计划版本或交付文件已变化，请核对后再试。",
        });
      }
      const action = /^\/api\/decisions\/([a-f0-9-]+)\/(answer|disconnect)$/.exec(path);
      if (action?.[1]) {
        let status: ReturnType<typeof inbox.submit>;
        if (action[2] === "disconnect") {
          if (codex) return send(404, { error: "该操作用于本地演示。" });
          status = demo.disconnect(action[1]);
        } else {
          if (issueAmendments?.has(action[1])) {
            if (!allowed("implementer", "github.amendment.authorize", action[1])) return;
            const body = await readJson(request, answerBodyBytes);
            if ("status" in body) return send(body.status, { error: body.error });
            const result = await issueAmendments.answer(action[1], githubActor, body.value);
            return send(result, result === 200 ? state() : { ...state(), error: result === 422 ? "请选择有效授权选项。"
              : result === 503 ? "暂时无法保存修订授权。" : "修订与原工单、最新失败尝试或当前主干不符。" });
          }
          if (github?.hasRepair(action[1])) {
            if (!allowed("implementer", "github.repair.authorize", action[1])) return;
            const body = await readJson(request, answerBodyBytes);
            if ("status" in body) return send(body.status, { error: body.error });
            const result = github.answerRepair(action[1], githubActor, body.value);
            return send(result, result === 200 ? state() : { ...state(),
              error: result === 422 ? "请选择有效授权选项。" : result === 503 ? "暂时无法保存授权。"
                : "修复授权已处理，或原工单、PR 或复核版本已变化。" });
          }
          if (issuePlanning?.has(action[1])) {
            if (!allowed("implementer", "github.authorize", action[1])) return;
            const body = await readJson(request, answerBodyBytes);
            if ("status" in body) return send(body.status, { error: body.error });
            const result = await issuePlanning.answer(action[1], githubActor, body.value, flows.list());
            return send(result, result === 200 ? state() : { ...state(),
              error: result === 422 ? "请选择有效授权选项。" : result === 503 ? "暂时无法保存授权。"
                : result === 409 && issuePlanning.publicationNeedsCheck(action[1], githubActor) ? "授权已记录，建单或派发回执待核对。"
                  : "授权已失效或工单状态已变化，请核对 GitHub 状态。" });
          }
          const regular = inbox.snapshot().requests.some(card => card.id === action[1]);
          if (!allowed(regular ? "implementer" : "reviewer", regular ? "decision.answer" : "dispatch.review", action[1])) return;
          const body = await readJson(request, answerBodyBytes);
          if ("status" in body) return send(body.status, { error: body.error });
          status = inbox.submit(action[1], body.value);
          if (status === 404 && dispatch) {
            const review = await dispatch.review(action[1], body.value, flows.list(), member?.id);
            if (review !== 404) return send(review, review === 200 ? state() : {
              ...state(),
              error: review === 422 ? "请选择有效的代码产物验收结果。"
                : review === 503 ? "暂时无法写入验收记录。" : "验收事项已处理或补丁版本已失效。",
            });
          }
        }
        const errors: Record<404 | 409 | 422 | 503, string> = {
          503: "暂时无法保存答复，请稍后重试。",
          404: "这条提问已失效或已被移除。",
          409: "这条提问已有答复或已失效。",
          422: `请为每个问题填写有效回答，自定义回答最多 ${answerMaxLength} 字。`,
        };
        return send(status, status === 200 ? state() : {
          ...state(),
          error: errors[status],
        });
      }
    }
    send(404, { error: "地址不存在。" });
  });
  if (remoteLink) server.once("listening", remoteLink.ingress.start);
  server.on("close", () => {
    remoteLink?.code?.close();
    remoteLink?.ingress.close();
    const attempts = inbox.close();
    // 结束尝试时仍会产生最终状态，先让编排写完这些事件再关闭存储。
    void Promise.allSettled([attempts, flows.settled(), dispatch?.close(), issuePlanning?.close(), github?.close()]).then(() => {
      closeStore();
      server.emit("workbenchClosed");
    });
  });
  return server;
}

function integerSetting(name: string, fallback: number, minimum: number, maximum = Number.MAX_SAFE_INTEGER) {
  const value = process.env[name]?.trim();
  if (!value) return fallback;
  const number = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(number) || number < minimum || number > maximum) {
    throw new Error(`${name} 必须为 ${minimum} 到 ${maximum} 之间的整数。`);
  }
  return number;
}

function stringMapSetting(name: string): Record<string, string> {
  const raw = process.env[name];
  if (!raw) return {};
  try {
    const value: unknown = JSON.parse(raw);
    if (value && typeof value === "object" && !Array.isArray(value) && Object.values(value).every(v => typeof v === "string")) {
      return value as Record<string, string>;
    }
  } catch { /* 配置解析失败时避免将凭据片段带入终端日志。 */ }
  throw Error(`${name} 必须是登录名到字符串的 JSON 对象。`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  loadLocalEnv();
  const port = integerSetting("SOULFLOW_DEMO_PORT", 4173, 0, 65_535);
  const live = process.argv.includes("--codex");
  const auditPath = process.env.SOULFLOW_AUDIT_DB || resolve(".souflow", live ? "codex-audit.sqlite" : "demo-audit.sqlite");
  const limits = {
    demo: integerSetting("SOULFLOW_DEMO_MAX_CONCURRENT", defaultLimits.demo, 1),
    codex: integerSetting("SOULFLOW_CODEX_MAX_CONCURRENT", defaultLimits.codex, 1),
  };
  const inputLimits = {
    promptMaxLength: integerSetting("SOULFLOW_PROMPT_MAX_LENGTH", defaultInputLimits.promptMaxLength, 1, maxConfigurableInputLength),
    answerMaxLength: integerSetting("SOULFLOW_ANSWER_MAX_LENGTH", defaultInputLimits.answerMaxLength, 1, maxConfigurableInputLength),
  };
  const auditThresholds = {
    repeatClickMs: integerSetting("SOULFLOW_AUDIT_REPEAT_CLICK_MS", defaultAuditThresholds.repeatClickMs, 1),
    quickReturnMs: integerSetting("SOULFLOW_AUDIT_QUICK_RETURN_MS", defaultAuditThresholds.quickReturnMs, 1),
    insightMinCount: integerSetting("SOULFLOW_AUDIT_INSIGHT_MIN_COUNT", defaultAuditThresholds.insightMinCount, 1),
  };
  const dispatchConcurrency = integerSetting("SOULFLOW_DISPATCH_MAX_CONCURRENT", defaultDispatchConcurrency, 1, 6);
  const accountConfig = process.env.SOULFLOW_CODEX_ACCOUNTS_JSON?.trim();
  const codexAccounts = live && accountConfig ? createCodexAccountDispatch(readCodexProfiles(accountConfig), process.cwd(), {
    refreshMs: integerSetting("SOULFLOW_CODEX_ACCOUNT_REFRESH_MS", 30_000, 1000, 300_000),
    probeMs: integerSetting("SOULFLOW_CODEX_ACCOUNT_PROBE_MS", 10_000, 1000, 60_000),
    waitMs: integerSetting("SOULFLOW_CODEX_ACCOUNT_WAIT_MS", 60_000, 1000, 3_600_000),
    cooldownMs: integerSetting("SOULFLOW_CODEX_ACCOUNT_COOLDOWN_MS", 60_000, 1000, 3_600_000),
  }) : undefined;
  delete process.env.SOULFLOW_CODEX_ACCOUNTS_JSON;
  const planPath = process.env.SOULFLOW_PROJECT_PLAN?.trim();
  const githubRepo = process.env.SOULFLOW_PROJECT_GITHUB_REPO?.trim();
  const advanced = process.env.SOULFLOW_CODEX_PLANNING_MODEL?.trim();
  const routine = process.env.SOULFLOW_CODEX_EXECUTION_MODEL?.trim();
  const hostName = process.env.SOULFLOW_HOST_NAME?.trim();
  const lanHost = process.env.SOULFLOW_LAN_BIND?.trim();
  const lanCert = process.env.SOULFLOW_LAN_CERT_FILE?.trim();
  const lanKey = process.env.SOULFLOW_LAN_KEY_FILE?.trim();
  const remoteLan = lanHost && lanCert && lanKey ? {
    host: lanHost,
    port: integerSetting("SOULFLOW_LAN_PORT", 4717, 0, 65_535),
    offlineMs: integerSetting("SOULFLOW_LAN_OFFLINE_MS", 8000, 1500, 300_000),
    cert: await readFile(lanCert, "utf8"), key: await readFile(lanKey, "utf8"),
  } : undefined;
  if (lanHost || lanCert || lanKey) {
    if (!remoteLan) throw Error("设备接入需同时配置监听地址、TLS 证书和私钥路径。");
    const network = await remoteWorkerNetwork(remoteLan.host);
    if (!network) throw Error("设备接口仅接受局域网、本机回环或 tailscale ip -4 确认的本机 Tailscale IPv4。");
    if (network === "tailscale" && !new X509Certificate(remoteLan.cert).checkIP(remoteLan.host)) {
      throw Error("设备 TLS 证书的 IP SAN 必须包含本机 Tailscale IPv4。");
    }
  }
  const implementer = process.env.SOULFLOW_MEMBER_IMPLEMENTER_KEY;
  const reviewer = process.env.SOULFLOW_MEMBER_REVIEWER_KEY;
  const extra = process.env.SOULFLOW_MEMBER_IMPLEMENTERS_JSON;
  const additionalImplementers = stringMapSetting("SOULFLOW_MEMBER_IMPLEMENTERS_JSON");
  const githubAccounts = stringMapSetting("SOULFLOW_GITHUB_ACCOUNTS");
  delete process.env.SOULFLOW_MEMBER_IMPLEMENTERS_JSON;
  const claimEnabled = live && process.env.SOULFLOW_GITHUB_CLAIMS === "1";
  if (claimEnabled && !githubRepo) throw Error("开启认领前请配置 SOULFLOW_PROJECT_GITHUB_REPO。");
  const issuePlan = process.env.SOULFLOW_GITHUB_DELIVERY_PLAN?.trim();
  const image = process.env.SOULFLOW_GITHUB_CHECK_IMAGE?.trim();
  const conversationDelivery = process.env.SOULFLOW_GITHUB_CONVERSATION_DELIVERY === "1";
  const reviewFix = process.env.SOULFLOW_GITHUB_REVIEW_FIX;
  const sourceRefresh = process.env.SOULFLOW_GITHUB_SOURCE_REFRESH;
  delete process.env.SOULFLOW_GITHUB_REVIEW_FIX;
  delete process.env.SOULFLOW_GITHUB_SOURCE_REFRESH;
  if (reviewFix !== undefined && !conversationDelivery) throw Error("PR 续修需要启用对话工单交付。");
  if (sourceRefresh !== undefined && !conversationDelivery) throw Error("源码复核续派需要启用对话工单交付。");
  const recoverFailedIssue = process.env.SOULFLOW_GITHUB_RECOVER_FAILED_ISSUE === undefined ? undefined
    : integerSetting("SOULFLOW_GITHUB_RECOVER_FAILED_ISSUE", 0, 1, Number.MAX_SAFE_INTEGER);
  if (recoverFailedIssue !== undefined && !conversationDelivery) throw Error("恢复旧工单前请启用对话工单交付。");
  const recoveryAttemptsValue = process.env.SOULFLOW_GITHUB_RECOVER_DEVICE_ATTEMPTS
    ?? process.env.SOULFLOW_GITHUB_RECOVER_DEVICE_TEST_ATTEMPTS;
  const deviceTestAttempts = recoveryAttemptsValue?.split(",").map(id => id.trim()).filter(Boolean) ?? [];
  if (deviceTestAttempts.length && (!conversationDelivery || deviceTestAttempts.some(id => !workerId.test(id)))) {
    throw Error("设备检查恢复需要启用对话工单交付并提供有效的派发 ID。");
  }
  const recoverCheckedHeads = stringMapSetting("SOULFLOW_GITHUB_RECOVER_CHECKED_HEADS");
  if (Object.entries(recoverCheckedHeads).some(([issue, head]) => !conversationDelivery || !/^[1-9]\d*$/.test(issue) || !workerCommit.test(head))) {
    throw Error("交付恢复需要启用对话工单交付并提供有效的工单和提交。");
  }
  if (issuePlan) throw Error("静态 GitHub 计划缺少规划产物与校验记录，请改用对话工单交付。");
  if (conversationDelivery && !planPath) throw Error("对话选单需要配置项目开发计划。");
  if (conversationDelivery && (!claimEnabled || !image || !Object.keys(githubAccounts).length)) {
    throw Error("工单交付需要启用认领并绑定 GitHub 账号和已安装的检查镜像。");
  }
  const issueDelivery = conversationDelivery && image ? {
    specs: new Map(),
    image, ...(routine ? { model: routine } : {}), ...(advanced ? { planningModel: advanced } : {}),
    conversation: conversationDelivery,
    ...(recoverFailedIssue === undefined ? {} : { recoverFailedIssue }),
    ...(deviceTestAttempts.length ? { recoverDeviceTestAttempts: new Set(deviceTestAttempts) } : {}),
    recoverCheckedHeads,
    ...(reviewFix === undefined ? {} : { reviewFixes: readApprovedReviewFixes(reviewFix) }),
    ...(sourceRefresh === undefined ? {} : { sourceRefresh: readApprovedSourceRefresh(sourceRefresh) }),
    pollMs: integerSetting("SOULFLOW_GITHUB_POLL_MS", 20_000, 5000, 3_600_000),
    timeoutMs: runtimeInteger("SOULFLOW_GITHUB_DELIVERY_TIMEOUT_MS", 1000, 3_600_000),
  } : undefined;
  const deviceIds = process.env.SOULFLOW_CODE_DEVICE_IDS?.trim().split(",").map(id => id.trim()).filter(Boolean) ?? [];
  if (deviceIds.some(id => !workerId.test(id))) throw Error("代码设备配置必须使用已登记的设备 ID。");
  // 成员凭据只用于工作台登录，子进程沿用清理后的环境。
  delete process.env.SOULFLOW_MEMBER_IMPLEMENTER_KEY;
  delete process.env.SOULFLOW_MEMBER_REVIEWER_KEY;
  const server = createWorkbenchServer(undefined, live ? [process.cwd()] : undefined, auditPath, {
    limits, inputLimits, auditThresholds, dispatchConcurrency, ...(issueDelivery ? { issueDelivery } : {}),
    ...(codexAccounts ? { codexAccounts } : {}),
    ...(advanced ? { qualityModel: advanced } : {}),
    ...(remoteLan ? { remoteLan } : {}),
    ...(deviceIds.length ? { codeDevices: new Set(deviceIds) } : {}),
    ...(implementer !== undefined || reviewer !== undefined || extra ? { members: { implementer: implementer ?? "", reviewer: reviewer ?? "", additionalImplementers } } : {}),
    ...(claimEnabled && githubRepo ? {
      issueTracker: createGitHubIssues(process.cwd(), githubRepo, githubAccounts.implementer ?? githubAccounts.personal),
      memberTrackers: new Map(Object.entries(githubAccounts).map(([name, login]) => [name, createGitHubIssues(process.cwd(), githubRepo, login)])),
    } : {}),
    ...(hostName ? { hostName } : {}),
    ...(planPath || githubRepo ? { project: { ...(planPath ? { planPath } : {}), ...(githubRepo ? { githubRepo } : {}) } } : {}),
    ...(advanced && routine && advanced !== routine ? { dispatchAdapters: { routing: { advanced, routine } } } : {}),
  });
  server.listen(port, address, () => {
    const bound = server.address();
    if (bound && typeof bound !== "string") {
      process.stdout.write(`souflow 决策收件箱 http://${address}:${bound.port}（${live ? "Codex 会话" : "本地演示"}）\n`);
    }
  });
  process.once("SIGINT", () => server.close());
  process.once("SIGTERM", () => server.close());
}
