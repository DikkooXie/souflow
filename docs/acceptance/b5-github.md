# B5 GitHub 工单认领验收

本轮使用 macOS、Node.js 22.17.1、本机 Codex App Server 和公开仓库 `DikkooXie/souflow`。功能提交为 `4959196`。验收对象是[工单 #19](https://github.com/DikkooXie/souflow/issues/19)，交付记录见[PR #20](https://github.com/DikkooXie/souflow/pull/20)。

| 验收项 | 证据与状态 |
| --- | --- |
| 读取真实无人负责的 Issue | 两个已连接的 GitHub 账号分别回读同一张开放工单。工作台同步后显示 #19 的负责人为「未分配」。见下图。 |
| 关联交付 PR | 草稿 PR #20 使用关闭引用关联 #19。通过产品连接层回读到 PR 编号 20、状态 OPEN 和正确链接。认领后的工作台展示待实测。 |
| 重复派发、并发与恢复 | 本机运行 `SOULFLOW_TEST_NATIVE_CODEX=1 npm run check`，63 项测试通过。使用模拟工单源测试了两个实施成员竞争、同一请求重试、负责人冲突、回执丢失和重启。 |
| Codex 核验输入与输出 | 本机原生 App Server 接入回环模型，验证工具列表为空、外部正文作为工单资料传入、结构化清单能够回读。 |
| 两个 GitHub 写账号争抢同一张真实 Issue | 待验收。还需核对唯一负责人、一次本机模型执行、报告、工作台的关联 PR 和重启后的派发次数。 |

![两个独立登录环境之一在真实工作台看到无人负责的 Issue 19](b5/01-unassigned.png)
