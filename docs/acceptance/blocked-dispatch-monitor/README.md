# 回查被拦截的工单

在隔离工作台用临时仓库生成一张代码工单。复核返回「缺少前置登录入口」，同一对话随后生成开发计划 v2。这个样例使用固定模型回执，浏览器访问实际运行的工作台。

- 调度面板显示旧 T1 为「批次拦截 · 未派发」。详情保留计划 v1，可以直接打开原对话。[工单详情](01-blocked-ticket.jpg)
- 在原对话打开「本地执行工单」，选择「编写代码」和 v1 历史批次。页面显示具体拦截原因，并保留新版计划入口。[批次历史](02-history-reason.jpg)
- `/api/dispatch-status` 的当前等待队列为空，历史记录仍有 v1 的 T1。回归测试同时确认原批次不能启动。

对应 [Issue #74](https://github.com/DikkooXie/souflow/issues/74)。接口回归位于 `tests/workbench-demo.test.mts`。
