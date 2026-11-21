import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { scrubAuditText, type BusinessEvent } from "../audit/activity-store.mts";
import type { createLocalDispatch } from "../execution/local-dispatch.mts";
import { readLocalCodePatch } from "../execution/local-code-changes.mts";
import { currentDevelopmentPlan, type Flow } from "../planning/conversation-flow.mts";
import type { Member } from "./members.mts";

type Run = ReturnType<ReturnType<typeof createLocalDispatch>["list"]>[number];
type Decision = "submitted" | "returned" | "accepted";
type Receipt = { decision: Decision; actor: Member; at: string; note: string };
const actions = { submit: "submitted", return: "returned", accept: "accepted" } as const;
export type AcceptanceAction = keyof typeof actions;
export const maxAcceptanceNote = 1000;

async function verifyReport(path: string, text: string) {
  const expected = Buffer.from(`${text}\n`);
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!(await file.stat()).isFile()) throw Error();
    const buffer = Buffer.alloc(expected.length + 1);
    const { bytesRead } = await file.read(buffer);
    if (!buffer.subarray(0, bytesRead).equals(expected)) throw Error();
  } finally {
    await file.close();
  }
}

export function createAcceptance(record: (event: BusinessEvent) => boolean) {
  const receipts = new Map<string, Receipt[]>();
  const current = (run: Run) => receipts.get(run.id)?.at(-1)?.decision;
  return {
    history: (id: string) => receipts.get(id) ?? [],
    decision: (flow: Flow, runs: Run[]) => {
      const plan = currentDevelopmentPlan(flow);
      const run = runs.find(item => item.flowId === flow.id && item.plan.id === plan?.id
        && item.plan.version === plan.version && current(item));
      return run && current(run);
    },
    async decide(action: AcceptanceAction, run: Run, actor: Member, body: unknown, stillCurrent: () => boolean) {
      const note = (body as { note?: unknown } | null)?.note;
      if (typeof note !== "string" || note.length > maxAcceptanceNote || !note.trim()) return 422;
      const expected = action === "submit" ? undefined : "submitted";
      const valid = () => run.status === "finished" && current(run) === expected && stillCurrent();
      if (!valid()) return 409;
      if (action !== "return") {
        try {
          await Promise.all(run.jobs.map(async job => {
            if (job.status !== "ready" || !job.reportPath || typeof job.report !== "string") throw Error();
            await verifyReport(job.reportPath, job.report);
            if (run.kind === "code") {
              if (!job.patchPath || !job.artifact) throw Error();
              await readLocalCodePatch(job.patchPath, job.artifact.patchSha256);
            }
          }));
        } catch {
          return 409;
        }
      }
      // 两个请求可能同时核对文件，写入前再次检查当前批次和状态。
      if (!valid()) return 409;
      const receipt = { decision: actions[action], actor, at: new Date().toISOString(), note: scrubAuditText(note.trim()) };
      if (!record({ kind: "acceptance.decided", flowId: run.flowId, subject: run.id, details: {
        ...receipt, plan: run.plan, revision: run.revision,
        artifacts: run.jobs.map(job => ({ ticketId: job.id, artifactId: job.artifact?.id, patchSha256: job.artifact?.patchSha256 })),
      } })) return 503;
      receipts.set(run.id, [...(receipts.get(run.id) ?? []), receipt]);
      return 200;
    },
  };
}
