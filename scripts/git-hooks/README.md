# 可选的暂存差异检查

从仓库根目录提交时可选用以下命令，检查暂存差异里的空白错误。

```sh
git -c core.hooksPath=scripts/git-hooks commit
```

该设置只作用于这一条命令。完整质量检查使用 `npm run check`。
