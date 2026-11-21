import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { scrubAuditText } from "../audit/activity-store.mts";
import type { IssueDetail, IssueTracker } from "./issue-tracker.mts";

const exec = promisify(execFile);
const repoPattern = /^[a-z\d][a-z\d-]*\/[a-z\d_.-]+$/i;
const limit = { timeout: 10_000, maxBuffer: 2 * 1024 * 1024 };

export function validateGitHubRepo(repo: string) {
  if (!repoPattern.test(repo) || repo.endsWith("/.") || repo.endsWith("/..")) throw Error("GitHub 仓库应为 owner/repository。");
}

export async function matchesGitHubOrigin(workspace: string, repo: string) {
  const { stdout } = await exec("git", ["-C", workspace, "remote", "get-url", "origin"], limit);
  const found = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+\/[^/]+)$/i.exec(stdout.trim())?.[1];
  return found?.replace(/\.git$/i, "").toLowerCase() === repo.toLowerCase();
}

export function createGitHubIssues(workspace: string, repo: string, login?: string): IssueTracker {
  validateGitHubRepo(repo);
  if (login !== undefined && !/^[a-z0-9][a-z0-9-]{0,38}$/i.test(login)) throw Error("GitHub 登录名格式无效。");
  const [owner, name] = repo.split("/");
  const root = `https://github.com/${repo}`;
  async function gh(args: string[], account = login) {
    if (!await matchesGitHubOrigin(workspace, repo)) throw Error("GitHub 仓库与当前 origin 不一致。");
    const env = { ...process.env, GH_PROMPT_DISABLED: "1" };
    // 从本机 gh 凭据库按连接取凭据，仅传给这次 gh 子进程，不修改其他成员的活动账号。
    if (account) {
      const credential = await exec("gh", ["auth", "token", "--hostname", "github.com", "--user", account], limit);
      Object.assign(env, { GH_TOKEN: credential.stdout.trim() });
    }
    const result = await exec("gh", ["api", "--hostname", "github.com", ...args], {
      ...limit, cwd: workspace, env,
    });
    return result.stdout;
  }
  async function read(number: number): Promise<IssueDetail> {
    const query = `query($owner:String!, $name:String!, $number:Int!){
      repository(owner:$owner,name:$name){issue(number:$number){number title body state assignees(first:10){nodes{login}}
      closedByPullRequestsReferences(first:50,includeClosedPrs:true){nodes{number state repository{nameWithOwner}}}}}}`;
    const { data } = JSON.parse(await gh(["graphql", "-f", `query=${query}`, "-f", `owner=${owner}`, "-f", `name=${name}`, "-F", `number=${number}`]));
    const item = data.repository.issue;
    if (item?.number !== number) throw Error("未找到对应的 Issue。");
    const pulls = item.closedByPullRequestsReferences.nodes as {number: number; state: string; repository: {nameWithOwner: string}}[];
    return { number, title: scrubAuditText(item.title), body: scrubAuditText(item.body).slice(0, 8000), state: item.state,
      url: `${root}/issues/${number}`, assignees: item.assignees.nodes.map((a: {login: string}) => a.login),
      pulls: pulls.filter(pr => pr.repository.nameWithOwner.toLowerCase() === repo.toLowerCase())
        .map(pr => ({ number: pr.number, state: pr.state, url: `${root}/pull/${pr.number}` })) };
  }
  return {
    repo, read,
    async candidates(exclude) {
      // Issues REST 列表也可能包含 PR，先过滤，再从最早创建的无人负责工单中选择。
      const items = [];
      for (let page = 1; items.length < 30; page++) {
        const rows = JSON.parse(await gh([`repos/${repo}/issues?state=open&assignee=none&sort=created&direction=asc&per_page=100&page=${page}`,
          "--jq", "map({number,title,pull_request,assignees:[.assignees[].login]})"])) as {
          number: number; title: string; pull_request: unknown; assignees: string[];
        }[];
        items.push(...rows.filter(row => !row.pull_request && !row.assignees.length && !exclude?.has(row.number)).map(row => ({
          number: row.number, title: scrubAuditText(row.title), state: "OPEN", assignees: row.assignees, url: `${root}/issues/${row.number}`,
        })));
        if (rows.length < 100) break;
      }
      return items.slice(0, 30);
    },
    async account() {
      const actual = (await gh(["user", "--jq", ".login"])).trim();
      if (!/^[\w-]+(?:\[bot\])?$/.test(actual) || (login && actual.toLowerCase() !== login.toLowerCase())) throw Error("未取得 GitHub 登录身份。");
      return actual;
    },
    async assign(number, assignee) {
      if (login && login.toLowerCase() !== assignee.toLowerCase()) throw Error("负责人和连接的账号不符。");
      await gh(["--method", "POST", `repos/${repo}/issues/${number}/assignees`, "-f", `assignees[]=${assignee}`, "--silent"], assignee);
    },
  };
}
