"""飞书与 Obsidian 交付同步，使用已核证事实及本机目标配置。"""
import hashlib
import json
import re
import tempfile
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlsplit


class DeliveryError(RuntimeError):
    pass


def digest(data):
    return hashlib.sha256(data).hexdigest()


def call(command, *args, cwd=None):
    response = json.loads(command("lark-cli", *args, "--as", "user", cwd=cwd))
    if response.get("ok") is not True:
        raise DeliveryError("飞书返回失败回执")
    return response["data"]


def document(command, url, scope, *args):
    return call(command, "docs", "+fetch", "--doc", url, "--scope", scope, "--detail", "full", *args)["document"]


def section_heading(outline, marker):
    headings = [node for node in ET.fromstring(outline["content"]).iter() if re.fullmatch(r"h[1-9]", node.tag)]
    matches = [node for node in headings if "".join(node.itertext()).strip().endswith(marker)]
    if len(matches) > 1:
        raise DeliveryError("飞书存在重复交付章节，需核对")
    return matches[0].get("id") if matches else None


def verify_document(command, section, expected_links, expected_images, temp, expected_summary=None):
    content = ET.fromstring(section["content"])
    links = {node.get("href") for node in content.iter("a")}
    images = list(content.iter("img"))
    paragraphs = ["".join(paragraph.itertext()).strip() for paragraph in content.iter("p")]
    if not expected_links <= links or not paragraphs or expected_summary is not None and expected_summary.strip() not in paragraphs:
        raise DeliveryError("飞书章节缺少交付链接或正文")
    if {image.get("name") for image in images} != set(expected_images) or len(images) != len(expected_images):
        raise DeliveryError("飞书章节的图片清单不完整")
    for index, image in enumerate(images):
        output = f"readback-{index}.png" if image.get("name", "").endswith(".png") else f"readback-{index}.jpg"
        call(command, "docs", "+media-download", "--token", image.attrib["src"], "--output", output, "--overwrite", cwd=temp)
        if digest((temp / output).read_bytes()) != expected_images[image.attrib["name"]]:
            raise DeliveryError("飞书验收图与合并版本不一致")


def sync_document(command, target, receipt, load_image, temp):
    url = target["url"]
    address = urlsplit(url)
    if (address.scheme != "https" or not re.fullmatch(r"[a-z0-9-]+\.(?:feishu\.cn|larksuite\.com)", address.netloc)
            or address.fragment or not re.fullmatch(r"/(?:wiki|docx)/[a-zA-Z0-9]+", address.path)):
        raise DeliveryError("飞书文档需要明确的原页地址")
    marker = f"（{receipt['merge']}）"
    heading = ET.Element("h1")
    heading.text = target["title"] + marker
    paragraph = ET.Element("p")
    paragraph.text = target["summary"]
    links = ET.Element("p")
    expected_links = {}
    for name, key in [("来源 PR", "pr"), ("主干 CI", "mainCI"), ("仓库验收", "evidence")]:
        if key in receipt:
            expected_links[receipt[key]] = name
            link = ET.SubElement(links, "a", href=receipt[key])
            link.text = name
            link.tail = " "
    nodes = [heading, paragraph, links]
    expected_images = {}
    for entry in target.get("screenshots", []):
        name = Path(entry["path"]).name
        if name in expected_images:
            raise DeliveryError("同一飞书章节的截图文件名须唯一")
        payload = load_image(entry["path"])
        (temp / name).write_bytes(payload)
        expected_images[name] = digest(payload)
        nodes.append(ET.Element("img", path=f"@./{name}", caption=entry["caption"]))

    outline = document(command, url, "outline")
    anchor = section_heading(outline, marker)
    if not anchor:
        body = "".join(ET.tostring(node, encoding="unicode") for node in nodes)
        (temp / "entry.xml").write_text(body, encoding="utf-8")
        call(command, "docs", "+update", "--doc", url, "--command", "append", "--doc-format", "xml",
             "--revision-id", str(outline["revision_id"]), "--content", "@./entry.xml", cwd=temp)
        anchor = section_heading(document(command, url, "outline"), marker)
    if not anchor:
        raise DeliveryError("无法回读飞书章节")
    section = document(command, url, "section", "--start-block-id", anchor)
    verify_document(command, section, set(expected_links), expected_images, temp, target["summary"])
    return {"url": f"{url}#{anchor}", "revision": section["revision_id"], "sha256": expected_images}


def cell_value(value):
    if isinstance(value, str):
        # 飞书 URL 类型的回读可能被包装为 [URL](URL)。
        wrapped = re.fullmatch(r"\[(https://[^\]]+)\]\(\1\)", value)
        if wrapped:
            return wrapped[1]
    return value


