import { spawn } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { createInterface } from "node:readline";

const identitySalt = randomBytes(32);
const localEnvironment = new Set(["HOME", "PATH", "CODEX_HOME", "TMPDIR", "LANG", "LC_ALL", "XDG_CONFIG_HOME",
  "XDG_DATA_HOME", "XDG_RUNTIME_DIR", "USERPROFILE", "SystemRoot"]);
const planTypes = new Set(["free", "go", "plus", "pro", "prolite", "promax", "team", "business",
  "self_serve_business_prolite", "self_serve_business_usage_based", "ent26", "enterprise_cbp_automation",
  "enterprise_cbp_usage_based", "enterprise", "edu", "edu_plus", "edu_pro", "sci", "sci_plus"]);

export type CodexIdentity = { ref: string; plan?: string };
export type CodexAccountStatus = CodexIdentity & { remaining?: number; limited?: boolean };

function object(value: unknown) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

export function codexLoginEnvironment(directory?: string): NodeJS.ProcessEnv {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => localEnvironment.has(key)));
  // 凭据由独立 App Server 登录目录管理，工作台只传递该目录。
  return directory ? { ...env, CODEX_HOME: directory } : env;
}

export function codexIdentity(accountResult: unknown): CodexIdentity | undefined {
  const result = object(accountResult);
  const account = object(result?.account);
  const id = result?.userId;
  if (account?.type !== "chatgpt" || typeof id !== "string" || !id.trim()) return;
  const plan = typeof account.planType === "string" && planTypes.has(account.planType) ? account.planType : undefined;
  return { ref: createHmac("sha256", identitySalt).update(id).digest("hex").slice(0, 24), ...(plan ? { plan } : {}) };
}

export function codexAllowance(rateResult: unknown) {
  const result = object(rateResult);
  const bucket = object(object(result?.rateLimitsByLimitId)?.codex) ?? object(result?.rateLimits);
  const codex = bucket && (bucket.limitId == null || bucket.limitId === "codex") ? bucket : undefined;
  // 后端明确禁止普通用量时，即使窗口还有余量也不能继续派单。
  const windows = [object(codex?.primary)?.usedPercent, object(codex?.secondary)?.usedPercent]
    .filter((used): used is number => typeof used === "number" && Number.isFinite(used) && used >= 0);
  const remaining = windows.length ? Math.max(0, 100 - Math.max(...windows)) : undefined;
  const blocked = result?.ordinaryUsageAllowed === false || codex?.spendControlReached === true
    || typeof codex?.rateLimitReachedType === "string" || remaining === 0;
  const limited = blocked ? true : result?.ordinaryUsageAllowed === true ? false : undefined;
  return { ...(remaining === undefined ? {} : { remaining }), ...(limited === undefined ? {} : { limited }) };
}

export async function probeCodexAccount(directory: string, workspace: string, timeoutMs: number): Promise<CodexAccountStatus | undefined> {
  const child = spawn("codex", ["--disable", "apps", "--disable", "plugins", "--disable", "hooks", "app-server", "--listen", "stdio://"],
    { cwd: workspace, env: codexLoginEnvironment(directory), stdio: ["pipe", "pipe", "ignore"] });
  const lines = createInterface({ input: child.stdout });
  let identity: CodexIdentity | undefined;
  let allowance: ReturnType<typeof codexAllowance> | undefined;
  const send = (message: object) => child.stdin.write(`${JSON.stringify(message)}\n`);
  const read = (id: number) => send({ id, method: "account/read", params: { refreshToken: false } });
  try {
    return await new Promise<CodexAccountStatus | undefined>(resolve => {
      const timer = setTimeout(() => finish(allowance ? undefined : identity), timeoutMs);
      function finish(result?: CodexAccountStatus) { clearTimeout(timer); resolve(result); }
      child.once("error", () => finish());
      child.stdin.once("error", () => finish());
      lines.once("close", () => finish());
      lines.on("line", line => {
        let message: Record<string, unknown> | undefined;
        try { message = object(JSON.parse(line)); } catch { finish(); return; }
        if (!message || typeof message.method === "string") return;
        switch (message.id) {
          case 1:
            if (message.error) return finish();
            send({ method: "initialized" });
            read(2);
            break;
          case 2:
            identity = codexIdentity(message.result);
            if (!identity) return finish();
            send({ id: 3, method: "account/rateLimits/read", params: { excludeResetCreditDetails: true } });
            break;
          case 3:
            allowance = codexAllowance(message.result);
            read(4);
            break;
          case 4: {
            const confirmed = codexIdentity(message.result);
            finish(confirmed && identity && confirmed.ref === identity.ref ? { ...confirmed, ...allowance } : undefined);
            break;
          }
        }
      });
      send({ id: 1, method: "initialize", params: { clientInfo: { name: "soulflow-account-status", version: "0.1.0" } } });
    });
  } finally {
    child.stdin.destroy();
    lines.close();
    child.kill();
  }
}
