#!/usr/bin/env python3
"""从可信本机工作区核对合并、清理任务分支和同步交付证据。"""
import argparse
import json
import re
import subprocess
import tempfile
from pathlib import Path

from delivery_sync import DeliveryError, archive_receipt, sync_board, sync_document

SHA = re.compile(r"[a-f0-9]{40}")
RULESET = ".github/rulesets/main.json"
CONFIG = "SOULFLOW_DELIVERY_CONFIG"


def command(*args, cwd=None, allow_failure=False):
    result = subprocess.run(args, cwd=cwd, capture_output=True, check=False, timeout=90)
    if result.returncode == 0:
        return result.stdout
    if allow_failure:
        return None
    # 返回命令类别，避免把外部响应中的凭据或内部正文写进日志。
    raise DeliveryError(f"{args[0]} 操作失败（{result.returncode}）")


def github_repo(url):
    match = re.fullmatch(r"(?:https://github\.com/|git@github\.com:|ssh://git@github\.com/)([\w.-]+/[\w.-]+?)(?:\.git)?", url)
    return match[1] if match else None


def checkout():
    root = Path(command("git", "rev-parse", "--show-toplevel").decode().strip())
    url = command("git", "remote", "get-url", "origin", cwd=root).decode().strip()
    repo = github_repo(url)
    if repo is None:
        raise DeliveryError("origin 必须指向 GitHub 仓库")
    return root, repo


def gh(*args):
    return json.loads(command("gh", *args))


def read_pr(repo, number):
    pr = gh("pr", "view", str(number), "--repo", repo, "--json",
            "baseRefName,headRefName,headRefOid,isCrossRepository,isDraft,mergeCommit,mergeStateStatus,reviewDecision,state,url")
    if not (SHA.fullmatch(pr["headRefOid"]) and pr["url"].lower() == f"https://github.com/{repo}/pull/{number}".lower()):
        raise DeliveryError("PR 与当前仓库或提交不匹配")
    return pr


def live_rules(repo, branch):
    return gh("api", f"repos/{repo}/rules/branches/{branch}")


def pilot_reasons(pr, rules, files, expected_rules):
    expected = {rule["type"]: rule.get("parameters", {}) for rule in expected_rules["rules"]}
    actual = {rule["type"]: rule.get("parameters", {}) for rule in rules}
    reasons = []
    if pr["state"] != "OPEN" or pr["isDraft"] or pr["isCrossRepository"] or pr["baseRefName"] != "main":
        reasons.append("需要同仓库指向 main 的非草稿开放 PR")
    if pr["mergeStateStatus"] != "CLEAN" or pr["reviewDecision"] != "APPROVED":
        reasons.append("GitHub 仍缺最新提交的合并条件或独立批准")
    def includes(rule_type):
        return rule_type in actual and all(actual[rule_type].get(key) == value
                                           for key, value in expected[rule_type].items())
    if not all(includes(rule_type) for rule_type in expected):
        reasons.append("main 未生效所需的检查、独立批准或保护规则")
    if not files or any(
        row["status"] not in {"added", "modified"} or row["deletions"] or not row["additions"]
        or Path(row["filename"]).name in {"AGENTS.md", "AGENTS.override.md"}
        or not re.fullmatch(r"(?:tests/[\w./-]+\.test\.mts|docs/acceptance/[\w./-]+\.md)", row["filename"])
        for row in files
    ):
        reasons.append("试点仅包含新增文档或追加回归测试，且没有其他文件变化")
    return reasons


def pilot(root, repo, number, pr, apply):
    files = gh("api", "--paginate", "--slurp", f"repos/{repo}/pulls/{number}/files?per_page=100")
    rules = json.loads((root / RULESET).read_text())
    reasons = pilot_reasons(pr, live_rules(repo, "main"), [item for page in files for item in page], rules)
    if reasons or not apply:
        return {"head": pr["headRefOid"], "eligible": not reasons, "reasons": reasons}
    command("gh", "pr", "merge", str(number), "--repo", repo, "--squash", "--match-head-commit", pr["headRefOid"])
    result = read_pr(repo, number)
    if result["state"] != "MERGED":
        raise DeliveryError("GitHub 尚未确认合并")
    return {"head": result["headRefOid"], "merge": result["mergeCommit"]["oid"]}


