# 两人团队的 GitHub 工作流

1. **定义工作。** 在 Issue 中描述一个可验收的结果、边界和依赖。已有 Soulflow 工单时引用其 ID 与计划版本；私密材料只放受控引用。两边使用同一组验收条件。
2. **隔离修改。** 从最新的主干创建短期分支，按下文命名。并行 Agent 各自使用分支和 worktree。先检查工作区改动，再分配文件和任务。有依赖的工单等待前置契约就绪。
3. **提交。** 按下文撰写提交信息。提交前检查暂存差异和本地验证结果。密钥、完整对话、原始日志、数据库与构建产物留在仓库外。
4. **开 PR。** 一个 PR 交付一个可独立审查和回退的变化，关联 Issue、行为证据、检查结果和回退办法。受影响的仓库文档随代码评审。协作分支通过追加提交处理评审意见。标记 Ready for review 前，作者复查完整差异。
5. **评审与合并。** 另一位有写权限的成员检查验收证据、模块边界、权限和数据影响。AI 审查可作辅助。所有必需检查通过、讨论已解决、最新差异获人工批准后，由另一位维护者 squash merge。PR 标题沿用 Conventional Commits，以便主干按交付单元回溯。
6. **验证、归档与回退。** 在工单关联 PR、合并 SHA、CI 运行和验收结果。按[文档收尾流程](docs/wiki-maintenance.md#每次交付的文档收尾)核对 Obsidian、仓库文档和飞书云文档，并报告三处状态。需要撤销时从主干开 revert PR；数据库或外部副作用按该 PR 载明的恢复步骤处置。修复也沿用短分支与人工评审。

## 为分支命名

按分支的主要变更选择前缀。新增功能用 `feat/`，修复缺陷用 `fix/`，其余按用途用 `docs/`、`refactor/`、`test/`、`chore/`、`style/` 或 `perf/`。分支名用小写短词和连字符。有关联 Issue 时带上编号，例如 `feat/42-decision-inbox`。没有编号时可用 `feat/app-server-runner-spike`。

## 撰写提交信息

- 每个提交包含一个可独立审查的逻辑变更。行为改动及其回归测试放在同一提交，独立重构或依赖升级单独提交。
- 首行用 `<type>(<scope>): <summary>`。类型反映该提交的用途，范围可省略，摘要用简短的动词短语说明改动，例如 `feat(decisions): route answers to their originating session`。
- 需要补充背景时，在首行后空一行，用正文说明改动动机、验证结果和已知限制。有关联 Issue 时可用 `Refs: #42`。破坏性变更用 `!` 或 `BREAKING CHANGE:` 标记，并说明兼容性影响。 [Conventional Commits 1.0.0](https://www.conventionalcommits.org/en/v1.0.0/)

## 本地验证

使用 Node 22.17.1，在仓库根目录运行 `npm ci --ignore-scripts` 和 `npm run check`。CI 在 Linux 使用相同入口。按[质量规范](docs/engineering-quality.md)为本次变化选择额外的契约、集成或界面验证，在 PR 中逐项关联证据。

## 仓库管理员设置

空仓库先由有权限的维护者按团队约定建立初始默认分支。随后保护 `main`，要求 PR、一位独立批准人、解决评审讨论、影响差异的提交后重新批准，禁用强推和删除，规则覆盖管理员。在质量检查已实际运行、名称稳定后，将其设为必需检查。引入构建产物时将构建加入检查；接口或数据变更加入相应契约或迁移验证。

GitHub 对私有仓库分支保护的支持取决于套餐。检查实际仓库设置后记录生效情况；人工遵守与平台强制分别说明。[GitHub 分支保护说明](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches)
