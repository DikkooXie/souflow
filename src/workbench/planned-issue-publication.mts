import { createHash } from "node:crypto";
import { scrubAuditText, type Checkpoint } from "../audit/activity-store.mts";
import { maxIssueBodyCharacters, type IssueCreation, type IssueDetail, type IssueTracker } from "../connections/issue-tracker.mts";

export type PlannedIssueDraft = IssueCreation & { id: string; dependsOn: readonly string[] };
export type PlannedIssueBatch = {
  id: string; actor: string; flowId: string; planId: string; version: number;
  drafts: readonly PlannedIssueDraft[];
};
export type IssuePublication = {
  key: string; batch: string; ticket: string; account: string; preparedAt: number;
  digest: string; number?: number;
};

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const clockSkewAllowance = 86_400_000;
const maxIssueNumberCharacters = String(Number.MAX_SAFE_INTEGER).length;

export function hasPublicationMarker(body: string) {
  return /(?:^|\n)<!-- souflow-issue:[a-f0-9]{64} -->$/m.test(body);
}

function render(batch: PlannedIssueBatch, draft: PlannedIssueDraft, marker: string, dependencies: readonly string[]) {
  return {
    title: scrubAuditText(draft.title).trim(),
    body: [`工单 ${draft.id} · 开发计划 v${batch.version}`, "",
      ...dependencies.map(number => `依赖 #${number}`), "",
      ...scrubAuditText(draft.body).replace(/\r\n?/g, "\n").trim().split("\n").map(line => line ? `> ${line}` : ">"),
      "", marker].join("\n"),
  };
}

export function preparePlannedIssues(batch: PlannedIssueBatch, repo: string) {
  const drafts = new Map(batch.drafts.map(draft => [draft.id, draft]));
  if (drafts.size !== batch.drafts.length) throw Error("工单校验未通过：工单编号重复。");
  const remaining = new Set(drafts.keys());
  const sorted: PlannedIssueDraft[] = [];
  while (remaining.size) {
    const ready = batch.drafts.filter(draft => remaining.has(draft.id) && draft.dependsOn.every(id => !remaining.has(id) && drafts.has(id)));
    if (!ready.length) throw Error("工单校验未通过：依赖缺失或有环。");
    for (const draft of ready) {
      remaining.delete(draft.id);
      sorted.push(draft);
    }
  }
  return sorted.map(draft => {
    const key = digest(JSON.stringify([repo.toLowerCase(), batch.id, draft.id]));
    const marker = `<!-- souflow-issue:${key} -->`;
    // 审核时还没有 GitHub 编号，按最多可能的位数验证完整发布正文。
    const maximum = render(batch, draft, marker, draft.dependsOn.map(() => "9".repeat(maxIssueNumberCharacters)));
    if (!maximum.title || /[\r\n\0]/.test(maximum.title) || maximum.body.includes("\0")
      || maximum.body.length > maxIssueBodyCharacters || draft.body.includes("<!-- souflow-issue:")) {
      throw Error(`工单校验未通过：${draft.id} 的 Issue 标题、正文或发布标记无效。`);
    }
    return { draft, key, marker };
  });
}

export class PublishedRepairChanged extends Error {}

export async function readPublishedRepair(batch: PlannedIssueBatch, tracker: IssueTracker, number: number) {
  const prepared = preparePlannedIssues(batch, tracker.repo);
  const row = prepared[0];
  if (prepared.length !== 1 || row?.draft.id !== "REPAIR" || row.draft.dependsOn.length) throw Error("修复工单绑定无效。");
  const expected = render(batch, row.draft, row.marker, []);
  const issue = await tracker.read(number);
  if (issue.number !== number || issue.state !== "OPEN" || issue.title !== expected.title || issue.body !== expected.body) {
    throw new PublishedRepairChanged("已关联修复 Issue 与原授权不一致。");
  }
  return issue;
}

export function createPlannedIssuePublication(store: Checkpoint<IssuePublication>) {
  const receipts = new Map(store.load().map(record => [record.key, record]));
  const active = new Set<string>();

  function save(batch: PlannedIssueBatch, record: IssuePublication) {
    const action = record.number === undefined ? "creation-reserved" : "creation-confirmed";
    if (!store.save(record.key, record, { kind: "github.issue", flowId: batch.flowId, subject: record.key, details: {
      action, actor: batch.actor, batch: batch.id, planId: batch.planId, version: batch.version,
      ticket: record.ticket, number: record.number, githubAccount: record.account,
    } })) throw Error("无法保存 GitHub 建单状态。");
    receipts.set(record.key, record);
  }

  return async function publish(batch: PlannedIssueBatch, tracker: IssueTracker, signal: AbortSignal, expectedAccount?: string) {
    const creator = tracker.creation;
    if (!creator) throw Error("当前 GitHub 连接不支持创建 Issue。");
    if (active.has(batch.id)) throw Error("该批次正在创建 Issue。");
    active.add(batch.id);
    try {
      const account = await tracker.account();
      if (expectedAccount && account.toLowerCase() !== expectedAccount.toLowerCase()) throw Error("建单账号与原授权不一致。");
      const prepared = preparePlannedIssues(batch, tracker.repo);
      const published = new Map<string, IssueDetail>();
      for (const { draft, key, marker } of prepared) {
        signal.throwIfAborted();
        const dependencies = draft.dependsOn.map(id => {
          const upstream = published.get(id);
          if (!upstream) throw Error("前置 Issue 回执缺失。");
          return String(upstream.number);
        });
        const { title, body } = render(batch, draft, marker, dependencies);
        const inputDigest = digest(JSON.stringify([title, body]));
        const prior = receipts.get(key);
        if (prior && (prior.digest !== inputDigest || prior.account.toLowerCase() !== account.toLowerCase())) {
          throw Error("已保留的建单请求与授权内容不一致。");
        }
        const intent = prior ?? { key, batch: batch.id, ticket: draft.id, account, digest: inputDigest, preparedAt: Date.now() };
        let number = prior?.number;
        if (number === undefined) {
          if (!prior) {
            // GitHub 建单没有幂等键。先保留写入意图，重启后只能回读，避免不确定时再次 POST。
            save(batch, intent);
            number = await creator.create({ title, body }, account);
          } else {
            const found = await creator.findCreated(marker, account, new Date(intent.preparedAt - clockSkewAllowance).toISOString());
            if (found.length !== 1) throw Error("GitHub 建单结果待核对，尚未找到唯一回执。");
            number = found[0];
          }
        }
        if (number === undefined || !Number.isSafeInteger(number) || number < 1) throw Error("GitHub 建单回执无效。");
        signal.throwIfAborted();
        const issue = await tracker.read(number);
        if (issue.number !== number || issue.title !== title || issue.body !== body) {
          throw Error("回读 Issue 与已授权内容不一致。");
        }
        if (prior?.number === undefined) save(batch, { ...intent, number });
        published.set(draft.id, issue);
      }
      return published;
    } finally {
      active.delete(batch.id);
    }
  };
}
