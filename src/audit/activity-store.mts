import { closeSync, constants, fchmodSync, fstatSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

const views = ["home", "conversation", "decisions", "audit", "archive", "dispatch-monitor", "github-issues"] as const;
const controls = [
  "open-home", "open-audit", "select-flow", "open-decisions", "open-card", "more-decisions", "close-decisions",
  "select-decision", "send-request", "send-answer", "select-option", "simulation-disconnect", "reset-demo",
  "open-artifact", "open-history", "change-audit-range", "change-log-type", "refresh-audit", "toggle-audit-log",
  "toggle-conversations", "new-conversation", "open-archive", "close-archive",
  "open-local-dispatch", "prepare-local-dispatch", "start-local-dispatch", "edit-plan", "open-monitor", "resume-workflow",
  "open-github", "close-github", "claim-github", "refresh-github",
] as const;

export type BusinessEvent = {
  kind: "request.submitted" | "phase.started" | "phase.completed" | "flow.finished" | "decision.opened"
    | "decision.answered" | "decision.updated" | "demo.reset" | "attempt.started" | "attempt.finished" | "model.started"
    | "dispatch.prepared" | "dispatch.started" | "dispatch.reviewed" | "dispatch.finished" | "plan.revised"
    | "github.issue" | "github.selection" | "member.denied" | "member.revised" | "acceptance.decided" | "flow.resumed";
  flowId?: string | undefined;
  attemptId?: string | undefined;
  subject?: string;
  details?: object;
};
export type Checkpoint<T extends object> = {
  load(): T[];
  save(id: string, item: T, event?: BusinessEvent): boolean;
};
export type RecordBusiness = (event: BusinessEvent) => void;
export const defaultAuditThresholds = {
  repeatClickMs: 2000,
  quickReturnMs: 30_000,
  insightMinCount: 3,
};

type Activity = {
  id: string;
  session: string;
  elapsed: number;
  view: (typeof views)[number];
} & ({ kind: "ui.click"; control: (typeof controls)[number]; subject?: string }
  | { kind: "ui.navigate"; destination: (typeof views)[number] });

function oneOf<const T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === "string" && allowed.some(item => item === value);
}

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const isId = (value: unknown): value is string => typeof value === "string" && uuid.test(value);
const artifactKinds = ["request", "research", "requirements", "technology", "prd", "development-plan", "ticket-drafts"];
const credentialLabel = /(?:password|passphrase|api[_\s-]?key|private[_\s-]?key|secret|credentials?|authorization|(?:access|refresh|api|github|auth|bearer)[_\s-]?token|密码|口令|密钥|私钥|令牌|验证码)/i;
const credentialField = (value: string) => /^(?:token|pin)$/i.test(value) || credentialLabel.test(value);
const credentialAssignment = new RegExp(
  String.raw`((?<![\w-])(?:[\w-]*(?:${credentialLabel.source}|token)|pin)["']?\s*[:=：]\s*)`
    + String.raw`(?:(?:Bearer|Basic)[ \t]+)?(?:"(?:[^"\\\r\n]|\\.)*"|'(?:[^'\\\r\n]|\\.)*'|[^\s,;，；]+)`,
  "gi",
);

export function readActivity(input: unknown): Activity | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return;
  const event = input as Record<string, unknown>;
  if (!isId(event.id) || !isId(event.session) || !oneOf(event.view, views)) return;
  const { id, session, view, elapsed } = event;
  if (typeof elapsed !== "number" || !Number.isSafeInteger(elapsed) || elapsed < 0) return;
  if (event.kind === "ui.click" && oneOf(event.control, controls)) {
    const subject = event.subject;
    if (subject !== undefined && typeof subject !== "string") return;
    if (subject !== undefined && !uuid.test(subject)) {
      const parts = subject.split("/");
      if (parts.length !== 2 || !isId(parts[0]) || !oneOf(parts[1], artifactKinds)) return;
    }
    return { id, session, view, elapsed, kind: event.kind, control: event.control, ...(subject ? { subject } : {}) };
  }
  if (event.kind === "ui.navigate" && oneOf(event.destination, views) && view !== event.destination) {
    return { id, session, view, elapsed, kind: event.kind, destination: event.destination };
  }
}

