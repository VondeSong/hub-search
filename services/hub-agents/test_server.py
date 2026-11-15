import base64
import http.client
import io
import json
import secrets
import sqlite3
import sys
import tempfile
import time
import unittest
import uuid
import threading
from contextlib import closing
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import quote

from codex import CodexError, provider_error
from server import Handler, RequestError, Store, Worker, digest


class MemorySocket:
    def __init__(self, request, drop):
        self.input = io.BytesIO(request)
        self.output = io.BytesIO()
        self.drop = drop

    def settimeout(self, _):
        pass

    def makefile(self, *_):
        return self.input

    def sendall(self, data):
        if self.drop:
            raise BrokenPipeError()
        self.output.write(data)


FAKE_CODEX = '''import json, sys, time
from pathlib import Path
sys.stdin.reconfigure(encoding="utf-8")
sys.stdout.reconfigure(encoding="utf-8")

def emit(**data): print(json.dumps(data), flush=True)
def event(method, **params): emit(method=method, params=params)
for line in sys.stdin:
    m = json.loads(line)
    method = m.get("method")
    if "id" not in m: continue
    params = m.get("params", {})
    result = {}
    if method == "account/read": result = {"account":{"type":"chatgpt","planType":"pro"}}
    if method == "account/rateLimits/read": result = {"rateLimits":{"primary":{"usedPercent":17}}}
    if method in ("thread/start", "thread/resume"):
        if method == "thread/resume": assert params["threadId"] == "native-thread"
        assert params["config"]["model_reasoning_summary"] == "detailed"
        result = {"thread":{"id":"native-thread"},"model":"test-model"}
    if method == "turn/start":
        assert params.get("summary") == "detailed"
        assert params["threadId"] == "native-thread"
        inputs = params["input"]
        for image in (v for v in inputs if v["type"]=="localImage"):
            assert Path(image["path"]).read_bytes().startswith(b"\\xff\\xd8\\xff")
        msg = inputs[0]["text"]
        if msg in ("用技能", "继续技能"):
            attached = json.loads(inputs[1]["text"].split("\\n", 1)[1])
            assert attached["files"]["references/rules.md"]["text"] == "核对同一份参考。"
            assert attached["version"] == "method-" + "a" * 64
        if msg == "照片":
            ids = {"threadId":"native-thread","turnId":"native-turn"}
            event("item/reasoning/summaryTextDelta", **ids, itemId="summary", summaryIndex=0, delta="查看用户选定的图片")
            event("item/reasoning/textDelta", **ids, itemId="summary", contentIndex=0, delta="PRIVATE_REASONING")
            event("item/reasoning/summaryTextDelta", threadId="native-thread", turnId="older-turn", itemId="other", summaryIndex=0, delta="OTHER_TURN")
            event("item/started", **ids, item={"id":"progress","type":"agentMessage","phase":"commentary","text":""})
            event("item/agentMessage/delta", **ids, itemId="progress", delta="已读取图片")
            event("item/completed", **ids, item={"id":"progress","type":"agentMessage","phase":"commentary","text":"已读取图片。"})
        event("item/agentMessage/delta", threadId="native-thread", turnId="native-turn", itemId="answer", delta="半段")
        emit(id=m["id"], result={"turn":{"id":"native-turn"}})
        if msg == "stop": continue
        if msg == "quota":
            event("turn/completed", threadId="native-thread", turn={"id":"native-turn","status":"failed","error":{"message":"usage limit"}})
            continue
        time.sleep(.65 if msg == "照片" else .35)
        if msg == "照片":
            event("item/completed", **ids, item={"id":"summary","type":"reasoning","summary":["根据图片回答。"],"content":["PRIVATE_REASONING"]})
        event("item/completed", threadId="native-thread", turnId="native-turn", item={"id":"answer","type":"agentMessage","text":"收到："+msg})
        event("turn/completed", threadId="native-thread", turn={"id":"native-turn","status":"completed"})
        continue
    if method == "turn/interrupt":
        event("turn/completed", threadId="native-thread", turn={"id":"native-turn","status":"interrupted"})
    emit(id=m["id"], result=result)
'''


