import { matchesGitHubOrigin, validateGitHubRepo } from "../connections/github.mts";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { scrubAuditText } from "../audit/activity-store.mts";
import { runtimeInteger } from "../config/runtime.mts";
import { issueRevision, type IssueDetail, type IssueTracker, type PlanningReference } from "../connections/issue-tracker.mts";

const exec = promisify(execFile);
const sha = /^[a-f0-9]{40,64}$/;
const planFile = /^docs\/(?:[a-z\d_-]+\/)*[a-z\d_-]+\.md$/i;

const budget = { gitMs: 3000, githubMs: 6000, bytes: 64 * 1024, planChars: 16000 };
const historyLimit = 8;
const issueBodyLimit = 3000;

export type ProjectSettings = { planPath?: string; githubRepo?: string };
type PullRequest = { number: number; state: "OPEN" | "CLOSED" | "MERGED"; title: string; url: string };
type IssueSource = { number: number; title: string; body?: string; truncated?: boolean; revision?: string };
type RelatedIssue = { number: number; url: string } & ({ status: "unavailable" }
  | { status: "read"; state: "OPEN" | "CLOSED"; assigned: boolean; source: IssueSource });
type RelatedPullRequest = PullRequest & { head: string; mergeCommit?: string; source: IssueSource };
export type PlanningSourceFile = { path: string } & (
  { status: "unavailable" } | { status: "read"; bytes: number; sha256: string }
);
export type ProjectEvidence = {
  repository?: { revision: string; commits: { revision: string; subject: string }[] };
  plan: { status: "unconfigured" | "unavailable" | "read"; path?: string };
  issueCandidates?: IssueSource[];
  relatedIssues?: RelatedIssue[];
  relatedPullRequests?: RelatedPullRequest[];
  relatedIssueOmissions?: { count: number; examples: number[] };
  planningSources?: { files: PlanningSourceFile[]; omitted: number };
  github: { status: "unconfigured" | "unavailable" | "read"; repo?: string; pullRequests?: PullRequest[] };
};
export type ProjectContext = { evidence: ProjectEvidence; planText?: string };

function concise(text: string) {
  return scrubAuditText(text).replace(/[\r\n]+/g, " ").slice(0, 200);
}

function snapshotIssueSource(issue: Pick<IssueDetail, "number" | "title" | "body">): IssueSource {
  const body = scrubAuditText(issue.body);
  return { number: issue.number, title: concise(issue.title), body: body.slice(0, issueBodyLimit),
    truncated: body.length > issueBodyLimit, revision: issueRevision(issue) };
}

export function snapshotIssueCandidates(issues: readonly IssueDetail[]): NonNullable<ProjectEvidence["issueCandidates"]> {
  return issues.slice(0, historyLimit).map(snapshotIssueSource);
}