export function scrubAuditText(text: string) {
  return text
    .replace(/-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-\r\n]*PRIVATE KEY-----|$)/g, "[已隐藏私钥]")
    .replace(credentialAssignment, "$1[已隐藏凭据]")
    .replace(/\b(?:sk-[\w-]{16,}|gh[pousr]_[\w-]{16,}|github_pat_[\w-]{16,})\b/g, "[已隐藏凭据]")
    .replace(/\b(Bearer\s+)[\w.+/=~-]{8,}/gi, "$1[已隐藏凭据]");
}

export function auditDecisionAnswers(
  questions: readonly { id: string; title: string; prompt: string }[], answers: Record<string, string>,
) {
  return Object.fromEntries(questions.map(question => [
    question.id, credentialField(question.id) || credentialLabel.test(`${question.title} ${question.prompt}`) ? "[已隐藏凭据]" : answers[question.id],
  ]));
}

function countDispatchJobs(details: unknown) {
  if (!details || typeof details !== "object" || !("jobs" in details) || !Array.isArray(details.jobs)) return;
  const counts = { ready: 0, failed: 0, blocked: 0 };
  for (const job of details.jobs as unknown[]) {
    if (!job || typeof job !== "object" || !("status" in job)) continue;
    const { status } = job;
    if (status === "ready" || status === "failed" || status === "blocked") counts[status] += 1;
  }
  return counts;
}

export function secureDatabaseFile(path: string) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const fd = openSync(path, constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1) throw new Error("数据库路径必须指向没有硬链接的普通文件。");
    fchmodSync(fd, 0o600);
  } finally {
    closeSync(fd);
  }
}

