"""Private Hub Agents gateway. Put the loopback listener behind HTTPS."""

import argparse
import base64
import binascii
import hashlib
import json
import logging
import os
import re
import secrets
import sqlite3
import tempfile
import threading
import time
import uuid
from contextlib import closing
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

from codex import AppServer, CodexError

MAX_BODY = 17 * 1024**2
MAX_IMAGE = 4 * 1024**2
MAX_IMAGES = 6
UUID = re.compile(r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\Z")
TYPES = {"image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp"}
ACTIVE = ("queued", "running", "stopping")


class RequestError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status


def digest(data):
    return hashlib.sha256(data).hexdigest()


def validate_turn(data):
    if not isinstance(data, dict) or not isinstance(data.get("text"), str) or not isinstance(data.get("attachments"), list):
        raise RequestError(400, "消息格式无效。")
    text = data["text"].strip()
    if len(text) > 20000 or len(data["attachments"]) > MAX_IMAGES:
        raise RequestError(413, "一条消息最多 20,000 字和 6 张图片或关键帧。")
    attachments = []
    total = 0
    for value in data["attachments"]:
        try:
            name = value["name"]
            mime = value["mime"]
            seconds = value.get("seconds")
            raw = base64.b64decode(value["data"], validate=True)
            if not isinstance(name, str) or mime not in TYPES or not raw:
                raise ValueError()
            if seconds is not None and (type(seconds) not in (int, float) or not 0 <= seconds <= 30):
                raise ValueError()
        except (AttributeError, KeyError, TypeError, ValueError, binascii.Error):
            raise RequestError(400, "图片或关键帧格式无效。") from None
        matches = {
            "image/jpeg": raw.startswith(b"\xff\xd8\xff"),
            "image/png": raw.startswith(b"\x89PNG\r\n\x1a\n"),
            "image/webp": raw.startswith(b"RIFF") and raw[8:12] == b"WEBP",
        }
        if not matches[mime]:
            raise RequestError(400, "图片内容与文件类型不一致。")
        total += len(raw)
        if len(raw) > MAX_IMAGE or total > 12 * 1024**2:
            raise RequestError(413, "单张图片最多 4 MiB，单条消息附件合计最多 12 MiB。")
        attachments.append((name[:160], mime, seconds, raw))
    if not text and not attachments:
        raise RequestError(400, "请输入消息或选择附件。")
    fingerprint = digest(json.dumps([text, [[name, mime, seconds, digest(raw)] for name, mime, seconds, raw in attachments]], ensure_ascii=False).encode())
    return text, attachments, fingerprint


class Store:
    def __init__(self, root):
        self.root = root.resolve()
        self.root.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.workspaces = self.root / "workspaces"
        self.workspaces.mkdir(mode=0o700, exist_ok=True)
        with closing(self.connect()) as db, db:
            db.executescript("""
                PRAGMA journal_mode=WAL;
                CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY, label TEXT NOT NULL, token_hash TEXT UNIQUE NOT NULL);
                CREATE TABLE IF NOT EXISTS threads (id TEXT PRIMARY KEY, title TEXT NOT NULL, updated INTEGER NOT NULL, codex_thread TEXT);
                CREATE TABLE IF NOT EXISTS turns (
                    seq INTEGER PRIMARY KEY, id TEXT UNIQUE NOT NULL, thread TEXT NOT NULL REFERENCES threads(id),
                    fingerprint TEXT NOT NULL, text TEXT NOT NULL, status TEXT NOT NULL, answer TEXT NOT NULL DEFAULT '',
                    error TEXT, code TEXT, created INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS thread_turns ON turns(thread,seq);
                CREATE UNIQUE INDEX IF NOT EXISTS active_thread ON turns(thread) WHERE status IN ('queued','running','stopping');
                CREATE TABLE IF NOT EXISTS attachments (
                    id TEXT PRIMARY KEY, turn TEXT NOT NULL REFERENCES turns(id), position INTEGER NOT NULL,
                    name TEXT NOT NULL, mime TEXT NOT NULL, seconds REAL, data BLOB NOT NULL
                );
                CREATE INDEX IF NOT EXISTS turn_attachments ON attachments(turn,position);
            """)

    def connect(self):
        db = sqlite3.connect(self.root / "agents.sqlite3", timeout=6)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA foreign_keys=ON")
        return db

    def devices(self, token):
        with closing(self.connect()) as db:
            return db.execute("SELECT 1 FROM devices WHERE token_hash=?", (digest(token.encode()),)).fetchone() is not None

    def submit(self, thread, turn, data):
        text, attachments, fingerprint = validate_turn(data)
        now = int(time.time() * 1000)
        title = " ".join(text.split())[:48] or "附件对话"
        with closing(self.connect()) as db, db:
            db.execute("BEGIN IMMEDIATE")
            old = db.execute("SELECT thread,fingerprint FROM turns WHERE id=?", (turn,)).fetchone()
            if old:
                if (old["thread"], old["fingerprint"]) != (thread, fingerprint):
                    raise RequestError(409, "这条消息的发送编号已用于其他内容。")
                return
            if db.execute("SELECT count(*) FROM turns WHERE status='queued'").fetchone()[0] >= 8:
                raise RequestError(429, "VPS 当前有多条消息在等待，请稍后重试。")
            if db.execute("SELECT 1 FROM turns WHERE thread=? AND status IN ('queued','running','stopping')", (thread,)).fetchone():
                raise RequestError(409, "此会话有一条消息正在运行，请等待或停止该轮。")
            db.execute("INSERT INTO threads(id,title,updated) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET updated=excluded.updated", (thread, title, now))
            db.execute("INSERT INTO turns(id,thread,fingerprint,text,status,created) VALUES(?,?,?,?,'queued',?)", (turn, thread, fingerprint, text, now))
            db.executemany("INSERT INTO attachments VALUES(?,?,?,?,?,?,?)", [
                (str(uuid.uuid4()), turn, i, name, mime, seconds, raw) for i, (name, mime, seconds, raw) in enumerate(attachments)
            ])

    def threads(self):
        with closing(self.connect()) as db:
            rows = [dict(row) for row in db.execute("SELECT id,title,updated FROM threads ORDER BY updated DESC,id")]
        return rows

    def thread(self, thread, before):
        with closing(self.connect()) as db:
            entry = db.execute("SELECT id,title,updated FROM threads WHERE id=?", (thread,)).fetchone()
            if entry is None:
                raise RequestError(404, "尚未找到此对话。")
            rows = db.execute("SELECT seq,id,text,status,answer,error,code,created FROM turns WHERE thread=? AND seq<? ORDER BY seq DESC LIMIT 31", (thread, before)).fetchall()
            turns = []
            for row in reversed(rows[:30]):
                attachments = db.execute("SELECT id,name,mime,seconds,length(data) AS bytes FROM attachments WHERE turn=? ORDER BY position", (row["id"],))
                turns.append({**dict(row), "attachments": [dict(value) for value in attachments]})
            return {**dict(entry), "turns": turns, "before": turns[0]["seq"] if len(rows) > 30 else None}

    def stop(self, thread, turn):
        with closing(self.connect()) as db, db:
            updated = db.execute("""UPDATE turns SET status=CASE status WHEN 'queued' THEN 'stopped' WHEN 'running' THEN 'stopping' ELSE status END
                                   WHERE thread=? AND id=?""", (thread, turn))
            if not updated.rowcount:
                raise RequestError(404, "找不到这轮对话。")


class Worker:
    def __init__(self, store, command, adapter=AppServer):
        self.store, self.command, self.adapter = store, command, adapter
        self.account = {"state": "unknown"}
        self.wake = threading.Event()
        self.shutdown = threading.Event()
        with closing(store.connect()) as db, db:
            db.execute("UPDATE turns SET status='failed',code='restart',error='VPS 重启中断了本轮，已收到的内容仍可查看。' WHERE status IN ('running','stopping')")
        self.thread = threading.Thread(target=self.loop, daemon=True)
        self.thread.start()

    def update(self, sql, params):
        with closing(self.store.connect()) as db, db:
            db.execute(sql, params)

    def loop(self):
        while not self.shutdown.is_set():
            try:
                with closing(self.store.connect()) as db, db:
                    row = db.execute("""UPDATE turns SET status='running' WHERE seq=(
                        SELECT seq FROM turns WHERE status='queued' ORDER BY seq LIMIT 1)
                        RETURNING id,thread,text""").fetchone()
                if row:
                    self.run(row)
                    continue
            except sqlite3.Error:
                logging.exception("Could not process Hub Agents queue")
            self.wake.wait(1)
            self.wake.clear()

    def run(self, row):
        turn, thread, text = row

        def stopped():
            if self.shutdown.is_set():
                return True
            with closing(self.store.connect()) as db:
                return db.execute("SELECT status FROM turns WHERE id=?", (turn,)).fetchone()[0] == "stopping"

        def status(value):
            self.account = value

        try:
            with tempfile.TemporaryDirectory(dir=self.store.workspaces) as directory:
                workspace = Path(directory)
                images = []
                with closing(self.store.connect()) as db:
                    previous = db.execute("SELECT codex_thread FROM threads WHERE id=?", (thread,)).fetchone()[0]
                    for index, file in enumerate(db.execute("SELECT mime,seconds,data FROM attachments WHERE turn=? ORDER BY position", (turn,))):
                        path = workspace / (str(index) + TYPES[file["mime"]])
                        path.write_bytes(file["data"])
                        images.append((path, file["seconds"]))
                with self.adapter(self.command, workspace) as adapter:
                    state, answer = adapter.run(
                        workspace, previous, text or "请描述并分析这些附件。", images,
                        lambda value: self.update("UPDATE threads SET codex_thread=? WHERE id=?", (value, thread)),
                        lambda value: self.update("UPDATE turns SET answer=? WHERE id=?", (value, turn)),
                        stopped, status,
                    )
                self.update("UPDATE turns SET status=?,answer=? WHERE id=?", (state, answer, turn))
        except (CodexError, OSError, KeyError, TypeError, ValueError) as error:
            code = error.code if isinstance(error, CodexError) else "runtime"
            message = str(error) if isinstance(error, CodexError) else "VPS 上的 Codex 服务未能运行。"
            if code in ("quota", "login"):
                self.account = {**self.account, "state": code}
            self.update("UPDATE turns SET status='failed',code=?,error=? WHERE id=?", (code, message, turn))


class Gateway(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, store, port, worker):
        self.store, self.worker = store, worker
        super().__init__(("127.0.0.1", port), Handler)


class Handler(BaseHTTPRequestHandler):
    def setup(self):
        self.request.settimeout(25)
        super().setup()

    def log_message(self, *_):
        pass

    def send(self, status, value, mime="application/json; charset=utf-8"):
        data = value if isinstance(value, bytes) else json.dumps(value, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        self.handle_request(False)

    def do_POST(self):
        self.handle_request(True)

    def handle_request(self, post):
        try:
            self.route(post)
        except RequestError as error:
            self.send(error.status, {"error": str(error)})
        except (sqlite3.Error, OSError) as error:
            if not isinstance(error, (BrokenPipeError, ConnectionResetError)):
                logging.warning("Hub Agents request failed: %s", type(error).__name__)
                self.send(503, {"error": "VPS 暂时无法处理请求，请重试。"})

    def route(self, post):
        token = self.headers.get("Authorization", "")
        store, worker = self.server.store, self.server.worker
        if not re.fullmatch(r"Bearer [A-Za-z0-9_-]{43}", token) or not store.devices(token[7:]):
            raise RequestError(403, "设备密钥无效或已被撤销。")
        url = urlsplit(self.path)
        parts = url.path.strip("/").split("/")
        if parts == ["v1", "threads"] and not post:
            self.send(200, {"threads": store.threads(), "account": worker.account})
            return
        if len(parts) >= 3 and parts[:2] == ["v1", "threads"] and UUID.fullmatch(parts[2]):
            thread = parts[2]
            if len(parts) == 3 and not post:
                before = parse_qs(url.query).get("before", [str(2**63 - 1)])[0]
                if not before.isascii() or not before.isdecimal() or len(before) > 19 or not 0 < int(before) < 2**63:
                    raise RequestError(400, "会话分页参数无效。")
                self.send(200, {"thread": store.thread(thread, int(before)), "account": worker.account})
                return
            if len(parts) in (5, 6) and parts[3] == "turns" and UUID.fullmatch(parts[4]) and post:
                turn = parts[4]
                if len(parts) == 6 and parts[5] == "stop":
                    store.stop(thread, turn)
                elif len(parts) == 5:
                    if self.headers.get("Transfer-Encoding"):
                        raise RequestError(400, "请使用定长消息上传。")
                    length = self.headers.get("Content-Length", "")
                    if not re.fullmatch(r"[0-9]{1,9}", length) or not 0 < int(length) <= MAX_BODY:
                        raise RequestError(413, "消息或附件超出上传限制。")
                    try:
                        data = json.loads(self.rfile.read(int(length)))
                    except (UnicodeError, ValueError, RecursionError):
                        raise RequestError(400, "消息格式无效。") from None
                    store.submit(thread, turn, data)
                else:
                    raise RequestError(404, "此请求不存在。")
                worker.wake.set()
                self.send(202, {"id": turn})
                return
        if len(parts) == 3 and parts[:2] == ["v1", "attachments"] and UUID.fullmatch(parts[2]) and not post:
            with closing(store.connect()) as db:
                row = db.execute("SELECT mime,data FROM attachments WHERE id=?", (parts[2],)).fetchone()
            if row:
                self.send(200, row["data"], row["mime"])
                return
        raise RequestError(404, "此请求不存在。")


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--state", type=Path, required=True)
    parser.add_argument("--codex", default="codex")
    parser.add_argument("--port", type=int, default=8787)
    sub = parser.add_subparsers(dest="action", required=True)
    sub.add_parser("serve")
    sub.add_parser("devices")
    sub.add_parser("add-device").add_argument("label")
    sub.add_parser("revoke-device").add_argument("id")
    args = parser.parse_args()
    store = Store(args.state)
    if args.action == "serve":
        # Lock the state directory before recovering any running turns.
        import fcntl
        with (store.root / "worker.lock").open("a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            worker = Worker(store, [args.codex])
            with Gateway(store, args.port, worker) as gateway:
                gateway.serve_forever()
        return
    with closing(store.connect()) as db, db:
        if args.action == "add-device":
            key = secrets.token_urlsafe(32)
            device = str(uuid.uuid4())
            db.execute("INSERT INTO devices VALUES(?,?,?)", (device, args.label[:80], digest(key.encode())))
            print(json.dumps({"id": device, "token": key}))
        elif args.action == "revoke-device":
            print(db.execute("DELETE FROM devices WHERE id=?", (args.id,)).rowcount)
        else:
            for row in db.execute("SELECT id,label FROM devices ORDER BY label"):
                print(row["id"], row["label"])


if __name__ == "__main__":
    main()