const dependencyLine = /^\s*(?:[-*+]\s+)?(?:依赖|depends on)(?=\s|[:：#]|$)/iu;
function linkedReferences(text: string, repo: string) {
  const urlsOrShorthand = /https:\/\/github\.com\/([a-z\d_.-]+\/[a-z\d_.-]+)\/(issues|pull)\/([1-9]\d*)\b|(?<![\w/#])#([1-9]\d*)\b/gi;
  const links = text.replace(/\[[^\]\r\n]*\]\((https:\/\/github\.com\/[^)\s]+)\)/gi, "$1");
  return [...links.matchAll(urlsOrShorthand)].flatMap(match => {
    if (match[1] && match[1].toLowerCase() !== repo.toLowerCase()) return [];
    const number = Number(match[3] ?? match[4]);
    const pull = match[2]?.toLowerCase() === "pull" || (!match[1] && /(?:\bPR|pull request)\s*$/i.test(links.slice(0, match.index)));
    return Number.isSafeInteger(number) ? [{ number, pull }] : [];
  });
}

export async function readRelatedIssues(tracker: Pick<IssueTracker, "repo" | "read" | "readPlanningReferences">,
  candidates: readonly IssueDetail[], planText = "") {
  const known = new Set(candidates.map(issue => issue.number));
  const lines = [planText, ...candidates.map(issue => issue.body)].flatMap(text => text.split(/\r?\n/));
  const ordered = [...lines.filter(line => dependencyLine.test(line)), ...lines.filter(line => !dependencyLine.test(line))];
  const links = ordered.flatMap(line => linkedReferences(line, tracker.repo));
  if (tracker.readPlanningReferences) {
    const limit = runtimeInteger("SOULFLOW_PROJECT_GITHUB_REFERENCE_LIMIT", 1, 32);
    const numbers = [...new Set(links.map(link => link.number))].filter(number => !known.has(number));
    const batch = numbers.slice(0, limit);
    const resolved = batch.length ? await tracker.readPlanningReferences(batch).catch(() => undefined) : undefined;
    const issues: RelatedIssue[] = [];
    const pullRequests: RelatedPullRequest[] = [];
    for (const number of batch) {
      const found: PlanningReference | undefined = resolved?.get(number);
      if (found?.number === number && found.kind === "pull") {
        const { head, mergeCommit, title, body, state } = found;
        const source = snapshotIssueSource(found);
        source.revision = createHash("sha256").update(JSON.stringify([title, body, state, head, mergeCommit])).digest("hex");
        pullRequests.push({ number, url: `https://github.com/${tracker.repo}/pull/${number}`,
          title: concise(title), state, head, ...(mergeCommit ? { mergeCommit } : {}), source });
        continue;
      }
      const url = `https://github.com/${tracker.repo}/${links.some(link => link.number === number && link.pull) ? "pull" : "issues"}/${number}`;
      if (found?.number === number && found.kind === "issue") {
        issues.push({ number, url: `https://github.com/${tracker.repo}/issues/${number}`,
          status: "read", state: found.state, assigned: found.assigned, source: snapshotIssueSource(found) });
      } else {
        issues.push({ number, url, status: "unavailable" });
      }
    }
    return { issues, pullRequests, ...(numbers.length > limit ? {
      omissions: { count: numbers.length - limit, examples: numbers.slice(limit, limit + historyLimit) },
    } : {}) };
  }
  const numbers = [...new Set(links.filter(link => !link.pull).map(link => link.number))].filter(number => !known.has(number));
  const issues = await Promise.all(numbers.slice(0, historyLimit).map(async (number): Promise<RelatedIssue> => {
    const url = `https://github.com/${tracker.repo}/issues/${number}`;
    try {
      const issue = await tracker.read(number);
      if (issue.number === number && (issue.state === "OPEN" || issue.state === "CLOSED")) {
        const [source] = snapshotIssueCandidates([issue]);
        if (source) return { number, url, status: "read", state: issue.state, assigned: issue.assignees.length > 0, source };
      }
    } catch { /* 只记录不可读状态，连接凭据与远端错误留在适配器边界。 */ }
    return { number, url, status: "unavailable" };
  }));
  return { issues, pullRequests: [] as RelatedPullRequest[], ...(numbers.length > historyLimit ? {
    omissions: { count: numbers.length - historyLimit, examples: numbers.slice(historyLimit, historyLimit * 2) },
  } : {}) };
}

function parsePullRequests(text: string, repo: string): PullRequest[] {
  const rows: unknown = JSON.parse(text);
  if (!Array.isArray(rows)) throw Error("无法识别 GitHub 拉取请求列表。");
  return rows.slice(0, historyLimit).map(row => {
    if (!row || !Number.isSafeInteger(row.number) || row.number < 1 || typeof row.title !== "string" ||
      !["OPEN", "CLOSED", "MERGED"].includes(row.state)) throw Error("无法识别 GitHub 拉取请求。");
    return { number: row.number, state: row.state, title: concise(row.title), url: `https://github.com/${repo}/pull/${row.number}` };
  });
}

export function createProjectContextReader(workspace: string, { planPath, githubRepo }: ProjectSettings) {
  if (planPath && !planFile.test(planPath)) throw Error("SOULFLOW_PROJECT_PLAN 必须是 docs/ 下的相对 Markdown 路径。");
  if (githubRepo) validateGitHubRepo(githubRepo);

  async function git(...args: string[]) {
    return (await exec("git", ["-C", workspace, ...args], { timeout: budget.gitMs, maxBuffer: budget.bytes })).stdout;
  }

  async function readPlan(revision: string) {
    if (!planPath) return;
    const entry = await git("ls-tree", revision, "--", planPath);
    const blob = /^100(?:644|755) blob ([a-f0-9]{40,64})\t/.exec(entry)?.[1];
    if (!blob) return;
    const text = await git("cat-file", "blob", blob);
    if (text.length > budget.planChars || text.includes("\0") || !text.trim()) return;
    return scrubAuditText(text);
  }

  async function readGitHub() {
    if (!githubRepo) return;
    if (!await matchesGitHubOrigin(workspace, githubRepo)) return;
    const { stdout } = await exec("gh", ["pr", "list", "--repo", `github.com/${githubRepo}`, "--state", "all",
      "--limit", String(historyLimit), "--json", "number,state,title"], {
      cwd: workspace, timeout: budget.githubMs, maxBuffer: budget.bytes,
      env: { ...process.env, GH_PROMPT_DISABLED: "1" },
    });
    return parsePullRequests(stdout, githubRepo);
  }

  return async (): Promise<ProjectContext> => {
    const evidence: ProjectEvidence = {
      plan: planPath ? { status: "unavailable", path: planPath } : { status: "unconfigured" },
      github: githubRepo ? { status: "unavailable", repo: githubRepo } : { status: "unconfigured" },
    };
    const revision = await git("rev-parse", "--verify", "HEAD").then(text => text.trim(), () => "");
    if (!sha.test(revision)) return { evidence };
    const [plan, github, history] = await Promise.allSettled([
      readPlan(revision), readGitHub(), git("log", "--no-show-signature", `-${historyLimit}`, "--format=%H%x09%s", revision),
    ]);
    const commits = (history.status === "fulfilled" ? history.value : "").trim().split("\n").flatMap(line => {
      const [commit, ...subject] = line.split("\t");
      return commit && sha.test(commit) ? [{ revision: commit, subject: concise(subject.join(" ")) }] : [];
    });
    evidence.repository = { revision, commits };
    if (github.status === "fulfilled" && github.value) {
      evidence.github.status = "read";
      evidence.github.pullRequests = github.value;
    }
    if (plan.status !== "fulfilled" || !plan.value) return { evidence };
    evidence.plan.status = "read";
    return { evidence, planText: plan.value };
  };
}
