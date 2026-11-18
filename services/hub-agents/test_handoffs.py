import base64
import copy
import json
import tempfile
import threading
import unittest
import uuid
import secrets
from types import SimpleNamespace
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from pathlib import Path

from handoffs import Error, digest, validate
from server import Store, Worker
from server import Handler
from test_server import MemorySocket


def sample():
    raw = {"报告.md": "# 两版对比\n新增 7 项；工程判断需核对。", "明细.csv": "编号,变化\n1,新增\n"}
    files = [{"name": name, "type": name.rsplit(".", 1)[1], "bytes": len(body.encode()), "sha256": digest(body.encode())}
             for name, body in raw.items()]
    return {"version": 1, "title": "两版分析", "origin": {"workId": "work-sample", "executionId": "analysis-sample",
            "artifactId": "artifact-sample", "revision": 2, "generatedAt": "2026-11-18T01:00:00+00:00",
            "inputs": [{"title": "原表.xlsx", "sha256": "a" * 64}]}, "files": files,
            "report": {"name": "报告.md", "text": raw["报告.md"], "sha256": files[0]["sha256"]}}, raw


class HandoffsTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.store = Store(self.root)
        self.repo = self.store.handoffs
        self.identity = str(uuid.uuid4())
        self.manifest, self.raw = sample()

    def prepare(self):
        return self.repo.prepare(self.identity, {"manifest": self.manifest})

    def upload(self):
        for meta in self.manifest["files"]:
            self.repo.upload(self.identity, meta["sha256"], {"data": base64.b64encode(self.raw[meta["name"]].encode()).decode()})

    def publish(self):
        self.prepare()
        self.upload()
        return self.repo.commit(self.identity)

    def test_partial_upload_restart_and_lost_commit_receipt_do_not_duplicate(self):
        self.prepare()
        with self.assertRaises(Error):
            self.repo.commit(self.identity)
        self.assertEqual([], self.store.threads())
        self.upload()
        self.store = Store(self.root)
        self.repo = self.store.handoffs
        published = self.repo.commit(self.identity)
        self.assertEqual(published, self.repo.commit(self.identity))
        self.assertEqual(published, self.prepare())
        self.upload()
        self.assertEqual(1, len(self.store.threads()))
        self.assertEqual([], self.store.thread(self.identity, 2**63 - 1)["turns"])
        self.assertEqual(published, self.store.thread(self.identity, 2**63 - 1)["handoff"])
        for f in self.manifest["files"]:
            downloaded = self.repo.download(self.identity, f["sha256"])
            self.assertEqual(self.raw[f["name"]].encode(), base64.b64decode(downloaded["data"]))
        other = copy.deepcopy(self.manifest)
        other["title"] = "变更标题"
        with self.assertRaises(Error) as error:
            self.repo.prepare(self.identity, {"manifest": other})
        self.assertEqual(409, error.exception.status)

    def test_concurrent_replay_commits_exactly_one_thread(self):
        self.prepare()
        self.upload()
        barrier = threading.Barrier(4)
        def commit(_):
            barrier.wait()
            return self.repo.commit(self.identity)
        with ThreadPoolExecutor(4) as pool:
            results = list(pool.map(commit, range(4)))
        self.assertTrue(all(r == results[0] for r in results))
        self.assertEqual(1, len(self.store.threads()))

    def test_bad_bytes_and_corrupt_storage_never_publish_or_download(self):
        self.prepare()
        with self.assertRaises(Error):
            self.repo.upload(self.identity, self.manifest["files"][0]["sha256"], {"data": "bm90LXJlcG9ydA=="})
        self.upload()
        with closing(self.store.connect()) as db, db:
            db.execute("UPDATE handoff_files SET data=?", (b"corrupt",))
        with self.assertRaises(Error):
            self.repo.commit(self.identity)
        self.assertEqual([], self.store.threads())

    def test_http_requires_device_auth_and_never_serves_an_unpublished_file(self):
        token=secrets.token_urlsafe(32)
        with closing(self.store.connect()) as db,db:
            db.execute("INSERT INTO devices VALUES(?,?,?)",(str(uuid.uuid4()),"unit device",digest(token.encode())))
        gateway=SimpleNamespace(store=self.store,worker=SimpleNamespace(account={},catalog={"state":"ready","models":[]}))
        def call(method,path,body=None,auth=True):
            raw=json.dumps(body).encode() if body is not None else b""
            header=f"{method} {path} HTTP/1.0\r\nContent-Length: {len(raw)}\r\n"
            if auth:header+=f"Authorization: Bearer {token}\r\n"
            socket=MemorySocket(header.encode()+b"\r\n"+raw,False)
            Handler(socket,("127.0.0.1",1),gateway)
            head,data=socket.output.getvalue().split(b"\r\n\r\n",1)
            return int(head.split()[1]),json.loads(data)
        path=f"/v1/handoffs/{self.identity}"
        self.assertEqual(403,call("POST",path,{"manifest":self.manifest},False)[0])
        self.assertEqual(200,call("POST",path,{"manifest":self.manifest})[0])
        self.assertEqual(1,len(call("GET","/v1/handoffs")[1]["drafts"]))
        self.assertEqual(409,call("GET",path+"/files/"+self.manifest["files"][0]["sha256"])[0])
        self.upload()
        self.assertEqual(400,call("POST",path+"/commit",{})[0])
        self.assertEqual(200,call("POST",path+"/commit",{"confirm":True})[0])
        self.assertEqual(0,len(call("GET","/v1/handoffs")[1]["drafts"]))
        downloaded=call("GET",path+"/files/"+self.manifest["files"][0]["sha256"])
        self.assertEqual(200,downloaded[0])
        self.assertEqual(self.raw["报告.md"].encode(),base64.b64decode(downloaded[1]["data"]))
        with closing(self.store.connect()) as db,db:
            db.execute("UPDATE handoff_files SET data=?",(b"corrupt",))
        self.assertEqual(409,call("GET",path+"/files/"+self.manifest["files"][0]["sha256"])[0])

    def test_manifest_cannot_smuggle_paths_types_limits_or_unselected_report(self):
        for update in [
            lambda v: v["files"][0].update(name="../report.md"),
            lambda v: v["files"][0].update(name="C:\\report.md"),
            lambda v: v["files"][0].update(name="CON.md"),
            lambda v: v["files"][0].update(type="html"),
            lambda v: v["files"][0].update(bytes=True),
            lambda v: v["files"][0].update(bytes=10 * 1024**2 + 1),
            lambda v: v["files"].append(v["files"][0]),
            lambda v: v["report"].update(text="篡改报告"),
            lambda v: v["report"].update(name="未选择.md"),
            lambda v: v["origin"].update(hostPath="C:\\private"),
            lambda v: v["origin"].update(generatedAt="not-a-date"),
            lambda v: v["origin"].update(generatedAt="2026-11-18T00:00:00"),
            lambda v: v["files"][0].update(name="\ud800.md"),
        ]:
            with self.subTest(update=update):
                value = copy.deepcopy(self.manifest)
                update(value)
                with self.assertRaises(Error):
                    validate(value)

    def test_withdraw_releases_data_blocks_new_turns_and_cannot_resurrect(self):
        self.publish()
        self.repo.withdraw(self.identity)
        self.assertEqual("withdrawn", self.repo.read(self.identity)["state"])
        self.assertIsNone(self.repo.read(self.identity)["manifest"]["report"])
        with self.assertRaises(Error):
            self.prepare()
        with self.assertRaises(Error):
            self.repo.download(self.identity, self.manifest["files"][0]["sha256"])
        with self.assertRaises(Exception):
            self.store.submit(self.identity, str(uuid.uuid4()), {"text": "继续", "attachments": []})
        with closing(self.store.connect()) as db:
            self.assertEqual(0, db.execute("SELECT count(*) FROM handoff_files").fetchone()[0])

    def test_worker_uses_report_as_evidence_without_uploading_raw_tables(self):
        self.publish()
        prompts = []
        class Adapter:
            def __init__(self, *_): pass
            def __enter__(self): return self
            def __exit__(self, *_): pass
            def run(self, workspace, previous, prompt, images, save_thread, publish, stopped, status, **_):
                prompts.append(prompt)
                self.assertions(workspace, images)
                save_thread("native-one")
                return "completed", "依据[桌面报告]，新增 7 项，待核对。"
            def assertions(self, workspace, images):
                assert not list(workspace.iterdir()) and not images
        turn = str(uuid.uuid4())
        self.store.submit(self.identity, turn, {"text": "先核对什么？", "attachments": []})
        # Run the exact production Worker body without starting a background loop.
        worker = Worker.__new__(Worker)
        worker.store, worker.adapter, worker.command = self.store, Adapter, []
        worker.shutdown = threading.Event()
        worker.account = {}
        with closing(self.store.connect()) as db, db:
            db.execute("UPDATE turns SET status='running' WHERE id=?", (turn,))
        worker.run((turn, self.identity, "先核对什么？"))
        self.assertEqual(1, len(prompts))
        self.assertIn("没有在 VPS 重跑 Python", prompts[0])
        evidence = json.loads(prompts[0].rsplit("\n", 1)[1])
        self.assertEqual(self.raw["报告.md"], evidence["report"]["text"])
        self.assertTrue(all(set(file) == {"name", "type", "sha256", "bytes"} for file in evidence["files"]))
        self.assertEqual("completed", self.store.thread(self.identity, 2**63 - 1)["turns"][0]["status"])
