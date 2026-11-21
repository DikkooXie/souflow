import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultAuditThresholds, openActivityStore, readActivity } from "../audit/activity-store.mts";
import { defaultAnswerMaxLength, maxQuestionsPerDecision } from "../decisions/questions.mts";
import { codeReviewOptions, createLocalDispatch } from "../execution/local-dispatch.mts";
import { createConversationFlows, currentDevelopmentPlan, maxArtifactTextLength, phases, readPlanRevision } from "../planning/conversation-flow.mts";
import { createProjectContextReader, type ProjectSettings } from "../planning/project-context.mts";
import { createCodexInbox } from "./codex-inbox.mts";
import { createDecisionDemo, type DecisionCard } from "./demo-state.mts";
import { createAcceptance, maxAcceptanceNote, type AcceptanceAction } from "./acceptance.mts";
import { createMembers, type Member, type MemberKeys } from "./members.mts";

const address = "127.0.0.1";
const defaultLimits = { demo: 24, codex: 4 };
const defaultDispatchConcurrency = 2;
const defaultInputLimits = { promptMaxLength: 4000, answerMaxLength: defaultAnswerMaxLength };
const maxConfigurableInputLength = 16_000;
const jsonMetadataBudget = 16_384;
const files = [
  ["/", "index.html", "text/html"],
  ["/style.css", "style.css", "text/css"],
  ["/app.mjs", "app.mjs", "text/javascript"],
  ["/archive.mjs", "archive.mjs", "text/javascript"],
  ["/dispatch.mjs", "dispatch.mjs", "text/javascript"],
  ["/audit.mjs", "audit.mjs", "text/javascript"],
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
  dispatchAdapters?: Omit<NonNullable<Parameters<typeof createLocalDispatch>[2]>, "record">;
  project?: ProjectSettings;
  members?: MemberKeys;
};

