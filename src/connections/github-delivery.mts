import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { IssuePublisher, IssuePull } from "./issue-tracker.mts";

const exec = promisify(execFile);
const commandLimit = { timeout: 90_000, maxBuffer: 2 * 1024 * 1024 };
const revision = /^[a-f0-9]{40}$/;
const maxReviewDiffBytes = 160 * 1024;

export const githubPullFields = "number state isDraft headRefOid baseRefName mergeCommit{oid} commits(last:1){nodes{commit{oid statusCheckRollup{state}}}}";
type PullNode = {
  number: number; state: string; isDraft: boolean; headRefOid: string; mergeCommit: { oid: string } | null;
  baseRefName?: string;
  commits: { nodes: { commit: { oid: string; statusCheckRollup: { state: string } | null } }[] };
};
export function githubPull(repo: string, pr: PullNode): IssuePull {
  const commit = pr.commits.nodes[0]?.commit;
  return { number: pr.number, state: pr.state, url: `https://github.com/${repo}/pull/${pr.number}`,
    draft: pr.isDraft, head: pr.headRefOid, ...(pr.baseRefName ? { baseName: pr.baseRefName } : {}),
    ...(pr.mergeCommit ? { mergeCommit: pr.mergeCommit.oid } : {}),
    ci: commit?.oid === pr.headRefOid ? commit.statusCheckRollup?.state ?? "NONE" : "NONE" };
}

export function createGitHubDelivery(repo: string, api: (args: string[]) => Promise<string>,
  credentialEnv: () => Promise<NodeJS.ProcessEnv>): IssuePublisher {
  const [owner, name] = repo.split("/");
  const url = `https://github.com/${repo}.git`;
  async function git(args: string[], signal: AbortSignal, env?: NodeJS.ProcessEnv) {
    // 凭据只进入固定 Git 命令。测试与 Codex 不使用此环境，也不读取全局 Git 助手。
    try {
      return (await exec("git", ["-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential",
        "-c", "core.hooksPath=/dev/null", ...args], {
        ...commandLimit, env: { ...(env ?? await credentialEnv()), GIT_NO_REPLACE_OBJECTS: "1" }, signal,
      })).stdout.trim();
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
    async reviewChanges(pull, signal) {
      if (!pull.head || !revision.test(pull.head) || !Number.isSafeInteger(pull.number) || pull.number < 1) {
        throw Error("缺少可复核的 PR 提交。");
      }
      const endpoint = `repos/${repo}/pulls/${pull.number}`;
      type PullRefs = { head: { sha: string; repo: { full_name: string } | null }; base: { sha: string; repo: { full_name: string } } };
      const read = async () => {
        signal.throwIfAborted();
        const { head, base } = JSON.parse(await api([endpoint])) as PullRefs;
        if (head.sha !== pull.head || !revision.test(base.sha) || [head.repo, base.repo].some(item => item?.full_name.toLowerCase() !== repo.toLowerCase())) {
          throw Error("PR 提交或关联仓库已变化。");
        }
        return base.sha;
      };
      const base = await read();
      const workspace = await mkdtemp(join(tmpdir(), "souflow-pr-review-"));
      try {
        const env = await credentialEnv();
        const run = (args: string[]) => git(["-C", workspace, ...args], signal, env);
        // 只取 Git 对象，不检出或执行 PR 的文件、过滤器和钩子。
        await run(["init", "--bare", "--template="]);
        await run(["fetch", "--no-tags", url, `refs/pull/${pull.number}/head:refs/review/head`, `${base}:refs/review/base`]);
        if (await run(["rev-parse", "refs/review/head"]) !== pull.head) throw Error("PR 提交已变化。");
        const mergeBase = await run(["merge-base", base, pull.head]);
        if (!revision.test(mergeBase)) throw Error("无法固定 PR 的比较起点。");
        const diffArgs = ["--literal-pathspecs", "diff", "--no-ext-diff", "--no-textconv", "--no-renames"];
        const paths = (await run([...diffArgs, "--name-only", "-z", mergeBase, pull.head, "--"])).split("\0").filter(Boolean);
        const files: { path: string; diff: string }[] = [];
        let bytes = 0;
        for (const path of paths) {
          const diff = await run([...diffArgs, "--full-index", "--binary", mergeBase, pull.head, "--", path]);
          bytes += Buffer.byteLength(path) + Buffer.byteLength(diff);
          if (bytes > maxReviewDiffBytes) throw Error("PR 差异超出完整复核范围。");
          if (!diff) throw Error("无法读取 PR 文件的完整差异。");
          files.push({ path, diff });
        }
        if (await read() !== base) throw Error("PR 目标分支提交已变化。");
        return { mergeBase, files };
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }
    },
    async checkoutPublished(workspace, { branch, head }, signal) {
      if (!/^feat\/\d+-[a-f0-9]{12}$/.test(branch) || !/^[a-f0-9]{40}$/.test(head)) throw Error("续修目标无效。");
      const run = (args: string[]) => git(["-C", workspace, ...args], signal);
      await run(["fetch", "--no-tags", url, `refs/heads/${branch}`]);
      if (await run(["rev-parse", "FETCH_HEAD"]) !== head) throw Error("续修分支已经变化。");
      await run(["switch", "--detach", head]);
    },
    async updatePublished({ workspace, branch, from, head, pull, base }, signal) {
      if (!/^feat\/\d+-[a-f0-9]{12}$/.test(branch) || ![from, head].every(sha => /^[a-f0-9]{40}$/.test(sha))) {
        throw Error("续修提交目标无效。");
      }
      const previous = await find(branch, from, pull);
      if (previous?.state !== "OPEN" || previous.head !== from || previous.baseName !== base
        || await git(["-C", workspace, "rev-list", "--parents", "-n", "1", head], signal) !== `${head} ${from}`) {
        throw Error("PR 已变化，或续修提交不满足快进条件。");
      }
      const ref = `refs/heads/${branch}`;
      await git(["-C", workspace, "push", `--force-with-lease=${ref}:${from}`, url, `${head}:${ref}`], signal);
      const updated = await find(branch, head, pull);
      if (updated?.head !== head || updated.baseName !== base) throw Error("无法确认续修发布。");
      return updated;
    },
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
