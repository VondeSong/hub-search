import base64
import http.client
import io
import json
import secrets
import sys
import tempfile
import time
import unittest
import uuid
from contextlib import closing
from pathlib import Path

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
        result = {"thread":{"id":"native-thread"},"model":"test-model"}
    if method == "turn/start":
        assert params["threadId"] == "native-thread"
        inputs = params["input"]
        for image in (v for v in inputs if v["type"]=="localImage"):
            assert Path(image["path"]).read_bytes().startswith(b"\\xff\\xd8\\xff")
        msg = inputs[0]["text"]
        event("item/agentMessage/delta", threadId="native-thread", turnId="native-turn", itemId="answer", delta="半段")
        emit(id=m["id"], result={"turn":{"id":"native-turn"}})
        if msg == "stop": continue
        if msg == "quota":
            event("turn/completed", threadId="native-thread", turn={"id":"native-turn","status":"failed","error":{"message":"usage limit"}})
            continue
        time.sleep(.35)
        event("item/completed", threadId="native-thread", turnId="native-turn", item={"id":"answer","type":"agentMessage","text":"收到："+msg})
        event("turn/completed", threadId="native-thread", turn={"id":"native-turn","status":"completed"})
        continue
    if method == "turn/interrupt":
        event("turn/completed", threadId="native-thread", turn={"id":"native-turn","status":"interrupted"})
    emit(id=m["id"], result=result)
'''


class GatewayTest(unittest.TestCase):
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

                def wait_for(route, state):
                    for _ in range(100):
                        code, body = call("GET", route, auth=other_token)
                        if code == 200 and body["thread"]["turns"][-1]["status"] == state:
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
                    reply = wait_for(thread, "completed")
                    turn, = reply["thread"]["turns"]
                    self.assertEqual(turn["answer"], "收到：照片")
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
                self.assertEqual(db.execute("SELECT count(*) FROM turns").fetchone()[0], 3)

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
