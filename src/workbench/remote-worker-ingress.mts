import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:https";
import { promisify } from "node:util";
import { scrubAuditText } from "../audit/activity-store.mts";
import { remoteMaxFileBytes, remoteMaxFiles, remotePath, type RemoteHandoff } from "../execution/remote-handoff.mts";

export type RemoteLanConfig = { host: string; port: number; cert: string; key: string; offlineMs: number };
const exec = promisify(execFile);

export function createRemoteWorkerIngress(handoff: RemoteHandoff, config: RemoteLanConfig) {
  const server = createServer({ cert: config.cert, key: config.key, requestTimeout: 10_000, headersTimeout: 5_000 }, async (request, response) => {
    const send = (status: number, body: object) => {
      response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      response.end(JSON.stringify(body));
    };
    const match = /^\/v1\/devices\/([a-f0-9-]{36})\/poll$/.exec(request.url ?? "");
    if (request.method !== "POST" || !match?.[1]) return send(404, { error: "设备接口不存在。" });
    if (request.headers["content-type"] !== "application/json" || request.headers.origin) return send(415, { error: "需要设备客户端。" });
    try {
      let size = 0;
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 4096) return send(413, { error: "设备回执过大。" });
        chunks.push(chunk);
      }
      let payload: unknown;
      try { payload = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
      catch { return send(422, { error: "设备回执无效。" }); }
      const result = handoff.poll(match[1], request.headers.authorization, payload);
      return send(result.status, result.status === 200 ? { task: result.task } : { error: "设备接入或工单回执未通过核对。" });
    } catch {
      if (!response.headersSent) send(503, { error: "设备服务暂不可用。" });
    }
  });
  server.on("error", () => process.stderr.write("souflow 无法启动局域网设备接口。\n"));
  return {
    start: () => server.listen(config.port, config.host),
    close() { server.close(); server.closeAllConnections(); },
    endpoint() {
      const address = server.address();
      return address && typeof address === "object" ? `https://${config.host}:${address.port}` : undefined;
    },
  };
}

export async function readRemoteFiles(workspace: string, paths: unknown) {
  if (!Array.isArray(paths) || paths.length < 1 || paths.length > remoteMaxFiles || new Set(paths).size !== paths.length
    || !paths.every(path => typeof path === "string" && remotePath.test(path))) throw Error("请选择允许的 Markdown 文件。");
  const git = (args: string[]) => exec("git", ["-C", workspace, ...args],
    { timeout: 5000, maxBuffer: remoteMaxFileBytes, env: { ...process.env, GIT_NO_REPLACE_OBJECTS: "1" } });
  const revision = (await git(["rev-parse", "--verify", "HEAD"])).stdout.trim();
  const files = await Promise.all((paths as string[]).map(async path => {
    // Git 模式必须是普通文件，设备不会收到可执行工作树、凭据或符号链接。
    const row = (await git(["ls-tree", "-l", revision, "--", path])).stdout.trim();
    const match = /^100644 blob ([0-9a-f]+) +(\d+)\t(.+)$/.exec(row);
    if (!match?.[1] || match[3] !== path || Number(match[2]) > remoteMaxFileBytes) throw Error("远端核验只接收已提交的普通 Markdown 文件。");
    const text = scrubAuditText((await git(["cat-file", "blob", match[1]])).stdout);
    const bytes = Buffer.byteLength(text);
    if (bytes > remoteMaxFileBytes) throw Error("远端核验文件过大。");
    return { path, text, bytes, sha256: createHash("sha256").update(text).digest("hex") };
  }));
  return { revision, files };
}
