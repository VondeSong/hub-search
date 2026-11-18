"""Immutable, explicitly exported desktop results. Never executes uploaded files."""
import base64
import binascii
import hashlib
import json
import re
import time
from contextlib import closing
from datetime import datetime

MAX_FILE = 10 * 1024**2
MAX_TOTAL = 50 * 1024**2
TYPES = {"md", "csv", "json", "xlsx", "pdf", "png", "svg"}
HASH = re.compile(r"[0-9a-f]{64}\Z")
IDENTITY = re.compile(r"[A-Za-z0-9_-]{1,150}\Z")


class Error(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status


def digest(data):
    return hashlib.sha256(data).hexdigest()


def text(value, limit):
    return isinstance(value, str) and bool(value.strip()) and len(value.encode("utf-8")) <= limit


def validate(value):
    try:
        if not isinstance(value, dict) or set(value) != {"version", "title", "origin", "files", "report"} or type(value["version"]) is not int or value["version"] != 1:
            raise ValueError()
        if not text(value["title"], 240):
            raise ValueError()
        origin, files, report = value["origin"], value["files"], value["report"]
        if (not isinstance(origin, dict) or set(origin) != {"workId", "artifactId", "executionId", "revision", "generatedAt", "inputs"}
                or any(not isinstance(origin[k], str) or not IDENTITY.fullmatch(origin[k]) for k in ("workId", "artifactId", "executionId"))
                or type(origin["revision"]) is not int or not 1 <= origin["revision"] <= 1000000
                or not text(origin["generatedAt"], 80) or datetime.fromisoformat(origin["generatedAt"].replace("Z", "+00:00")).tzinfo is None
                or not isinstance(origin["inputs"], list) or not 1 <= len(origin["inputs"]) <= 16):
            raise ValueError()
        for source in origin["inputs"]:
            if (not isinstance(source, dict) or set(source) != {"title", "sha256"} or not text(source["title"], 300)
                    or not isinstance(source["sha256"], str) or not HASH.fullmatch(source["sha256"])):
                raise ValueError()
        if not isinstance(files, list) or not 1 <= len(files) <= 16:
            raise ValueError()
        for file in files:
            if not isinstance(file, dict) or set(file) != {"name", "type", "bytes", "sha256"}:
                raise ValueError()
            name = file["name"]
            if (not text(name, 200) or re.search(r"[\\/:\x00-\x1f<>\"|?*]", name) or name.endswith((" ", ".")) or name.startswith(".")
                    or file["type"] not in TYPES or not name.endswith("." + file["type"])
                    or re.fullmatch(r"(?i)(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?", name)
                    or type(file["bytes"]) is not int or not 0 < file["bytes"] <= MAX_FILE
                    or not isinstance(file["sha256"], str) or not HASH.fullmatch(file["sha256"])):
                raise ValueError()
        if sum(f["bytes"] for f in files) > MAX_TOTAL or len({f["name"].casefold() for f in files}) != len(files):
            raise ValueError()
        if (not isinstance(report, dict) or set(report) != {"name", "text", "sha256"} or not text(report["text"], 48000)
                or digest(report["text"].encode()) != report["sha256"]
                or not any(f["name"] == report["name"] and f["type"] == "md" and f["sha256"] == report["sha256"]
                           and f["bytes"] == len(report["text"].encode()) for f in files)):
            raise ValueError()
    except (KeyError, TypeError, ValueError, UnicodeError, OverflowError):
        raise Error(400, "交接清单无效。请选择有效版本、1–16 个成果和一份不超过 48 KB 的 Markdown 报告；单文件最多 10 MiB，合计最多 50 MiB。") from None
    return value


class Repository:
    def __init__(self, store):
        self.store = store
        with closing(store.connect()) as db, db:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS handoffs (
                    id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, manifest TEXT NOT NULL,
                    state TEXT NOT NULL CHECK(state IN ('uploading','published','withdrawn')),
                    created INTEGER NOT NULL, published INTEGER
                );
                CREATE TABLE IF NOT EXISTS handoff_files (
                    handoff TEXT NOT NULL REFERENCES handoffs(id), sha256 TEXT NOT NULL, data BLOB NOT NULL,
                    PRIMARY KEY(handoff,sha256)
                );
            """)

    def read(self, identity):
        with closing(self.store.connect()) as db:
            return self._read(db, identity)

    def drafts(self):
        with closing(self.store.connect()) as db:
            return [{"id": r["id"], "title": json.loads(r["manifest"])["title"], "createdAt": r["created"]}
                    for r in db.execute("SELECT id,manifest,created FROM handoffs WHERE state='uploading' ORDER BY created")]

    def _read(self, db, identity):
        row = db.execute("SELECT * FROM handoffs WHERE id=?", (identity,)).fetchone()
        if row is None:
            raise Error(404, "尚未找到这份交接。")
        manifest = json.loads(row["manifest"])
        uploaded = {r[0] for r in db.execute("SELECT sha256 FROM handoff_files WHERE handoff=?", (identity,))}
        return {"id": identity, "thread": identity, "state": row["state"], "createdAt": row["created"],
                "publishedAt": row["published"], "manifest": manifest,
                "missing": [f["sha256"] for f in manifest["files"] if f["sha256"] not in uploaded] if row["state"] == "uploading" else []}

    def prepare(self, identity, data):
        if not isinstance(data, dict) or set(data) != {"manifest"}:
            raise Error(400, "缺少交接清单。")
        manifest = validate(data["manifest"])
        payload = json.dumps(manifest, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        fingerprint = digest(payload.encode())
        with closing(self.store.connect()) as db, db:
            db.execute("BEGIN IMMEDIATE")
            old = db.execute("SELECT fingerprint,state FROM handoffs WHERE id=?", (identity,)).fetchone()
            if old:
                if old["fingerprint"] != fingerprint:
                    raise Error(409, "该交接编号已用于另一份内容，不能覆盖。")
                if old["state"] == "withdrawn":
                    raise Error(409, "这份云端交接已撤回，不能用旧编号重新上传。")
            else:
                if db.execute("SELECT 1 FROM threads WHERE id=?", (identity,)).fetchone():
                    raise Error(409, "交接编号与已有对话冲突。")
                pending = db.execute("SELECT count(*) FROM handoffs WHERE state='uploading'").fetchone()[0]
                reserved = sum(sum(f["bytes"] for f in json.loads(r[0])["files"])
                               for r in db.execute("SELECT manifest FROM handoffs WHERE state<>'withdrawn'"))
                if pending >= 8 or reserved + sum(f["bytes"] for f in manifest["files"]) > 512 * 1024**2:
                    raise Error(429, "云端交接存储已达本期上限，请撤回不再需要的交接后重试。")
                db.execute("INSERT INTO handoffs VALUES(?,?,?,'uploading',?,NULL)",
                           (identity, fingerprint, payload, int(time.time() * 1000)))
            return self._read(db, identity)

    def upload(self, identity, sha256, data):
        if (not isinstance(data, dict) or set(data) != {"data"} or not isinstance(data["data"], str)
                or len(data["data"]) > ((MAX_FILE + 2) // 3) * 4):
            raise Error(413, "单文件内容超限或格式无效。")
        try:
            raw = base64.b64decode(data["data"], validate=True)
        except (ValueError, binascii.Error):
            raise Error(400, "文件编码无效。") from None
        if digest(raw) != sha256:
            raise Error(400, "文件哈希不一致，未保存。")
        with closing(self.store.connect()) as db, db:
            db.execute("BEGIN IMMEDIATE")
            snapshot = self._read(db, identity)
            expected = [f for f in snapshot["manifest"]["files"] if f["sha256"] == sha256]
            if snapshot["state"] == "withdrawn" or not expected or any(f["bytes"] != len(raw) for f in expected):
                raise Error(409, "文件不在有效交接清单中。")
            old = db.execute("SELECT data FROM handoff_files WHERE handoff=? AND sha256=?", (identity, sha256)).fetchone()
            if old and old[0] != raw:
                raise Error(409, "原文件内容冲突，未覆盖。")
            if not old:
                if snapshot["state"] != "uploading":
                    raise Error(409, "已发布的交接缺少文件，请检查存储；不能静默补写。")
                db.execute("INSERT INTO handoff_files VALUES(?,?,?)", (identity, sha256, raw))
            return self._read(db, identity)

    def commit(self, identity):
        with closing(self.store.connect()) as db, db:
            db.execute("BEGIN IMMEDIATE")
            snapshot = self._read(db, identity)
            if snapshot["state"] == "withdrawn":
                raise Error(409, "交接已撤回。")
            if snapshot["missing"]:
                raise Error(409, "文件尚未传完，手机暂时不会显示未完成的成果。")
            for row in db.execute("SELECT sha256,data FROM handoff_files WHERE handoff=?", (identity,)):
                if digest(row["data"]) != row["sha256"]:
                    raise Error(409, "云端文件回读校验失败，未发布。")
            if snapshot["state"] == "uploading":
                now = int(time.time() * 1000)
                if db.execute("SELECT 1 FROM threads WHERE id=?", (identity,)).fetchone():
                    raise Error(409, "交接编号与已有对话冲突。")
                db.execute("INSERT INTO threads(id,title,updated) VALUES(?,?,?)", (identity, snapshot["manifest"]["title"][:80], now))
                db.execute("UPDATE handoffs SET state='published',published=? WHERE id=?", (now, identity))
            return self._read(db, identity)

    def download(self, identity, sha256):
        with closing(self.store.connect()) as db:
            snapshot = self._read(db, identity)
            if snapshot["state"] != "published":
                raise Error(409, "这份成果尚未发布或已撤回。")
            row = db.execute("SELECT data FROM handoff_files WHERE handoff=? AND sha256=?", (identity, sha256)).fetchone()
            expected = next((f for f in snapshot["manifest"]["files"] if f["sha256"] == sha256), None)
            if row is None or not expected or len(row[0]) != expected["bytes"] or digest(row[0]) != sha256:
                raise Error(409, "成果回读校验失败，请检查云端存储。")
            return {"sha256": sha256, "bytes": len(row[0]), "data": base64.b64encode(row[0]).decode()}

    def withdraw(self, identity):
        with closing(self.store.connect()) as db, db:
            db.execute("BEGIN IMMEDIATE")
            snapshot = self._read(db, identity)
            if db.execute("SELECT 1 FROM turns WHERE thread=? AND status IN ('queued','running','stopping')", (identity,)).fetchone():
                raise Error(409, "请等待当前云端回答结束后再撤回交接。")
            manifest = snapshot["manifest"]
            manifest["report"] = None
            db.execute("DELETE FROM handoff_files WHERE handoff=?", (identity,))
            db.execute("UPDATE handoffs SET state='withdrawn',manifest=? WHERE id=?", (json.dumps(manifest, ensure_ascii=False), identity))
            return self._read(db, identity)

    def published(self, identity):
        try:
            value = self.read(identity)
        except Error as error:
            if error.status == 404:
                return None
            raise
        return value if value["state"] != "uploading" else None
