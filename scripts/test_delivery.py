import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from delivery import RULESET, clean_branch, closeout, pilot_reasons
from delivery_sync import DeliveryError, sync_board, sync_document

HEAD = "1" * 40
MERGE = "2" * 40
PR = {"state": "OPEN", "isDraft": False, "isCrossRepository": False, "baseRefName": "main",
      "mergeStateStatus": "CLEAN", "reviewDecision": "APPROVED"}
RECEIPT = {"pr": "https://github.com/a/b/pull/4", "mainCI": "https://github.com/a/b/actions/runs/1", "merge": MERGE}


class DeliveryTest(unittest.TestCase):
    def test_pilot_blocks_drafts_unprotected_main_and_policy_edits(self):
        policy = json.loads((Path(__file__).resolve().parents[1] / RULESET).read_text())
        test = {"filename": "tests/app.test.mts", "status": "modified", "additions": 2, "deletions": 0}
        self.assertEqual(pilot_reasons(PR, policy["rules"], [test], policy), [])
        self.assertTrue(pilot_reasons({**PR, "isDraft": True}, policy["rules"], [test], policy))
        self.assertTrue(pilot_reasons({**PR, "reviewDecision": ""}, policy["rules"], [test], policy))
        self.assertTrue(pilot_reasons(PR, policy["rules"][:-1], [test], policy))
        for other in [{"deletions": 1}, {"filename": "docs/acceptance/AGENTS.md"}, {"filename": ".github/workflows/quality.yml"}]:
            self.assertTrue(pilot_reasons(PR, policy["rules"], [dict(test, **other)], policy))

    def test_closeout_does_not_write_before_main_ci_and_config_are_valid(self):
        pr = {**PR, "state": "MERGED", "headRefOid": HEAD, "mergeCommit": {"oid": MERGE}, "url": RECEIPT["pr"]}
        with patch("delivery.command") as command, patch("delivery.gh") as gh:
            gh.return_value = [{"conclusion": "failure"}]
            with self.assertRaisesRegex(DeliveryError, "主干 Quality"):
                closeout(Path("."), "a/b", 4, pr, {}, True)
            gh.return_value = [{"conclusion": "success", "url": RECEIPT["mainCI"]}]
            with self.assertRaisesRegex(DeliveryError, "绑定"):
                closeout(Path("."), "a/b", 4, pr, {"repo": "other/repo", "pr": 4}, True)
            result = closeout(Path("."), "a/b", 4, pr, {"repo": "a/b", "pr": 4}, False)
            self.assertEqual(result["mode"], "preview")
            command.assert_not_called()

    def test_cleanup_verifies_squash_tree_and_leaves_active_worktree(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "repo"
            remote = Path(directory) / "remote"
            subprocess.run(["git", "init", "-q", "--bare", str(remote)], check=True)
            subprocess.run(["git", "init", "-q", "-b", "main", str(root)], check=True)

            def git(*args):
                return subprocess.check_output(["git", "-c", "user.name=Test", "-c", "user.email=test@example.test",
                                                "-C", str(root), *args], stderr=subprocess.DEVNULL).decode().strip()

            git("remote", "add", "origin", str(remote))
            git("commit", "--allow-empty", "-m", "base")
            git("switch", "-c", "test/one")
            (root / "sample").write_text("change")
            git("add", "sample")
            git("commit", "-m", "test")
            git("push", "origin", "test/one")
            head = git("rev-parse", "HEAD")
            pr = {**PR, "headRefName": "test/one", "headRefOid": head}
            self.assertEqual(clean_branch(root, pr, MERGE)["state"], "pending")
            git("switch", "main")
            git("merge", "--squash", "test/one")
            git("commit", "-m", "squashed")
            merge = git("rev-parse", "HEAD")
            self.assertEqual(clean_branch(root, {**pr, "headRefOid": HEAD}, merge)["state"], "pending")
            self.assertEqual(clean_branch(root, pr, merge), {"state": "cleaned", "local": True, "remote": True})
            self.assertEqual(clean_branch(root, pr, merge)["state"], "absent")

    def test_document_retry_reuses_merged_section_and_checks_image_bytes(self):
        target = {"url": "https://team.feishu.cn/wiki/Document", "title": "验收", "summary": "实测通过",
                  "screenshots": [{"path": "docs/acceptance/result.png", "caption": "验收页面"}]}
        payload = b"image fixture"
        writes = 0
        section = '<fragment><p>实测通过</p><a href="' + RECEIPT["pr"] + '"/><a href="' + RECEIPT["mainCI"]
        section += '"/><img name="result.png" src="token"/></fragment>'

        def command(_cli, _kind, action, *args, cwd=None):
            nonlocal writes
            if action == "+update":
                writes += 1
                self.assertIn("（" + MERGE + "）", (cwd / "entry.xml").read_text())
                return b'{"ok":true,"data":{}}'
            if action == "+media-download":
                (cwd / "readback-0.png").write_bytes(payload)
                return b'{"ok":true,"data":{}}'
            scope = args[args.index("--scope") + 1]
            if scope == "outline":
                content = f'<fragment><h1 id="one">验收（{MERGE}）</h1></fragment>' if writes else "<fragment/>"
            else:
                content = section
            return json.dumps({"ok": True, "data": {"document": {"content": content, "revision_id": 3}}})

        with tempfile.TemporaryDirectory() as directory:
            tmp = Path(directory)
            first = sync_document(command, target, RECEIPT, lambda _: payload, tmp)
            again = sync_document(command, target, RECEIPT, lambda _: payload, tmp)
            self.assertEqual(first, again)
            self.assertEqual(writes, 1)
            with self.assertRaisesRegex(DeliveryError, "验收图"):
                sync_document(command, target, RECEIPT, lambda _: b"changed", tmp)

    def test_board_does_not_claim_workflow_advanced_without_readback(self):
        target = {"base": "base", "table": "table", "record": "record", "identityField": "name", "identity": "Issue",
                  "prField": "pr", "evidenceField": "proof", "before": {"pr": None, "proof": None},
                  "flowField": "flow", "expectedFlow": "需求测试中"}
        receipt = {**RECEIPT, "docs": [{"url": "https://team.feishu.cn/wiki/Document#one"}]}
        row = {"name": "Issue", "pr": None, "proof": None, "flow": ["需求开发中"]}
        updates = []
        supports_flow = False

        def command(_cli, _kind, action, *args, cwd=None):
            if action == "+record-batch-update":
                update = json.loads((cwd / "board.json").read_text())["update_records"]["record"]
                updates.append(update)
                row.update({key: value for key, value in update.items() if key != "flow" or supports_flow})
            return json.dumps({"ok": True, "data": {"rev": 2, "record_id_list": ["record"],
                               "fields": list(row), "data": [list(row.values())]}})

        with tempfile.TemporaryDirectory() as directory:
            tmp = Path(directory)
            self.assertEqual(sync_board(command, target, receipt, tmp)["state"], "pending")
            self.assertEqual(len(updates), 1)
            self.assertNotIn("flow", updates[0])
            target["beforeFlow"] = "需求开发中"
            self.assertEqual(sync_board(command, target, receipt, tmp)["state"], "pending")
            supports_flow = True
            self.assertEqual(sync_board(command, target, receipt, tmp)["state"], "verified")
            self.assertEqual(len(updates), 3)
            self.assertEqual(sync_board(command, target, receipt, tmp)["state"], "verified")
            self.assertEqual(len(updates), 3)
            row["pr"] = "manual edit"
            with self.assertRaisesRegex(DeliveryError, "其他成员"):
                sync_board(command, target, receipt, tmp)
