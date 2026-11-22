import { randomUUID } from "node:crypto";
import { scrubAuditText } from "../audit/activity-store.mts";
import type { AccountAssignment } from "./codex-account-dispatch.mts";

type Target = {
  title: string;
  task: string;
  flowId?: string | undefined;
  batchId?: string;
  ticketId?: string;
  planVersion?: number;
  accountAssignment?: AccountAssignment;
};
type Outcome = "completed" | "failed" | "interrupted" | "needs-reconciliation";
type Session = Target & {
  id: string;
  status: "connecting" | "running" | "waiting" | Outcome;
  startedAt: number;
  connectedAt?: number;
  threadId?: string;
  model?: string;
  accountRef?: string;
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
        account(accountRef: string) {
          if (active.has(session.id)) session.accountRef = accountRef;
        },
        assignAccount(assignment: AccountAssignment) {
          if (active.has(session.id)) session.accountAssignment = assignment;
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
      hosts: [{
        name: host,
        kind: "local",
        active: Array.from(active.values(), copySession),
        recent: recent.map(copySession),
      }],
      observedAt: now(),
    }),
  };
}

function copySession(session: Session): Session {
  return { ...session, ...(session.accountAssignment ? { accountAssignment: { ...session.accountAssignment } } : {}) };
}

export type DispatchMonitor = ReturnType<typeof createDispatchMonitor>;