class GatewayTest(unittest.TestCase):
    def test_material_snapshot_identity_and_answer_note_replay(self):
        with tempfile.TemporaryDirectory() as temporary:
            store = Store(Path(temporary) / "state")
            thread, turn = str(uuid.uuid4()), str(uuid.uuid4())
            material = {"id":"saved-document", "title":"Existing note", "source":"Library", "text":"Source text", "sha256":digest(b"Source text")}
            payload = {"text":"Summarize this note", "attachments":[], "material":material}
            store.submit(thread,turn,payload)
            store.submit(thread,turn,payload)
            self.assertEqual(store.thread(thread,2**63-1)["turns"][0]["material"],material)
            changed = {**payload,"material":{**material,"text":"Different text","sha256":digest(b"Different text")}}
            with self.assertRaises(RequestError): store.submit(thread,turn,changed)
            with self.assertRaises(RequestError): store.answer_note(thread,turn,{"date":"2026-11-15"})
            with closing(store.connect()) as db,db:
                db.execute("UPDATE turns SET status='completed',answer='Grounded answer' WHERE id=?",(turn,))
            first=store.answer_note(thread,turn,{"date":"2026-11-15"})
            replay=store.answer_note(thread,turn,{"date":"2026-11-16"})
            self.assertEqual(first,replay)
            self.assertEqual(first["date"],"2026-11-15")
            self.assertIn("Grounded answer",first["text"])
            self.assertIn("Existing note",first["text"])
            bad={**payload,"material":{**material,"sha256":"0"*64}}
            with self.assertRaises(RequestError): store.submit(str(uuid.uuid4()),str(uuid.uuid4()),bad)

    def test_http_resume_stop_and_restart(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary)
            store = Store(path / "state")
            fake = path / "fake.py"
            fake.write_text(FAKE_CODEX, encoding="utf-8")
            token = secrets.token_urlsafe(32)
            other_token = secrets.token_urlsafe(32)
            with closing(store.connect()) as db, db:
                db.executemany("INSERT INTO devices VALUES(?,?,?)", [("phone", "phone", digest(token.encode())), ("desktop", "desktop", digest(other_token.encode()))])
            worker = Worker(store, [sys.executable, str(fake)])
            self.addCleanup(worker.shutdown.set)
            try:
                from types import SimpleNamespace
                gateway = SimpleNamespace(store=store, worker=worker)

                def call(method, route, data=None, auth=token, drop=False):
                    body = json.dumps(data).encode() if data else b""
                    request = f"{method} {route} HTTP/1.0\r\nAuthorization: Bearer {auth}\r\nContent-Length: {len(body)}\r\n\r\n".encode() + body
                    socket = MemorySocket(request, drop)
                    Handler(socket, ("127.0.0.1", 1), gateway)
                    if drop:
                        return None, None
                    socket.input = io.BytesIO(socket.output.getvalue())
                    response = http.client.HTTPResponse(socket)
                    response.begin()
                    raw = response.read()
                    return response.status, (json.loads(raw) if response.getheader("Content-Type").startswith("application/json") else raw)

                def wait_for(route, state, ready=lambda _: True):
                    for _ in range(100):
                        code, body = call("GET", route, auth=other_token)
                        if code == 200:
                            latest = body["thread"]["turns"][-1]
                            if latest["status"] == state and ready(latest):
                                return body
                        time.sleep(.025)
                    self.fail(f"Did not observe {state}: {body}")

                try:
                    thread = f"/v1/threads/{uuid.uuid4()}"
                    one = f"{thread}/turns/{uuid.uuid4()}"
                    image = b"\xff\xd8\xfffixture"
                    data = {"text": "照片", "attachments": [{"name": "frame.jpg", "mime": "image/jpeg", "seconds": 2.5, "data": base64.b64encode(image).decode()}]}
                    self.assertEqual(call("GET", "/v1/threads", auth="not-a-token")[0], 403)
                    call("POST", one, data, drop=True)
                    self.assertEqual(call("POST", one, data)[0], 202)
                    self.assertEqual(call("POST", one, {**data, "text": "changed"})[0], 409)
                    during = wait_for(thread, "running", lambda turn: bool(turn["progress"].get("summary")))["thread"]["turns"][0]
                    self.assertGreater(during["progress"]["startedAt"], 0)
                    self.assertEqual(during["progress"]["summary"], ["查看用户选定的图片"])
                    self.assertEqual(during["answer"], "半段")
                    reply = wait_for(thread, "completed")
                    turn, = reply["thread"]["turns"]
                    self.assertEqual(turn["answer"], "收到：照片")
                    self.assertEqual(turn["progress"]["summary"], ["根据图片回答。"])
                    self.assertEqual(turn["progress"]["updates"], [
                        "云端已准备 1 张选定图片。", "已连接 Codex，并确认订阅登录。",
                        "已建立本次对话。", "Codex 已接收本轮请求。",
                        "已读取图片。",
                    ])
                    self.assertGreaterEqual(turn["progress"]["finishedAt"], turn["progress"]["startedAt"])
                    self.assertNotIn("PRIVATE_REASONING", str(turn))
                    self.assertNotIn("OTHER_TURN", str(turn))
                    attachment, = turn["attachments"]
                    self.assertEqual(attachment["seconds"], 2.5)
                    self.assertEqual(call("GET", f'/v1/attachments/{attachment["id"]}', auth=other_token), (200, image))
                    self.assertEqual(reply["account"]["limits"][0]["usedPercent"], 17)
                    two = f"{thread}/turns/{uuid.uuid4()}"
                    self.assertEqual(call("POST", two, {"text": "stop", "attachments": []})[0], 202)
                    wait_for(thread, "running")
                    self.assertEqual(call("POST", two + "/stop")[0], 202)
                    wait_for(thread, "stopped")
                    three = f"{thread}/turns/{uuid.uuid4()}"
                    self.assertEqual(call("POST", three, {"text": "quota", "attachments": []})[0], 202)
                    self.assertEqual(wait_for(thread, "failed")["thread"]["turns"][-1]["code"], "quota")
                    skill = {"name": "example", "version": "method-" + "a" * 64, "files": {
                        key: {"text": text, "sha256": digest(text.encode())}
                        for key, text in {"SKILL.md": "用[规则](references/rules.md)检查", "references/rules.md": "核对同一份参考。"}.items()
                    }}
                    def identify(skill):
                        manifest = f"{skill['version']}\n{skill['name']}\n" + "".join(
                            f"{path}\n{entry['sha256']}\n" for path, entry in sorted(skill["files"].items()))
                        return {**skill, "manifestSha256": digest(manifest.encode())}
                    skill = identify(skill)
                    four = f"{thread}/turns/{uuid.uuid4()}"
                    payload = {"text": "用技能", "attachments": [], "skill": skill}
                    self.assertEqual(call("POST", four, {**payload, "skill": {**skill, "files": {
                        **skill["files"], "references/rules.md": {"text": "坏内容", "sha256": "0" * 64}
                    }}})[0], 400)
                    self.assertEqual(call("POST", four, {**payload, "skill": {**skill, "files": {
                        "SKILL.md": skill["files"]["SKILL.md"]
                    }}})[0], 400)
                    call("POST", four, payload, drop=True)
                    self.assertEqual(call("POST", four, payload)[0], 202)
                    self.assertEqual(wait_for(thread, "completed")["thread"]["skill"]["version"], skill["version"])
                    five = f"{thread}/turns/{uuid.uuid4()}"
                    continuation = {"text": "继续技能", "attachments": []}
                    self.assertEqual(call("POST", five, {**continuation, "skill": identify({**skill, "version": "method-" + "b" * 64})})[0], 409)
                    self.assertEqual(call("POST", five, continuation)[0], 202)
                    continued = wait_for(thread, "completed")["thread"]["turns"][-1]
                    self.assertEqual(continued["answer"], "收到：继续技能")
                    self.assertEqual(continued["progress"]["summary"], [])
                    self.assertEqual(continued["progress"]["updates"], [
                        "云端已收到本轮文字。", "已连接 Codex，并确认订阅登录。",
                        "已恢复原对话。", "Codex 已接收本轮请求。",
                    ])
                    with closing(store.connect()) as db, db:
                        db.execute("DELETE FROM devices WHERE id='phone'")
                    self.assertEqual(call("GET", thread)[0], 403)
                    self.assertEqual(call("GET", thread, auth=other_token)[0], 200)
                finally:
                    worker.shutdown.set()
                    worker.wake.set()
                    worker.thread.join(6)
            finally:
                worker.shutdown.set()

            restarted = Store(path / "state")
            self.assertEqual(restarted.thread(thread.rsplit("/", 1)[1], 2**63 - 1)["turns"][0]["answer"], "收到：照片")
            with closing(restarted.connect()) as db:
                self.assertEqual(db.execute("SELECT count(*) FROM turns").fetchone()[0], 5)

    def test_conflict_payload_and_error_classification(self):
        with tempfile.TemporaryDirectory() as temporary:
            store = Store(Path(temporary))
            thread, turn = str(uuid.uuid4()), str(uuid.uuid4())
            payload = {"text": "hello", "attachments": []}
            store.submit(thread, turn, payload)
            store.submit(thread, turn, payload)
            with self.assertRaises(RequestError) as error:
                store.submit(thread, str(uuid.uuid4()), payload)
            self.assertEqual(error.exception.status, 409)
            with self.assertRaises(RequestError):
                store.submit(str(uuid.uuid4()), str(uuid.uuid4()), {"text": "", "attachments": [{"mime": "image/png", "name": "x", "data": "SGVsbG8="}]})
            store.stop(thread, turn)
            self.assertEqual(store.thread(thread, 2**63 - 1)["turns"][0]["status"], "stopped")
            self.assertIsInstance(provider_error({"status": 401}), CodexError)
            self.assertEqual(provider_error({"status": 401}).code, "login")


class ConversationManagementTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.store = Store(Path(self.directory.name))
        self.thread, self.turn = str(uuid.uuid4()), str(uuid.uuid4())
        self.payload = {"text": "原始问题：100%_完成", "attachments": []}
        self.store.submit(self.thread, self.turn, self.payload)
        with closing(self.store.connect()) as db, db:
            db.execute("UPDATE turns SET status='completed',answer='历史正文中的独有词 证据链' WHERE id=?", (self.turn,))

    def test_legacy_database_migration_and_metadata_persist(self):
        path = Path(self.directory.name) / "legacy"
        path.mkdir()
        with closing(sqlite3.connect(path / "agents.sqlite3")) as db, db:
            db.execute("CREATE TABLE threads(id TEXT PRIMARY KEY,title TEXT NOT NULL,updated INTEGER NOT NULL,codex_thread TEXT)")
            db.execute("INSERT INTO threads VALUES('old','已有会话',12,'runtime-thread')")
        migrated = Store(path)
        self.assertEqual(migrated.threads()[0]["archived"], 0)
        self.assertEqual(migrated.thread("old", 2**63 - 1)["title"], "已有会话")
        original = self.store.thread(self.thread, 2**63 - 1)["turns"]
        self.store.update_thread(self.thread, {"title": "  新名称  ", "archived": True})
        reopened = Store(Path(self.directory.name)).thread(self.thread, 2**63 - 1)
        self.assertEqual((reopened["title"], reopened["archived"]), ("新名称", 1))
        self.assertEqual(reopened["turns"], original)
        before = reopened["updated"]
        self.assertEqual(self.store.update_thread(self.thread, {"archived": True})["updated"], before)

    def test_searches_earlier_messages_and_escapes_literal_wildcards(self):
        newer = str(uuid.uuid4())
        self.store.submit(self.thread, newer, {"text": "后续问题", "attachments": []})
        with closing(self.store.connect()) as db, db:
            db.execute("UPDATE turns SET status='completed',answer='最新回答' WHERE id=?", (newer,))
        for query in ("证据链", "100%_完成", "原始问题"):
            row = self.store.threads(query)[0]
            self.assertTrue(row["matches"])
            self.assertEqual(row["preview"], "最新回答")
        self.assertFalse(self.store.threads("不匹配%")[0]["matches"])
        self.assertFalse(self.store.threads("原始问题_100")[0]["matches"])
        with self.assertRaises(RequestError):
            self.store.threads("x" * 201)

    def test_archiving_requires_finished_turn_and_preserves_retry_identity(self):
        running = str(uuid.uuid4())
        self.store.submit(self.thread, running, {"text": "运行中", "attachments": []})
        with self.assertRaises(RequestError) as error:
            self.store.update_thread(self.thread, {"archived": True})
        self.assertEqual(error.exception.status, 409)
        self.store.stop(self.thread, running)
        self.store.update_thread(self.thread, {"archived": True})
        self.store.submit(self.thread, self.turn, self.payload)
        with self.assertRaises(RequestError) as error:
            self.store.submit(self.thread, str(uuid.uuid4()), {"text": "新请求", "attachments": []})
        self.assertEqual(error.exception.status, 409)
        self.store.update_thread(self.thread, {"archived": False})
        self.store.submit(self.thread, str(uuid.uuid4()), {"text": "恢复后继续", "attachments": []})

    def test_invalid_changes_preserve_existing_conversation(self):
        original = self.store.thread(self.thread, 2**63 - 1)
        for changes in ({}, [], {"title": " "}, {"title": "x" * 81}, {"title": "\ud800"}, {"title": None}, {"archived": 1}, {"delete": True}):
            with self.assertRaises(RequestError):
                self.store.update_thread(self.thread, changes)
            self.assertEqual(self.store.thread(self.thread, 2**63 - 1), original)
        with self.assertRaises(RequestError) as error:
            self.store.update_thread(str(uuid.uuid4()), {"title": "不存在"})
        self.assertEqual(error.exception.status, 404)

    def test_http_search_and_metadata_enforce_device_auth(self):
        token = secrets.token_urlsafe(32)
        with closing(self.store.connect()) as db, db:
            db.execute("INSERT INTO devices VALUES('device','test',?)", (digest(token.encode()),))
        gateway = SimpleNamespace(store=self.store, worker=SimpleNamespace(account={"state": "ready"}, wake=threading.Event()))

        def call(method, route, data=None, auth=token):
            body = json.dumps(data).encode() if data is not None else b""
            request = f"{method} {route} HTTP/1.0\r\nAuthorization: Bearer {auth}\r\nContent-Length: {len(body)}\r\n\r\n".encode() + body
            sock = MemorySocket(request, False)
            Handler(sock, ("127.0.0.1", 1), gateway)
            response = http.client.HTTPResponse(SimpleNamespace(makefile=lambda *_: io.BytesIO(sock.output.getvalue())))
            response.begin()
            return response.status, json.loads(response.read())

        route = f"/v1/threads/{self.thread}/metadata"
        self.assertEqual(call("POST", route, {"title": "跨端名称"}, auth="invalid")[0], 403)
        self.assertEqual(call("POST", route, {"title": "跨端名称"})[0], 200)
        status, data = call("GET", "/v1/threads?q=" + quote("证据链"))
        self.assertEqual(status, 200)
        self.assertTrue(data["threadManagement"])
        self.assertTrue(data["threads"][0]["matches"])
        self.assertEqual(call("GET", "/v1/threads?q=a&q=b")[0], 400)
        self.assertEqual(call("POST", route, {"archived": True})[0], 200)
        self.assertEqual(call("POST", route, {"archived": False})[1]["thread"]["archived"], 0)
