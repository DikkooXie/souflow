# 维护者核验的运行验收证据

双机、截图或审计验收不能仅凭测试名称认定通过。维护者先核对实际结果，把可公开的材料放进受控本地目录，再配置 `SOULFLOW_GITHUB_VERIFICATION_EVIDENCE={"path":"/absolute/evidence/manifest.json","sha256":"清单文件的 SHA-256"}`。配置只在启动时读取；模型、PR 和 HTTP 请求均不能创建或批准此包。自定义启动入口可用同样的 `issueDelivery.verificationBundle` 配置。

清单使用以下结构；占位符不是验收数据，不能直接用作真实结论：

```json
{
  "version": 1,
  "repo": "owner/repository",
  "issue": 1,
  "issueRevision": "原批准 Issue 正文摘要",
  "pull": 2,
  "head": "原 PR 业务提交，40 位 SHA",
  "plan": {
    "id": "原计划 ID",
    "version": 1,
    "quality": { "policy": 1, "flowDigest": "原需求摘要", "batchDigest": "原批次摘要" }
  },
  "integration": "实际运行的集成提交，40 位 SHA",
  "observedAt": "实际执行时间，ISO 8601",
  "expiresAt": "本次证据有效期，ISO 8601",
  "verifiedBy": "核对事实的维护者",
  "environment": "实际机器、应用版本和运行方式的公开说明",
  "publicSafe": true,
  "files": [{ "path": "evidence/observations.md", "sha256": "文件 SHA-256" }],
  "results": [{
    "criterion": "AC-1",
    "criterionDigest": "该项原内容、验证步骤和预期的摘要",
    "outcome": "partial",
    "facts": "已验证的事实与仍未完成的步骤，引用实际结果，不填预期结果代替实测",
    "files": ["evidence/observations.md"]
  }]
}
```

`criterionDigest` 用 `src/workbench/trusted-verification.mts` 的 `verificationCriterionDigest` 对正常复核范围中的 `{ criterion, text, procedure, expected }` 计算。计划、质量摘要和验收条件均取原批准版本，不能自行改写。`integration` 必须是工作台可信本地 Git 仓库已有的提交，程序验证它的祖先包含业务 `head`。这只证明代码来源；实际运行、机器和结果由维护者根据原审计、提交与截图核对，不把 Git 关系冒充实测。

每个验收项只写一条结果。`pass` 表示维护者已核对完整步骤与预期；`partial` 保留实际的部分事实；`fail` 保留失败事实。后两者会进入复核材料，但即使模型引用其它带同一 AC 编号的普通测试，也不能将该项报成完整通过。没有列出的 AC 仍须有其它真实完整验证证据。两类模型复核仍独立判断，包内的 `pass` 不会直接写成复核通过。

材料路径相对清单目录，必须是无链接的普通文件，不能越出目录或指向隐藏目录。支持 `md/txt/json/png/jpg/jpeg/webp`，最多 16 个文件、单个 8 MiB、合计 32 MiB。`publicSafe: true` 表示维护者已检查全部材料可公开；程序不会替代图片隐私检查。模型只收到经过既有脱敏的事实、相对文件名和摘要，不收到原文件内容、图片或视频原件。

启动时固定清单及 SHA；页面状态使用文件元数据缓存，真正复核开始和返回后强制重验文件摘要、有效期与绑定。缺文件、篡改、过期、PR 提交或原计划/验收变化都会停用此证明，旧通过记录不再标为当前。失效包不会阻塞正常复核：新复核仍可用当前代码、规则和真实测试证据，缺少实际验收材料时如实拦截。补证后重新核验并更新清单及配置摘要，再重启工作台。同一业务头会因新包摘要产生一次新的正常复核；重复轮询和重启不会重复执行已完整取得的复核。回执保存包摘要、集成提交和有效期，旧回执只追加保留，可区分当前与历史；不手写成功回执、不修改原业务数据库。
