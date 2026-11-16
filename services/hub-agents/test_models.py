import json
import sys
import tempfile
import time
import unittest
import uuid
from contextlib import closing
from pathlib import Path

from codex import AppServer
from server import RequestError, Store, Worker, digest, validate_turn
from test_server import FAKE_CODEX


MODELS = [{"model": name, "supportedReasoningEfforts": [{"reasoningEffort": "low"}, {"reasoningEffort": "high"}],
           "inputModalities": ["text", "image"]} for name in ("test-model", "other-model")]


class ModelSelectionTest(unittest.TestCase):
    def test_legacy_identity_and_exact_selection_replay(self):
        plain = {"text": "hello", "attachments": []}
        expected = digest(json.dumps(["hello", []], ensure_ascii=False, sort_keys=True).encode())
        self.assertEqual(validate_turn(plain)[2], expected)
        with tempfile.TemporaryDirectory() as directory:
            store = Store(Path(directory))
            thread, turn = str(uuid.uuid4()), str(uuid.uuid4())
            message = {**plain, "selection": {"model": "test-model", "effort": "high"}}
            store.submit(thread, turn, message, MODELS)
            store.submit(thread, turn, message)  # A lost receipt can be reconciled even with no catalog.
            self.assertEqual(store.thread(thread, 2**63-1)["selection"], message["selection"])
            changed = {**message, "selection": {"model": "other-model", "effort": "low"}}
            with self.assertRaises(RequestError) as failure:
                store.submit(thread, turn, changed, MODELS)
            self.assertEqual(failure.exception.status, 409)
            with closing(store.connect()) as db:
                self.assertEqual(db.execute("SELECT count(*) FROM turns").fetchone()[0], 1)
            restarted = Store(Path(directory))
            self.assertEqual(restarted.thread(thread, 2**63-1)["turns"][0]["selection"], message["selection"])

    def test_unavailable_and_malformed_choices_do_not_admit_turns(self):
        with tempfile.TemporaryDirectory() as directory:
            store = Store(Path(directory))
            for selection, models in ((None, MODELS), ({"model": "test-model", "effort": []}, MODELS),
                                      ({"model": "test-model", "effort": "ultra"}, MODELS),
                                      ({"model": "unknown"}, MODELS), ({"model": "test-model"}, None)):
                with self.subTest(selection=selection), self.assertRaises(RequestError):
                    store.submit(str(uuid.uuid4()), str(uuid.uuid4()), {"text":"hello", "attachments":[], "selection":selection}, models)
            with closing(store.connect()) as db:
                self.assertEqual(db.execute("SELECT count(*) FROM turns").fetchone()[0], 0)

    def test_real_rpc_adapter_switches_model_on_the_same_thread(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            fake = root / "fake.py"
            fake.write_text(FAKE_CODEX, encoding="utf-8")
            store = Store(root / "state")
            worker = Worker(store, [sys.executable, str(fake)])
            try:
                deadline = time.monotonic() + 10
                while worker.catalog["state"] == "loading" and time.monotonic() < deadline:
                    time.sleep(.05)
                self.assertEqual(worker.catalog["state"], "ready")
                thread = str(uuid.uuid4())
                for text, selection in (("pick1", {"model":"other-model", "effort":"low"}),
                                         ("pick2", {"model":"test-model", "effort":"high"})):
                    turn = str(uuid.uuid4())
                    store.submit(thread, turn, {"text":text,"attachments":[],"selection":selection}, worker.catalog["models"])
                    worker.wake.set()
                    deadline = time.monotonic() + 10
                    while time.monotonic() < deadline:
                        result = store.thread(thread, 2**63-1)
                        if result["turns"][-1]["status"] not in ("queued","running"):
                            break
                        time.sleep(.05)
                    self.assertEqual(result["turns"][-1]["status"], "completed", result["turns"][-1])
                    self.assertEqual(result["selection"], selection)
                with closing(store.connect()) as db:
                    self.assertEqual(db.execute("SELECT codex_thread FROM threads WHERE id=?", (thread,)).fetchone()[0], "native-thread")
                    self.assertEqual(db.execute("SELECT count(*) FROM turns").fetchone()[0], 2)
            finally:
                worker.shutdown.set()
                worker.wake.set()
                worker.thread.join(timeout=8)

    def test_catalog_pagination_keeps_only_visible_models(self):
        app = object.__new__(AppServer)
        pages = [{"data":[{"model":"hidden", "hidden":True}, {**MODELS[0], "isDefault":True}], "nextCursor":"next"},
                 {"data":[MODELS[0], MODELS[1]], "nextCursor":None}]
        seen = []
        def rpc(method, params):
            seen.append((method, params))
            return pages.pop(0)
        app.rpc = rpc
        self.assertEqual([model["model"] for model in app.models()], ["test-model", "other-model"])
        self.assertEqual(seen[1][1]["cursor"], "next")