def clean_branch(root, pr, merge):
    branch, head = pr["headRefName"], pr["headRefOid"]
    ref = f"refs/heads/{branch}"
    if pr["isCrossRepository"] or not re.fullmatch(r"(?:feat|fix|docs|refactor|test|chore|style|perf)/[a-z0-9][a-z0-9/-]*", branch):
        return {"state": "skipped", "reason": "不是同仓库任务分支"}

    def git(*args, allow_failure=False):
        return command("git", *args, cwd=root, allow_failure=allow_failure)

    entries = git("worktree", "list", "--porcelain").decode().splitlines()
    local = git("rev-parse", "--verify", ref, allow_failure=True)
    remote = git("ls-remote", "--heads", "origin", ref).decode().strip()
    if (local and local.decode().strip() != head) or (remote and remote != f"{head}\t{ref}"):
        return {"state": "pending", "reason": "任务分支存在其他提交"}
    if not local and not remote:
        return {"state": "absent"}
    if local and f"branch {ref}" in entries:
        return {"state": "pending", "reason": "任务分支仍被工作区使用"}
    merged_tree = git("rev-parse", f"{merge}^{{tree}}").strip()
    expected = git("merge-tree", "--write-tree", f"{merge}^1", head, allow_failure=True)
    if expected is None or expected.strip() != merged_tree:
        return {"state": "pending", "reason": "合并树无法与任务分支核对"}
    if remote:
        fetch_url = git("remote", "get-url", "origin").decode().strip()
        push_urls = git("remote", "get-url", "--push", "--all", "origin").decode().splitlines()
        repo = github_repo(fetch_url)
        allowed_urls = [url for url in push_urls if url == fetch_url or
                        repo and (github_repo(url) or "").lower() == repo.lower()]
        if len(push_urls) != 1 or allowed_urls != push_urls:
            return {"state": "pending", "reason": "origin 的推送目标与已核对仓库不一致"}
        # 使用核对后的单一目标，删除条件同时绑定已合并的远端 SHA。
        git("-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential",
            "push", f"--force-with-lease={ref}:{head}", push_urls[0], f":{ref}")
    if local:
        # 再核对工作区，保留其他成员在飞行中的任务分支。
        if f"branch {ref}" in git("worktree", "list", "--porcelain").decode().splitlines():
            return {"state": "pending", "reason": "任务分支已被工作区使用", "remote": bool(remote)}
        git("update-ref", "-d", ref, head)
    return {"state": "cleaned", "local": bool(local), "remote": bool(remote)}


def artifact(root, merge, path, pattern):
    if not re.fullmatch(pattern, path) or ".." in Path(path).parts:
        raise DeliveryError("证据必须来自合并提交中的验收目录")
    return command("git", "show", f"{merge}:{path}", cwd=root)


def closeout(root, repo, number, pr, config, apply):
    merge = (pr.get("mergeCommit") or {}).get("oid", "")
    if pr["state"] != "MERGED" or pr["baseRefName"] != "main" or not SHA.fullmatch(merge):
        raise DeliveryError("GitHub 未确认此 PR 合入 main")
    runs = gh("run", "list", "--repo", repo, "--workflow", "quality.yml", "--branch", "main", "--event", "push",
              "--commit", merge, "--json", "conclusion,url", "--limit", "1")
    if not runs or runs[0]["conclusion"] != "success":
        raise DeliveryError("合并提交的主干 Quality 尚未通过")
    receipt = {"pr": pr["url"], "head": pr["headRefOid"], "merge": merge, "mainCI": runs[0]["url"]}
    if config and (config.get("repo", "").lower() != repo.lower() or config.get("pr") != number):
        raise DeliveryError("收尾配置必须绑定当前仓库和 PR")
    if "board" in config and not config.get("docs"):
        raise DeliveryError("看板同步需要配置飞书证据原页")
    if not apply:
        return {**receipt, "mode": "preview", "cleanup": bool(config.get("cleanup")),
                "documents": len(config.get("docs", [])), "board": bool(config.get("board")), "obsidian": bool(config.get("obsidian"))}
    # 远端主干可能已从另一工作区更新，证据和分支验证均使用刚读取的主干。
    command("git", "fetch", "origin", "main", cwd=root)
    command("git", "merge-base", "--is-ancestor", merge, "FETCH_HEAD", cwd=root)
    evidence = config.get("evidence")
    if evidence:
        artifact(root, merge, evidence, r"docs/acceptance/[\w./-]+\.md")
        receipt["evidence"] = f"https://github.com/{repo}/blob/{merge}/{evidence}"
    receipt["branches"] = clean_branch(root, pr, merge) if config.get("cleanup") else {"state": "skipped"}
    with tempfile.TemporaryDirectory(prefix="souflow-delivery-") as directory:
        temp = Path(directory)
        # 仅上传合并提交中的原图，工作区未提交文件不会成为证据。
        def load_image(path):
            return artifact(root, merge, path, r"docs/acceptance/[\w./-]+\.(?:png|jpg|jpeg)")
        receipt["docs"] = [sync_document(command, dest, receipt.copy(), load_image, temp)
                           for dest in config.get("docs", [])]
        if "board" in config:
            receipt["board"] = sync_board(command, config["board"], receipt, temp)
    if any(rec.get("state") == "pending" for rec in (receipt["branches"], receipt.get("board", {}))):
        return receipt
    if "obsidian" in config:
        receipt["obsidian"] = archive_receipt(command, config["obsidian"], receipt)
    return receipt


def main():
    import os

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=["closeout", "pilot"])
    parser.add_argument("pr", type=int)
    parser.add_argument("--config", type=Path, default=os.environ.get(CONFIG))
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    if args.pr <= 0:
        parser.error("PR 编号应为正整数")
    try:
        root, repo = checkout()
        pr = read_pr(repo, args.pr)
        if args.operation == "pilot":
            result = pilot(root, repo, args.pr, pr, args.apply)
        else:
            if args.apply and not args.config:
                raise DeliveryError("写入前请提供可信本机交付配置")
            config = json.loads(args.config.read_text()) if args.config else {}
            result = closeout(root, repo, args.pr, pr, config, args.apply)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        if args.apply and (result.get("eligible") is False or
                           any(result.get(key, {}).get("state") == "pending" for key in ("branches", "board"))):
            return 1
        return 0
    except (DeliveryError, OSError, ValueError, KeyError, subprocess.TimeoutExpired) as error:
        parser.exit(1, f"交付失败：{error}\n")


if __name__ == "__main__":
    raise SystemExit(main())