export function openActivityStore(path = ":memory:", now = Date.now, thresholds = defaultAuditThresholds) {
  if (path !== ":memory:") secureDatabaseFile(path);
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA busy_timeout = 1000;
    CREATE TABLE IF NOT EXISTS activity_events (
      seq INTEGER PRIMARY KEY,
      schema_version INTEGER NOT NULL DEFAULT 1,
      recorded_at INTEGER NOT NULL,
      kind TEXT NOT NULL,
      flow_id TEXT,
      attempt_id TEXT,
      subject TEXT,
      details TEXT,
      event_id TEXT UNIQUE,
      browser_session TEXT,
      elapsed INTEGER,
      view TEXT,
      destination TEXT,
      control TEXT
    ) STRICT;
    CREATE TABLE IF NOT EXISTS workbench_checkpoints (
      area TEXT NOT NULL,
      id TEXT NOT NULL,
      version INTEGER NOT NULL,
      payload TEXT NOT NULL CHECK(json_valid(payload)),
      PRIMARY KEY (area, id)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS activity_kind_time ON activity_events(kind, recorded_at);
    CREATE INDEX IF NOT EXISTS activity_time ON activity_events(recorded_at);
  `);
  const insertBusiness = db.prepare("INSERT INTO activity_events(recorded_at, kind, flow_id, attempt_id, subject, details) VALUES (?, ?, ?, ?, ?, ?)");
  const insertActivity = db.prepare(`
    INSERT INTO activity_events(recorded_at, kind, event_id, browser_session, elapsed, view, destination, control, subject)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(event_id) DO NOTHING
  `);
  const totals = db.prepare(`SELECT kind, count(*) AS total FROM activity_events WHERE recorded_at >= ? GROUP BY kind`);
  const clicks = db.prepare(`
    WITH actions AS (
      SELECT kind, view, control, subject, elapsed - lag(elapsed) OVER per_tab AS gap,
        lag(kind) OVER per_tab AS prev_kind, lag(view) OVER per_tab AS prev_view,
        lag(control) OVER per_tab AS prev_control, lag(subject) OVER per_tab AS prev_subject
      FROM activity_events WHERE browser_session IS NOT NULL AND recorded_at >= ?
      WINDOW per_tab AS (PARTITION BY browser_session ORDER BY seq)
    )
    SELECT control, count(*) AS count, sum(CASE WHEN gap BETWEEN 0 AND ? AND prev_kind = 'ui.click'
      AND prev_view = view AND prev_control = control AND prev_subject IS subject THEN 1 ELSE 0 END) AS repeated
    FROM actions WHERE kind = 'ui.click' GROUP BY control ORDER BY count DESC, control LIMIT 12
  `);
  const transitions = db.prepare(`
    WITH moves AS (
      SELECT view, destination, elapsed - lag(elapsed) OVER per_tab AS gap,
        lag(view) OVER per_tab AS prev_view, lag(destination) OVER per_tab AS prev_destination
      FROM activity_events WHERE kind = 'ui.navigate' AND recorded_at >= ?
      WINDOW per_tab AS (PARTITION BY browser_session ORDER BY seq)
    )
    SELECT min(view, destination) AS first, max(view, destination) AS second, count(*) AS count,
      sum(CASE WHEN gap BETWEEN 0 AND ? AND prev_view = destination AND prev_destination = view THEN 1 ELSE 0 END) AS reversals
    FROM moves GROUP BY first, second ORDER BY reversals DESC, count DESC, first, second LIMIT 12
  `);
  const recent = db.prepare(`
    SELECT seq AS id, schema_version AS version, recorded_at AS at, kind, flow_id AS flowId, attempt_id AS attemptId, subject, details
    FROM activity_events WHERE recorded_at >= ? AND browser_session IS NULL ORDER BY seq DESC LIMIT 60
  `);
  const recentInteractions = db.prepare(`
    SELECT seq AS id, recorded_at AS at, kind, view, destination, control, subject
    FROM activity_events WHERE recorded_at >= ? AND browser_session IS NOT NULL ORDER BY seq DESC LIMIT 60
  `);
  let missed = 0;
  let closed = false;

  const load = db.prepare("SELECT version, payload FROM workbench_checkpoints WHERE area = ? ORDER BY rowid");
  const save = db.prepare(`
    INSERT INTO workbench_checkpoints(area, id, version, payload) VALUES (?, ?, 1, ?)
    ON CONFLICT(area, id) DO UPDATE SET version = excluded.version, payload = excluded.payload
  `);

  function insert(event: BusinessEvent) {
    const details = event.details ? JSON.stringify(event.details, (key, value: unknown) => {
      if (typeof value !== "string") return value;
      return credentialField(key) ? "[已隐藏凭据]" : scrubAuditText(value);
    }) : null;
    insertBusiness.run(now(), event.kind, event.flowId ?? null, event.attemptId ?? null, event.subject ?? null, details);
  }

  return {
    checkpoint<T extends object>(area: string): Checkpoint<T> {
      return {
        load() {
          return load.all(area).map(({ version, payload }) => {
            if (version !== 1 || typeof payload !== "string") throw Error("工作台状态版本不兼容。");
            const item: unknown = JSON.parse(payload);
            if (!item || typeof item !== "object" || Array.isArray(item)) throw Error("无法读取工作台状态。");
            return item as T;
          });
        },
        save(id, item, event) {
          if (closed) return false;
          try {
            db.exec("BEGIN IMMEDIATE");
            try {
              save.run(area, id, JSON.stringify(item));
              if (event) insert(event);
              db.exec("COMMIT");
              return true;
            } catch (error) {
              db.exec("ROLLBACK");
              throw error;
            }
          } catch {
            missed += 1;
            return false;
          }
        },
      };
    },
    record(event: BusinessEvent) {
      if (closed) return false;
      try {
        insert(event);
        return true;
      } catch {
        missed += 1;
        return false;
      }
    },
    recordActivity(event: Activity) {
      try {
        const isClick = event.kind === "ui.click";
        insertActivity.run(now(), event.kind, event.id, event.session, event.elapsed, event.view, isClick ? null : event.destination,
          isClick ? event.control : null, isClick ? event.subject ?? null : null);
        return true;
      } catch {
        missed += 1;
        return false;
      }
    },
    report(days: number) {
      const generatedAt = now();
      const since = generatedAt - days * 86_400_000;
      return {
        days, generatedAt, missed, thresholds,
        totals: Object.fromEntries(totals.all(since).map(row => [row.kind, row.total])),
        clicks: clicks.all(since, thresholds.repeatClickMs), transitions: transitions.all(since, thresholds.quickReturnMs),
        interactions: recentInteractions.all(since),
        recent: recent.all(since).map(row => {
          const kind = row.kind as BusinessEvent["kind"];
          const details = typeof row.details === "string" ? JSON.parse(row.details) as unknown : null;
          const jobCounts = kind === "dispatch.finished" ? countDispatchJobs(details) : undefined;
          return {
            id: row.id as number, version: row.version as number, at: row.at as number, kind,
            flowId: row.flowId as string | null, attemptId: row.attemptId as string | null, subject: row.subject as string | null,
            details,
            ...(jobCounts ? { jobCounts } : {}),
          };
        }),
      };
    },
    close() { closed = true; db.close(); },
  };
}
