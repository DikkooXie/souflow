import { randomUUID } from "node:crypto";
import { scrubAuditText } from "../audit/activity-store.mts";

type Target = {
  title: string;
  task: string;
  flowId?: string | undefined;
  batchId?: string;
  ticketId?: string;
  planVersion?: number;
};
type Outcome = "completed" | "failed" | "interrupted" | "needs-reconciliation";
type Session = Target & {
  id: string;
  status: "connecting" | "running" | "waiting" | Outcome;
  startedAt: number;
  connectedAt?: number;
  threadId?: string;
  model?: string;
  finishedAt?: number;
};
const recentLimit = 24;

export function createDispatchMonitor(host: string, now = Date.now) {
  const active = new Map<string, Session>();
  const recent: Session[] = [];
  return {
    begin(target: Target) {
      const session: Session = { ...target, title: scrubAuditText(target.title), task: scrubAuditText(target.task),
        id: randomUUID(), status: "connecting", startedAt: now() };
      active.set(session.id, session);
      return {
        connected(threadId: string) {
          if (!active.has(session.id)) return;
          session.threadId = threadId;
          session.connectedAt = now();
          session.status = "running";
        },
        model(model: string) {
          if (active.has(session.id)) session.model = model;
        },
        waiting(waiting: boolean) {
          if (active.has(session.id) && session.threadId) session.status = waiting ? "waiting" : "running";
        },
        finish(outcome: Outcome) {
          if (!active.delete(session.id)) return;
          session.status = outcome;
          session.finishedAt = now();
          recent.unshift(session);
          if (recent.length > recentLimit) recent.pop();
        },
      };
    },
    snapshot: () => ({
      hosts: [{ name: host, kind: "local", active: [...active.values()], recent: [...recent] }],
      observedAt: now(),
    }),
  };
}

export type DispatchMonitor = ReturnType<typeof createDispatchMonitor>;
