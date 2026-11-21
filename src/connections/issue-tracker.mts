// 连接层只公开工单事实与可用操作，供应商请求、凭据和模型输入分别留在各自边界。
export type IssueSummary = { number: number; title: string; url: string; state: string; assignees: string[] };
export type IssueDetail = IssueSummary & {
  pulls: { number: number; state: string; url: string }[];
  body: string;
};
export type IssueTracker = {
  repo: string;
  candidates(exclude?: ReadonlySet<number>): Promise<IssueSummary[]>;
  read(number: number): Promise<IssueDetail>;
  account(): Promise<string>;
  assign(number: number, login: string): Promise<void>;
};
