import { createHash } from "node:crypto";

// 连接层只公开工单事实与可用操作，供应商请求、凭据和模型输入分别留在各自边界。
export type IssueSummary = { number: number; title: string; url: string; state: string; assignees: string[] };
export type IssuePull = {
  number: number; state: string; url: string;
  ci?: string; head?: string; mergeCommit?: string; draft?: boolean;
  baseName?: string;
};
export type IssuePullChanges = { mergeBase: string; files: { path: string; diff: string }[] };
export type IssueDetail = IssueSummary & {
  pulls: IssuePull[];
  body: string;
};
export type IssueCreation = { title: string; body: string };
export const maxIssueBodyCharacters = 8000;
export type IssueCreator = {
  create(input: IssueCreation, account?: string): Promise<number>;
  findCreated(marker: string, creator: string, since: string): Promise<number[]>;
};
export type IssueTracker = {
  repo: string;
  candidates(exclude?: ReadonlySet<number>, allowed?: ReadonlySet<number>): Promise<IssueSummary[]>;
  read(number: number): Promise<IssueDetail>;
  account(): Promise<string>;
  assign(number: number, login: string): Promise<void>;
  creation?: IssueCreator;
};

export type IssuePublisher = {
  checkout(target: string, signal: AbortSignal): Promise<{ base: string; author: string; email: string }>;
  publish(input: { workspace: string; issue: number; branch: string; base: string; head: string; title: string }, signal: AbortSignal): Promise<IssuePull>;
  find(branch: string, head: string, knownPull?: number): Promise<IssuePull | undefined>;
  reviewChanges?(pull: IssuePull, signal: AbortSignal): Promise<IssuePullChanges>;
  checkoutPublished?(workspace: string, target: { branch: string; head: string }, signal: AbortSignal): Promise<void>;
  updatePublished?(input: { workspace: string; branch: string; from: string; head: string; pull: number; base: string }, signal: AbortSignal): Promise<IssuePull>;
};

export type DeliveryTracker = IssueTracker & { delivery: IssuePublisher };

export function issueRevision(issue: IssueDetail) {
  return createHash("sha256").update(JSON.stringify([issue.title, issue.body])).digest("hex");
}
