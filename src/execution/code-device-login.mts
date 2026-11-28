import { spawn, type ChildProcessByStdio } from "node:child_process";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { codexLoginEnvironment } from "./codex-account-status.mts";
import { workerProtocolVersion } from "./code-worker-protocol.mts";

function startProbe() {
  return spawn("codex", ["app-server"], { env: codexLoginEnvironment(), stdio: ["pipe", "pipe", "ignore"] });
}

export async function probeCodeDeviceLogin(signal: AbortSignal,
  start: () => ChildProcessByStdio<Writable, Readable, null> = startProbe): Promise<boolean> {
  if (signal.aborted) return false;
  return new Promise(resolve => {
    const server = start();
    const lines = createInterface({ input: server.stdout });
    let ready: boolean | undefined;
    function finish(result: boolean) {
      if (ready !== undefined) return;
      ready = result;
      lines.close();
      server.stdin.destroy();
      server.stdout.destroy();
      // 这是只读探测的临时进程。终结并等待回收后，才能发起下一次探测。
      server.kill("SIGKILL");
    }
    const abort = () => finish(false);
    const send = (message: object) => server.stdin.write(`${JSON.stringify(message)}\n`);
    server.once("error", abort);
    server.stdin.on("error", abort);
    server.stdout.on("error", abort);
    server.once("close", () => {
      signal.removeEventListener("abort", abort);
      lines.close();
      resolve(ready === true && !signal.aborted);
    });
    lines.on("line", line => {
      try {
        const reply = JSON.parse(line);
        if (reply?.id === 1) {
          if (reply.error || !reply.result) { finish(false); return; }
          send({ method: "initialized" });
          send({ id: 2, method: "account/read", params: { refreshToken: false } });
        } else if (reply?.id === 2) {
          finish(!reply.error && reply.result?.account?.type === "chatgpt");
        }
      } catch {
        finish(false);
      }
    });
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    else send({ id: 1, method: "initialize", params: { clientInfo: { name: "souflow-code-device", version: String(workerProtocolVersion) } } });
  });
}
