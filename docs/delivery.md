# 交付与收尾

Issue 记录目标，PR 记录当前差异和验收，GitHub 回执记录合并。只有影响产品行为、权限、共享契约或验收的疑问才需要先找人确认。授权覆盖的本地实现、验证和草稿 PR 可以连续完成。

## 主干保护

仓库管理员先核对已有规则和 `Quality` workflow 的 `check`，再启用 [main 规则配置](../.github/rulesets/main.json)。它要求 PR、GitHub Actions 的检查、独立批准及解决讨论，并禁止强推、删除和绕过。批准对应最新可评审的提交。管理规则和自动删除分支需要仓库管理员权限。

```sh
gh api repos/DikkooXie/souflow/rules/branches/main
gh api --method POST repos/DikkooXie/souflow/rulesets --input .github/rulesets/main.json
gh api --method PATCH repos/DikkooXie/souflow -F delete_branch_on_merge=true
gh api repos/DikkooXie/souflow/rules/branches/main
gh api repos/DikkooXie/souflow --jq .delete_branch_on_merge
```

重复配置前核对已有同名规则，选择更新原规则。PR 合并后本地仍可核对任务分支。

## 低风险合并试点

先用 `python3 -B scripts/delivery.py pilot 26` 查看资格。治理配置生效后，经授权者可给调用加 `--apply`。入口只接受同仓库指向 `main` 的非草稿 PR，差异只含验收文档或追加回归测试。GitHub 必须确认最新差异已获独立批准并可合并，命令以该提交 SHA 执行 squash merge。涉及权限、调度、CI 或生产状态的代码改动仍走普通评审。

试点先把批准与点击合并分开。团队如需免逐单批准，要再确定适用范围和可由平台执行的策略。已经开放的 #26 不会被预览命令合并。

## 合并后收尾

```sh
python3 -B scripts/delivery.py closeout 25
python3 -B scripts/delivery.py closeout 25 --config .souflow/delivery.local.json --apply
```

默认预览读取真实的合并提交和主干 CI。写入使用可信本机 JSON，配置从命令或 `SOULFLOW_DELIVERY_CONFIG` 指定，并绑定仓库与 PR。可选项目按需填写。用已合并提交中的截图和 Markdown，收尾不会把未提交的工作区变动发布出去。

```json
{
  "repo": "DikkooXie/souflow",
  "pr": 25,
  "cleanup": true,
  "evidence": "docs/acceptance/example.md",
  "docs": [
    {
      "url": "https://team.feishu.cn/wiki/DocId",
      "title": "交付验收",
      "summary": "本轮通过的行为及边界。",
      "screenshots": [
        {"path": "docs/acceptance/example/result.png", "caption": "验收页面和结果"}
      ]
    }
  ],
  "board": {
    "base": "baseId",
    "table": "tableId",
    "record": "recordId",
    "identityField": "需求名称",
    "identity": "[B5] 需求名称",
    "prField": "关联 PR",
    "evidenceField": "验收证据",
    "before": {"关联 PR": null, "验收证据": null},
    "flowField": "流程",
    "beforeFlow": "需求开发中",
    "expectedFlow": "需求测试中"
  },
  "obsidian": {
    "vault": "/path/to/souflow_knowledge",
    "sourceNote": "wiki/sources/souflow-b5-github-trial.md",
    "cli": "/path/to/claude-obsidian.py"
  }
}
```

- **分支**。仅清理同仓库合入的任务分支。分支产生新提交、被 worktree 使用或合并树对不上时，返回待核对。
- **飞书**。以合并 SHA 定位原页章节，重试时复用。核对回读链接和修订，下载截图并比对 SHA-256。看板回读记录身份与旧值后写入 PR 和证据链接。配置 `beforeFlow` 后，可在旧阶段匹配时将需求推进至测试。部分原生流程需要飞书工作流或界面动作，读回未到目标时入口返回待处理状态。团队验收仍由负责人确认。
- **Obsidian**。在配置的同步目标回读通过后，用已有 LLM Wiki 工具将精简回执追加到现有来源页并登记原件。没有可复用证据的交付可省略此项。

## 为什么这样做

Anthropic 建议把仓库特有知识和验证入口留在短规则里，可执行的约束交给权限、hook 或 CI。OpenAI 建议为强模型删除过细步骤，以按需链接、完成条件和权限边界替代。souflow 用 GitHub 规则约束合并，用 CI 验证行为，用可重试的命令同步证据。
[Claude Code 官方最佳实践](https://code.claude.com/docs/en/best-practices) · [OpenAI 的 GPT-6 Astra 实践](https://developers.openai.com/blog/rethinking-skills-and-prompts-for-gpt-6-astra) · [GitHub Rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets)
