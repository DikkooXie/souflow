import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { IssuePublisher, IssuePull } from "./issue-tracker.mts";

const exec = promisify(execFile);
const commandLimit = { timeout: 90_000, maxBuffer: 2 * 1024 * 1024 };

export const githubPullFields = "number state isDraft headRefOid mergeCommit{oid} commits(last:1){nodes{commit{oid statusCheckRollup{state}}}}";
type PullNode = {
  number: number; state: string; isDraft: boolean; headRefOid: string; mergeCommit: { oid: string } | null;
  commits: { nodes: { commit: { oid: string; statusCheckRollup: { state: string } | null } }[] };
};
export function githubPull(repo: string, pr: PullNode): IssuePull {
  const commit = pr.commits.nodes[0]?.commit;
  return { number: pr.number, state: pr.state, url: `https://github.com/${repo}/pull/${pr.number}`,
    draft: pr.isDraft, head: pr.headRefOid, ...(pr.mergeCommit ? { mergeCommit: pr.mergeCommit.oid } : {}),
    ci: commit?.oid === pr.headRefOid ? commit.statusCheckRollup?.state ?? "NONE" : "NONE" };
}

export function createGitHubDelivery(repo: string, api: (args: string[]) => Promise<string>,
  credentialEnv: () => Promise<NodeJS.ProcessEnv>): IssuePublisher {
  const [owner, name] = repo.split("/");
  const url = `https://github.com/${repo}.git`;
  async function git(args: string[], signal: AbortSignal) {
    // 凭据只进入固定 Git 命令。测试与 Codex 不使用此环境，也不读取全局 Git 助手。
    try {
      await exec("git", ["-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential",
        "-c", "core.hooksPath=/dev/null", ...args], { ...commandLimit, env: await credentialEnv(), signal });
    } catch { throw Error("GitHub 工作区操作失败。"); }
  }
  async function find(branch: string, head: string, knownPull?: number) {
    const query = `query($owner:String!,$name:String!,$branch:String!){
      repository(owner:$owner,name:$name){pullRequests(first:10,headRefName:$branch,
      orderBy:{field:CREATED_AT,direction:DESC}){nodes{headRepository{nameWithOwner} ${githubPullFields}}}}}`;
    const { data } = JSON.parse(await api(["graphql", "-f", `query=${query}`, "-f", `owner=${owner}`,
      "-f", `name=${name}`, "-f", `branch=${branch}`]));
    const match = (data.repository.pullRequests.nodes as (PullNode & { headRepository: { nameWithOwner: string } | null })[])
      .find(pr => (knownPull === undefined ? pr.headRefOid === head : pr.number === knownPull) && pr.headRepository?.nameWithOwner.toLowerCase() === repo.toLowerCase());
    return match && githubPull(repo, match);
  }
  return {
    find,
    async checkout(target, signal) {
      const { default_branch: base } = JSON.parse(await api([`repos/${repo}`]));
      const { login: author, id } = JSON.parse(await api(["user"]));
      if (typeof base !== "string" || !base || !/^[a-z0-9][a-z0-9-]{0,38}$/i.test(author) || !Number.isSafeInteger(id)) {
        throw Error("无法核对 GitHub 默认分支或作者。");
      }
      await git(["clone", "--template=", "--single-branch", "--branch", base, "--", url, target], signal);
      return { base, author, email: `${id}+${author}@users.noreply.github.com` };
    },
    async publish({ workspace, issue, branch, base, head, title }, signal) {
      if (!/^feat\/\d+-[a-f0-9]{12}$/.test(branch) || !/^[a-f0-9]{40}$/.test(head)) throw Error("推送目标不符合工单分支约定。");
      const prior = await find(branch, head);
      if (prior) return prior;
      const ref = `refs/heads/${branch}`;
      await git(["-C", workspace, "push", `--force-with-lease=${ref}:`, url, `${head}:${ref}`], signal);
      signal.throwIfAborted();
      const { number } = JSON.parse(await api(["--method", "POST", `repos/${repo}/pulls`,
        "-f", `head=${branch}`, "-f", `base=${base}`, "-f", `title=${title}`,
        "-f", `body=Closes #${issue}\n\n本机 Codex 在独立工作区生成改动，npm run check 通过。请核对工单验收条件、差异和 GitHub CI。`, "-F", "draft=true"]));
      const pull = await find(branch, head);
      if (!pull || pull.number !== number) throw Error("无法确认关联 PR。");
      return pull;
    },
  };
}
