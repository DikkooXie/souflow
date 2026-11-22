import assert from "node:assert/strict";
import { test } from "node:test";
import type { IssueDetail, IssueTracker } from "../src/connections/issue-tracker.mts";
import { IssueVerificationUncertain } from "../src/execution/issue-verification.mts";
import type { Claim } from "../src/workbench/issue-dispatch.mts";
import { createIssueDispatch } from "../src/workbench/issue-dispatch.mts";

function fixture() {
  const item: IssueDetail = { number: 4, title: "核验", body: "验收条件", state: "OPEN", url: "https://github.com/a/b/issues/4", pulls: [], assignees: [] };
  const records = new Map<string, Claim>();
  const calls = { assign: 0, verify: 0 };
  const tracker: IssueTracker = { repo: "a/b", candidates: async () => [item], read: async () => structuredClone(item),
    account: async () => "developer", async assign(_number, login) { calls.assign++; item.assignees.push(login); } };
  const store = { load: () => [...records.values()], save(id: string, c: Claim) { records.set(id, structuredClone(c)); return true; } };
  const service = () => createIssueDispatch(tracker, store, async () => { calls.verify++; return "已核验"; }, () => true, 2);
  return { calls, item, tracker, store, records, service };
}

test("认领事务写失败时没有外部副作用", async () => {
  const f = fixture(); f.store.save = () => false;
  await assert.rejects(f.service().claim("one", "member"), /无法保存/);
  assert.deepEqual(f.calls, { assign: 0, verify: 0 });
});

test("会话断线或完成记录保存失败后保留待核对状态与原有证据", async () => {
  for (const failure of ["transport", "checkpoint"]) {
    const f = fixture();
    const persisted = f.store.save;
    f.store.save = (id, c) => c.phase !== "done" && persisted(id, c);
    const service = createIssueDispatch(f.tracker, f.store, async (_issue, connected) => {
      connected("original-session");
      if (failure === "transport") throw new IssueVerificationUncertain("needs-reconciliation");
      return "原核验清单";
    }, () => true, 1);
    await service.claim("original", "member");
    await service.close();
    const restored = f.service().snapshot(true).items[0];
    assert.equal(restored?.progress, "待核对");
    assert.equal(f.records.get("4")?.sessionId, "original-session");
    assert.equal(f.records.get("4")?.report, failure === "checkpoint" ? "原核验清单" : undefined);
  }
});

test("认领回执丢失和服务重启之后只核对，不重复派发", async () => {
  const f = fixture();
  f.tracker.assign = async () => { f.calls.assign++; f.item.assignees.push("developer"); throw Error("断线"); };
  await assert.rejects(f.service().claim("one", "member"), /待核对/);
  const recovered = f.service();
  await recovered.claim("one", "member");
  await assert.rejects(recovered.claim("another", "member"), /没有可领取/);
  assert.equal(recovered.snapshot(true).items[0]?.progress, "待核对");
  assert.deepEqual(f.calls, { assign: 1, verify: 0 });
});

test("GitHub 回读出现两位负责人时保留冲突，禁止开始执行", async () => {
  const f = fixture();
  f.tracker.assign = async () => { f.calls.assign++; f.item.assignees.push("developer", "colleague"); };
  const service = f.service();
  await assert.rejects(service.claim("one", "member"), /冲突/);
  assert.deepEqual(service.snapshot(true).items[0]?.assignees, ["developer", "colleague"]);
  assert.deepEqual(f.calls, { assign: 1, verify: 0 });
});

test("关闭工作台时尚未回读的认领不能在异步返回后启动", async () => {
  const f = fixture();
  let signalStart!: () => void;
  let signalRelease!: () => void;
  const started = new Promise<void>(resolve => { signalStart = resolve; });
  const release = new Promise<void>(resolve => { signalRelease = resolve; });
  f.tracker.assign = async () => { signalStart(); await release; f.item.assignees.push("developer"); };
  const service = f.service();
  const claim = service.claim("one", "member");
  await started;
  const closed = service.close();
  signalRelease();
  await assert.rejects(claim, /待核对/);
  await closed;
  assert.equal(f.calls.verify, 0);
});