export function createWorkbenchServer(receiptDelay?: number, live?: LiveOptions, auditPath?: string, {
  limits = defaultLimits, inputLimits = defaultInputLimits, auditThresholds = defaultAuditThresholds,
  dispatchConcurrency = defaultDispatchConcurrency, dispatchAdapters, project, members,
}: WorkbenchOptions = {}) {
  const memberFor = members && createMembers(members);
  if (memberFor && !live) throw Error("两位成员模式需要 Codex 工作台。");
  const loadProject = live && project ? createProjectContextReader(live[0], project) : undefined;
  const audit = openActivityStore(auditPath, Date.now, auditThresholds);
  const { promptMaxLength, answerMaxLength } = inputLimits;
  // JSON 可能将每个 UTF-16 码元转义为六个字节，给包裹字段另留空间。
  const promptBodyBytes = jsonMetadataBudget + 6 * promptMaxLength;
  const answerBodyBytes = jsonMetadataBudget + 6 * answerMaxLength * maxQuestionsPerDecision;
  const demo = createDecisionDemo(receiptDelay, audit.record, answerMaxLength);
  const codex = live ? createCodexInbox(live[0], {
    limit: limits.codex, answerMaxLength, startAttempt: live[1], record: audit.record,
  }) : undefined;
  const inbox = codex ?? demo;
  const flows = createConversationFlows(inbox.runPhase, codex ? limits.codex : limits.demo, audit.record, loadProject);
  const dispatch = live ? createLocalDispatch(live[0], dispatchConcurrency, { ...dispatchAdapters, record: audit.record }) : undefined;
  const acceptance = memberFor && createAcceptance(audit.record);
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
    return {
      ...state, requests: [...state.requests, ...reviewCards], flows: conversations, phases: phases.map(phase => phase.title), inputLimits,
      member,
      acceptanceNoteMaxLength: maxAcceptanceNote,
      planMaxLength: maxArtifactTextLength, dispatches: dispatch?.list().map(run =>
        acceptance ? { ...run, acceptance: acceptance.history(run.id) } : run) ?? [],
    };
  };
  const assets = new Map<string, { content: Buffer; mime: string }>(files.map(([path, name, mime]) => [
    path, { content: readFileSync(new URL(`./public/${name}`, import.meta.url)), mime },
  ]));
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
    function allowed(role: "implementer" | "reviewer", action: string, subject?: string) {
      if (!member || member.id === role) return true;
      audit.record({ kind: "member.denied", ...(subject ? { subject } : {}), details: { actor: member.id, action } });
      send(403, { error: "当前成员无权执行此操作。" });
      return false;
    }
    if (request.method === "GET") {
      if (path === "/api/decisions") return send(200, state());
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
          const flow = !codex || codex.canBegin() ? flows.begin(prompt.trim()) : undefined;
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
      const revisionFlow = /^\/api\/workflows\/([a-f0-9-]+)\/plan\/revise$/.exec(path)?.[1];
      if (revisionFlow) {
        if (!allowed("implementer", "plan.revise", revisionFlow)) return;
        const flow = flows.list().find(item => item.id === revisionFlow);
        if (!flow) return send(404, { error: "需求对话不存在。" });
        const body = await readJson(request, jsonMetadataBudget + 6 * maxArtifactTextLength);
        if ("status" in body) return send(body.status, { error: body.error });
        const revision = readPlanRevision(body.value);
        if (!revision) return send(422, { error: `请填写有效计划版本和 1 到 ${maxArtifactTextLength} 字的计划内容。` });
        const decision = acceptance?.decision(flow, dispatch?.list() ?? []);
        const status = dispatch?.isRunning(flow.id) || decision === "submitted" || decision === "accepted"
          ? 409 : flows.revisePlan(flow, revision);
        if (status === 200 && member) audit.record({ kind: "member.revised", flowId: flow.id,
          details: { actor: member.id, plan: currentDevelopmentPlan(flow)?.version } });
        return status === 200 ? send(200, state()) : send(status, {
          ...state(),
          error: status === 409 ? "计划版本已变更，或当前批次仍在执行、待验收或已通过。" : "计划内容没有变化。",
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
          return dispatch.prepare(flow, kind) === 200 ? send(200, state()) : send(409, { error: "请等待其他本地任务结束，再准备已完成计划的工单。" });
        }
        const id = (body.value as { id?: unknown } | null)?.id;
        return dispatch.start(flow, id) === 200 ? send(200, state()) : send(409, { error: "工单尚未就绪，或确认的计划已失效。" });
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
        let status: ReturnType<typeof demo.submit>;
        if (action[2] === "disconnect") {
          if (codex) return send(404, { error: "该操作用于本地演示。" });
          status = demo.disconnect(action[1]);
        } else {
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
        const errors: Record<404 | 409 | 422, string> = {
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
  server.on("close", () => {
    const attempts = inbox.close();
    // 结束尝试时仍会产生最终状态，先让编排写完这些事件再关闭存储。
    void Promise.allSettled([attempts, flows.settled(), dispatch?.close()]).then(audit.close);
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

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.loadEnvFile();
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") {
      throw new Error("无法读取本地 .env。");
    }
  }
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
  const planPath = process.env.SOULFLOW_PROJECT_PLAN?.trim();
  const githubRepo = process.env.SOULFLOW_PROJECT_GITHUB_REPO?.trim();
  const advanced = process.env.SOULFLOW_CODEX_PLANNING_MODEL?.trim();
  const routine = process.env.SOULFLOW_CODEX_EXECUTION_MODEL?.trim();
  const implementer = process.env.SOULFLOW_MEMBER_IMPLEMENTER_KEY;
  const reviewer = process.env.SOULFLOW_MEMBER_REVIEWER_KEY;
  // 成员凭据只用于工作台登录，子进程沿用清理后的环境。
  delete process.env.SOULFLOW_MEMBER_IMPLEMENTER_KEY;
  delete process.env.SOULFLOW_MEMBER_REVIEWER_KEY;
  const server = createWorkbenchServer(undefined, live ? [process.cwd()] : undefined, auditPath, {
    limits, inputLimits, auditThresholds, dispatchConcurrency,
    ...(implementer !== undefined || reviewer !== undefined ? { members: { implementer: implementer ?? "", reviewer: reviewer ?? "" } } : {}),
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
