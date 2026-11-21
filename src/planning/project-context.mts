import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { scrubAuditText } from "../audit/activity-store.mts";

const exec = promisify(execFile);
const sha = /^[a-f0-9]{40,64}$/;
const planFile = /^docs\/(?:[a-z\d_-]+\/)*[a-z\d_-]+\.md$/i;
const repoName = /^[a-z\d][a-z\d-]*\/[a-z\d_.-]+$/i;
const budget = { gitMs: 3000, githubMs: 6000, bytes: 64 * 1024, planChars: 16000 };
const historyLimit = 8;

export type ProjectSettings = { planPath?: string; githubRepo?: string };
type PullRequest = { number: number; state: "OPEN" | "CLOSED" | "MERGED"; title: string; url: string };
export type ProjectEvidence = {
  repository?: { revision: string; commits: { revision: string; subject: string }[] };
  plan: { status: "unconfigured" | "unavailable" | "read"; path?: string };
  github: { status: "unconfigured" | "unavailable" | "read"; repo?: string; pullRequests?: PullRequest[] };
};
export type ProjectContext = { evidence: ProjectEvidence; planText?: string };

function concise(text: string) {
  return scrubAuditText(text).replace(/[\r\n]+/g, " ").slice(0, 200);
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
  if (githubRepo && !repoName.test(githubRepo)) throw Error("SOULFLOW_PROJECT_GITHUB_REPO 必须是 GitHub 的 owner/repository。");

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
    const remote = (await git("remote", "get-url", "origin")).trim();
    const originRepo = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+\/[^/]+)$/i.exec(remote)?.[1]
      ?.replace(/\.git$/i, "");
    if (originRepo?.toLowerCase() !== githubRepo.toLowerCase()) return;
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
