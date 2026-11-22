import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createGitHubIssues, matchesGitHubOrigin } from "../src/connections/github.mts";

test("GitHub 写操作只允许同一 origin 和连接自身的负责人", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "souflow-origin-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", workspace, ...args]);
  try {
    git("init", "-q");
    git("remote", "add", "origin", "git@github.com:Example/Project.git");
    assert.equal(await matchesGitHubOrigin(workspace, "example/project"), true);
    const connection = createGitHubIssues(workspace, "example/project", "member");
    await assert.rejects(connection.assign(1, "someone-else"), /账号不符/);
    for (const other of ["https://github.com/example/other.git", "https://example.invalid/example/project.git"]) {
      git("remote", "set-url", "origin", other);
      await assert.rejects(connection.assign(1, "member"), /origin/);
    }
    assert.throws(() => createGitHubIssues(workspace, "example/..", "member"), /仓库/);
    assert.throws(() => createGitHubIssues(workspace, "example/project", ""), /登录名/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
