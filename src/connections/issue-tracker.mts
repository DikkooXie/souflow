import { createHash } from "node:crypto";

// 连接层只公开工单事实与可用操作，供应商请求、凭据和模型输入分别留在各自边界。
export type IssueSummary = { number: number; title: string; url: string; state: string; assignees: string[] };
export type IssuePull = {
  number: number; state: string; url: string;
  ci?: string; head?: string; mergeCommit?: string; draft?: boolean;
};
export type IssueDetail = IssueSummary & {
  pulls: IssuePull[];
  body: string;
};
export type IssueTracker = {
  repo: string;
  candidates(exclude?: ReadonlySet<number>, allowed?: ReadonlySet<number>): Promise<IssueSummary[]>;
  read(number: number): Promise<IssueDetail>;
  account(): Promise<string>;
  assign(number: number, login: string): Promise<void>;
};

export type IssuePublisher = {
  checkout(target: string, signal: AbortSignal): Promise<{ base: string; author: string; email: string }>;
  publish(input: { workspace: string; issue: number; branch: string; base: string; head: string; title: string }, signal: AbortSignal): Promise<IssuePull>;
  find(branch: string, head: string, knownPull?: number): Promise<IssuePull | undefined>;
};

export type DeliveryTracker = IssueTracker & { delivery: IssuePublisher };

export function issueRevision(issue: IssueDetail) {
  return createHash("sha256").update(JSON.stringify([issue.title, issue.body])).digest("hex");
}
