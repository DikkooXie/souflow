import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openActivityStore, readActivity } from "../audit/activity-store.mts";
import { createConversationFlows, phases } from "../planning/conversation-flow.mts";
import { createCodexInbox } from "./codex-inbox.mts";
import { createDecisionDemo } from "./demo-state.mts";

const address = "127.0.0.1";
const defaultLimits = { demo: 24, codex: 4 };
const files = [
  ["/", "index.html", "text/html"],
  ["/style.css", "style.css", "text/css"],
  ["/app.mjs", "app.mjs", "text/javascript"],
  ["/audit.mjs", "audit.mjs", "text/javascript"],
] as const;

async function readJson(request: IncomingMessage): Promise<{ value: unknown } | { status: number; error: string }> {
  if (request.headers["content-type"] !== "application/json") return { status: 415, error: "请提交 JSON。" };
  try {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      size += chunk.length;
      if (size <= 16_384) chunks.push(chunk);
    }
    if (size > 16_384) return { status: 413, error: "内容太长。" };
    return { value: JSON.parse(Buffer.concat(chunks).toString("utf8")) };
  } catch {
    return { status: 400, error: "无法读取请求内容。" };
  }
}

type LiveOptions = [workspace: string, startAttempt?: Parameters<typeof createCodexInbox>[2]];

export function createWorkbenchServer(receiptDelay?: number, live?: LiveOptions, auditPath?: string, limits = defaultLimits) {
  const audit = openActivityStore(auditPath);
  const demo = createDecisionDemo(receiptDelay, audit.record);
  const codex = live ? createCodexInbox(live[0], limits.codex, live[1], audit.record) : undefined;
  const inbox = codex ?? demo;
  const flows = createConversationFlows(inbox.runPhase, codex ? limits.codex : limits.demo, audit.record);
  const snapshot = () => ({ ...inbox.snapshot(), flows: flows.list(), phases: phases.map(phase => phase.title) });
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
    if (request.method === "GET") {
      if (path === "/api/decisions") return send(200, snapshot());
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
        const body = await readJson(request);
        if ("status" in body) return send(body.status, { error: body.error });
        const prompt = (body.value as { prompt?: unknown } | null)?.prompt;
        if (typeof prompt !== "string" || !prompt.trim() || prompt.length > 4000) {
          return send(422, { error: "请填写不超过 4,000 字的需求。" });
        }
        if (path === "/api/workflows") {
          const flow = !codex || codex.canBegin() ? flows.begin(prompt.trim()) : undefined;
          return flow ? send(200, { ...snapshot(), flowId: flow.id }) : send(409, {
            ...snapshot(), error: "进行中的需求已达上限，请先处理待决策事项。",
          });
        }
        const status = codex?.begin(prompt.trim()) ?? 404;
        return send(status, status === 200 ? snapshot() : {
          ...snapshot(),
          error: status === 409 ? `已有 ${limits.codex} 条会话进行中。` : "无法启动 Codex 会话。",
        });
      }
      if (!codex && path === "/api/demo/reset") {
        audit.record({ kind: "demo.reset", details: { flowIds: flows.list().filter(flow => flow.status === "running").map(flow => flow.id) } });
        demo.reset();
        flows.reset();
        return send(200, snapshot());
      }
      const action = /^\/api\/decisions\/([a-f0-9-]+)\/(answer|disconnect)$/.exec(path);
      if (action?.[1]) {
        let status: ReturnType<typeof demo.submit>;
        if (action[2] === "disconnect") {
          if (codex) return send(404, { error: "该操作用于本地演示。" });
          status = demo.disconnect(action[1]);
        } else {
          const body = await readJson(request);
          if ("status" in body) return send(body.status, { error: body.error });
          status = inbox.submit(action[1], body.value);
        }
        const errors: Record<404 | 409 | 422, string> = {
          404: "这条提问已失效或已被移除。",
          409: "这条提问已有答复或已失效。",
          422: "请为当前会话的每个问题填写有效回答。",
        };
        return send(status, status === 200 ? snapshot() : {
          ...snapshot(),
          error: errors[status],
        });
      }
    }
    send(404, { error: "地址不存在。" });
  });
  server.on("close", () => {
    const attempts = inbox.close();
    // 结束尝试时仍会产生最终状态，先让编排写完这些事件再关闭存储。
    void Promise.allSettled([attempts, flows.settled()]).then(audit.close);
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
  const server = createWorkbenchServer(undefined, live ? [process.cwd()] : undefined, auditPath, limits);
  server.listen(port, address, () => {
    const bound = server.address();
    if (bound && typeof bound !== "string") {
      process.stdout.write(`Soulflow 决策收件箱 http://${address}:${bound.port}（${live ? "Codex 会话" : "本地演示"}）\n`);
    }
  });
  process.once("SIGINT", () => server.close());
  process.once("SIGTERM", () => server.close());
}
