# B5 从真实 Issue 到关联 PR 的验收

2026-11-22 在 macOS 本机工作台使用 GPT-6.2 Sol，连接 `huangqj73-test`。工作台同时管理 [#22 校验重复前置](https://github.com/DikkooXie/souflow/issues/22)与 [#23 补拆单入口测试](https://github.com/DikkooXie/souflow/issues/23)。用已经安装的 `node:22.17.1` Docker 镜像执行检查。浏览器访问真实工作台与 GitHub，工单和 PR 来自同一真实仓库。

| 验收项 | 结果 |
| --- | --- |
| 领取无人负责的 Issue | 两张工单均由工作台认领，GitHub 负责人为已绑定账号。 |
| 独立工作区开发、测试、开 PR | #22 由本机 Codex 生成校验逻辑和回归测试。容器检查通过后，工作台创建独立分支 `feat/22-8a29b1879331` 和带关闭引用的 [PR #24](https://github.com/DikkooXie/souflow/pull/24)，CI 通过。 |
| 上游合并前阻塞下游 | #23 在上游尚未合并时保留「等待上游 PR 合并」，且重启后仍等待。 |
| 自动唤醒与去重 | PR #24 合并到 `2d9f311` 后，工作台回读到合并状态并自动唤醒 #23 一次。审计依次记录合并、唤醒、新会话、检查通过和开 PR。 |
| 下游基于合并代码完成工单 | #23 的提交 `929ecc3` 直接基于 `2d9f311`，补了拆单入口拒绝重复前置依赖的回归断言。隔离容器检查通过后，工作台自动创建与 #23 关联的 [草稿 PR #26](https://github.com/DikkooXie/souflow/pull/26)，[GitHub CI](https://github.com/DikkooXie/souflow/actions/runs/44988558187) 通过。 |
| 合并与关闭工单 | PR #26 转正式评审后通过 Codex 评审与 CI，合入 [`c8435e9`](https://github.com/DikkooXie/souflow/commit/c8435e9354a325e5c0c988a74fd9aa40f8c23fa5)。[主干 CI](https://github.com/DikkooXie/souflow/actions/runs/45006735814) 通过，Issue #23 随合并关闭。 |
| 本机回归 | `SOULFLOW_TEST_NATIVE_CODEX=1 npm run check` 通过，共 67 项，零跳过。 |

![下游 #23 已认领，等待 #22 的 PR 合并](b5-delivery/01-downstream-waiting.png)

![工作台自动显示上游 PR #24 和通过的 GitHub CI](b5-delivery/02-upstream-ci.png)

![上游 PR #24 已合并，下游 #23 的关联 PR #26 和 CI 均已显示](b5-delivery/03-merged-wake.png)
