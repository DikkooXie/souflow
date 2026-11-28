import type { IncomingMessage, ServerResponse } from "node:http";
import type { CodeWorkerPool } from "../execution/code-worker-pool.mts";
import { readCodeReceipt, readWorkerCapacity, workerId } from "../execution/code-worker-protocol.mts";
import type { RemoteHandoff } from "../execution/remote-handoff.mts";

export async function handleCodeWorkerRequest(request: IncomingMessage, response: ServerResponse,
  pool: CodeWorkerPool, handoff: RemoteHandoff) {
  const route = /^\/v1\/code-workers\/([a-f0-9-]{36})\/(check|wait|receipt)$/.exec(request.url ?? "");
  if (!route?.[1] || !workerId.test(route[1])) return false;
  const id = route[1];
  function send(status: number, body: object = {}) {
    if (response.destroyed) return;
    response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    response.end(JSON.stringify(body));
  }
  const check = route[2] === "check";
  if (request.headers.origin || (check ? request.method !== "GET"
    : request.method !== "POST" || request.headers["content-type"] !== "application/json")) {
    send(415);
  } else if (!pool.permits(id)) {
    send(403);
  } else if (!handoff.canAuthenticateCodeDevice(id, request.headers.authorization)) {
    send(401);
  } else if (check) {
    // 自检只验证接入许可和凭据。实例首次绑定留给正常启动的设备。
    send(200);
  } else {
    try {
      let size = 0;
      const chunks: Buffer[] = [];
      const limit = route[2] === "wait" ? pool.config.waitBodyBytes : pool.config.messageBytes;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > limit) { send(413); return true; }
        chunks.push(chunk);
      }
      let input: unknown;
      try { input = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
      catch { send(422); return true; }
      const body = input && typeof input === "object" ? input as Record<string, unknown> : {};
      const instance = body.instance;
      if (typeof instance !== "string" || !workerId.test(instance)) { send(422); return true; }
      const identity = handoff.identifyCodeDevice(id, request.headers.authorization, instance);
      if (identity.status !== 200) { send(identity.status); return true; }
      if (route[2] === "wait") {
        const capacity = readWorkerCapacity(body, pool.config.maxSlots);
        if (!capacity) { send(422); return true; }
        if (response.destroyed) return true;
        const connection = new AbortController();
        response.once("close", () => connection.abort());
        const local = request.socket.remoteAddress === request.socket.localAddress;
        const result = await pool.poll({ id, name: identity.name, ...capacity, local }, connection.signal);
        send(result.status, result.status === 200 ? { offer: result.offer } : {});
      } else {
        const receipt = readCodeReceipt(body.receipt);
        send(receipt ? pool.receipt({ id, instance }, receipt) : 422);
      }
    } catch {
      if (!response.headersSent) send(503);
    }
  }
  return true;
}
