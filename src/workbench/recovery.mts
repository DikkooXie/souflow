import { DatabaseSync } from "node:sqlite";
import { type openActivityStore, secureDatabaseFile } from "../audit/activity-store.mts";

export function lockWorkbench(path: string) {
  // 单独的 SQLite 锁保护业务数据库的内存状态，进程退出时由操作系统释放。
  const lockPath = `${path}.workbench-lock`;
  secureDatabaseFile(lockPath);
  const lock = new DatabaseSync(lockPath);
  try {
    lock.exec("BEGIN IMMEDIATE");
  } catch (error) {
    lock.close();
    throw Error("同一数据库已被另一个工作台打开。", { cause: error });
  }
  return () => lock.close();
}

export function bindWorkbench(audit: ReturnType<typeof openActivityStore>, workspace: string, restricted: boolean) {
  const store = audit.checkpoint<{ workspace: string; restricted: boolean }>("workbench");
  const [previous] = store.load();
  if (previous) {
    if (previous.workspace !== workspace || previous.restricted !== restricted) {
      throw Error("工作台数据库与当前工作区或成员登录模式不一致。请使用各自的数据库路径。");
    }
  } else if (!store.save("owner", { workspace, restricted })) {
    throw Error("无法初始化工作台状态。");
  }
}