def sync_board(command, target, receipt, temp):
    table = ("--base-token", target["base"], "--table-id", target["table"], "--format", "json")
    record = target["record"]

    def get():
        data = call(command, "base", "+record-get", *table, "--record-id", record)
        if data["record_id_list"] != [record]:
            raise DeliveryError("飞书看板回读的记录不匹配")
        return data["rev"], dict(zip(data["fields"], map(cell_value, data["data"][0]), strict=True))

    rev, current = get()
    if not isinstance(current.get(target["identityField"]), str) or current[target["identityField"]] != target["identity"]:
        raise DeliveryError("飞书看板条目身份已变化")
    fields = {target["prField"]: receipt["pr"], target["evidenceField"]: receipt["docs"][0]["url"]}
    # 每个可写字段指定预期旧值，允许同一合并重试，保留其他成员的新修改。
    for name, value in fields.items():
        if name not in current or current[name] not in (cell_value(target["before"][name]), value):
            raise DeliveryError("飞书看板交付字段已由其他成员修改")
    def write(changes):
        payload = {"update_records": {record: changes}}
        (temp / "board.json").write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
        call(command, "base", "+record-batch-update", *table, "--json", "@./board.json", cwd=temp)

    changes = {name: value for name, value in fields.items() if current[name] != value}
    if changes:
        write(changes)
        rev, current = get()
    if any(current.get(name) != value for name, value in fields.items()):
        raise DeliveryError("飞书看板交付字段回读不一致")
    flow_field = target["flowField"]
    flow = current.get(flow_field)
    expected_flow = target["expectedFlow"]
    # 只在配置明确授权当前阶段向测试阶段推进时尝试写入；某些原生流程列需走看板内部动作。
    if (target.get("beforeFlow") == "需求开发中" and expected_flow == "需求测试中"
            and flow in ("需求开发中", ["需求开发中"])):
        try:
            write({flow_field: [expected_flow]})
        except DeliveryError:
            # 即使写入回执未知，仍按原字段读回结果决定状态。
            pass
        rev, current = get()
        flow = current.get(flow_field)
    if flow != expected_flow and flow != [expected_flow]:
        return {"state": "pending", "record": record, "revision": rev, "flow": flow, "expectedFlow": expected_flow}
    return {"state": "verified", "record": record, "revision": rev, "flow": flow}


def archive_receipt(command, target, receipt):
    vault = Path(target["vault"]).expanduser().resolve(strict=True)
    note = target["sourceNote"]
    if not re.fullmatch(r"wiki/sources/[a-z0-9-]+\.md", note) or (vault / note).resolve().relative_to(vault).as_posix() != note:
        raise DeliveryError("Obsidian 目标须为现有来源页")
    previous = (vault / note).read_bytes()
    merge = receipt["merge"]
    marker = f"## 合并回执 {merge}"
    now = datetime.now(timezone.utc)
    day = now.date().isoformat()
    pr_num = receipt["pr"].rsplit("/", 1)[-1]
    operation = f"ingest-souflow-pr{pr_num}-{merge}"
    raw = f".raw/captured/{operation}.json"
    core = str(Path(target["cli"]).expanduser().resolve(strict=True))
    if marker in previous.decode():
        archived = json.loads((vault / raw).read_bytes())
        if archived["merge"] != merge or archived["pr"] != receipt["pr"]:
            raise DeliveryError("已有 Obsidian 回执与本次交付不一致")
        command("python3", core, "lint", "--strict", "--as-of", day, "--vault", str(vault))
        return {"state": "verified", "note": note}
    raw_content = json.dumps(receipt, ensure_ascii=False, indent=2) + "\n"
    raw_sha = digest(raw_content.encode())
    links = [f"[PR #{pr_num}]({receipt['pr']})", f"[主干 CI]({receipt['mainCI']})"]
    links.extend(f"[飞书文档修订 {doc['revision']}]({doc['url']})" for doc in receipt["docs"])
    note_content = previous.decode().rstrip() + "\n\n" + marker + "\n\n"
    if receipt.get("board"):
        links.append(f"看板流程 {receipt['board']['flow']}（修订 {receipt['board']['revision']}）")
    note_content += "已核对合并与配置的同步目标。\n\n" + " · ".join(links) + f" · [回执]({(vault / raw).as_uri()})\n"
    expected = {note: digest(previous), raw: None}
    writes = [
        {"path": raw, "mode": "create", "content": raw_content, "sha256": raw_sha},
        {"path": note, "mode": "replace", "content": note_content, "sha256": digest(note_content.encode())},
    ]
    ledger = "wiki/meta/ledgers/source-ledger.json"
    ledger_before = (vault / ledger).read_bytes()
    sources = json.loads(ledger_before)
    source_id = "src-" + digest("\0".join(["file", raw, raw_sha]).encode())[:20]
    sources["generated_at"] = now.isoformat(timespec="seconds").replace("+00:00", "Z")
    sources["sources"][source_id] = {
        "title": f"souflow PR #{pr_num} 合并与发布回执", "content_kind": "document", "authority": "primary",
        "content_sha256": raw_sha, "independence_key": operation, "ingested_at": day, "retrieved_at": day,
        "origin": {"kind": "file", "locator": raw}, "pages": [note], "review_status": "active", "supersedes": None,
        "refresh_due": (now + timedelta(days=90)).date().isoformat(),
    }
    ledger_content = json.dumps(sources, ensure_ascii=False, indent=2) + "\n"
    expected[ledger] = digest(ledger_before)
    writes.append({"path": ledger, "mode": "replace", "content": ledger_content, "sha256": digest(ledger_content.encode())})
    bundle = {"schema": "claude-obsidian.transaction.v1", "operation_id": operation, "operation_type": "ingest",
              "expected_hashes": expected, "writes": writes, "address_requests": [],
              "source_manifest_updates": {raw: {"hash": raw_sha, "pages_created": [note]}}}
    with tempfile.TemporaryDirectory(prefix="souflow-wiki-") as directory:
        staged = Path(directory) / "bundle.json"
        staged.write_text(json.dumps(bundle, ensure_ascii=False), encoding="utf-8")
        opts = ("--vault", str(vault), str(staged))
        plan = json.loads(command("python3", core, "transaction", "inspect", *opts))
        if not plan["valid"]:
            raise DeliveryError("Obsidian 收录计划校验失败")
        command("python3", core, "transaction", "apply", "--approved-plan-sha256", plan["approval_sha256"], *opts)
    command("python3", core, "lint", "--strict", "--as-of", day, "--vault", str(vault))
    if marker not in (vault / note).read_text() or digest((vault / raw).read_bytes()) != raw_sha:
        raise DeliveryError("Obsidian 回执读回失败")
    return {"state": "verified", "note": note}
