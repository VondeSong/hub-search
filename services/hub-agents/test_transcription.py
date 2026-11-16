import base64
import hashlib
import json
import tempfile
import threading
import time
import unittest
import uuid
import secrets
import shutil
import wave
from types import SimpleNamespace
from contextlib import closing
from pathlib import Path

from server import Store, digest, Handler
from test_server import MemorySocket
from transcription import Manager, Results, SpeechError, RATE, public_providers


class FakeStream:
    calls = []
    def __init__(self, provider, config, emit):
        self.provider, self.emit = provider, emit
        self.done = threading.Event()
        self.parts = []
        self.calls.append(self)
    def push(self, pcm):
        self.parts.append(pcm)
    def finish(self):
        self.emit({'state': 'completed', 'text': '测试语音', 'usage': {'billedSeconds': 1}})
        self.done.set()
    def cancel(self):
        self.done.set()


class SpeechTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.store = Store(Path(self.folder.name))
        self.token = secrets.token_urlsafe(32)
        self.owner = digest(self.token.encode())
        with closing(self.store.connect()) as db, db:
            db.execute('INSERT INTO devices VALUES(?,?,?)', ('device', 'test', self.owner))
        FakeStream.calls = []
        self.manager = Manager(self.store, stream=FakeStream)
        self.addCleanup(self.manager.close)
        self.job = str(uuid.uuid4())
        self.data = {'provider': 'aliyun', 'source': 'a' * 32}

    def start(self):
        self.manager.create(self.owner, self.job, self.data)
        for _ in range(100):
            value = self.manager.read(self.owner, self.job)
            if value['state'] != 'connecting':
                return value
            time.sleep(.005)
        self.fail('fixture did not start')

    def test_retries_are_same_session_and_chunk_content_is_immutable(self):
        self.start()
        self.manager.create(self.owner, self.job, self.data)
        packet = {'offset': 0, 'audio': base64.b64encode(b'\0' * 4800).decode()}
        self.manager.append(self.owner, self.job, packet)
        self.manager.append(self.owner, self.job, packet)
        self.assertEqual(len(FakeStream.calls), 1)
        self.assertEqual(len(FakeStream.calls[0].parts), 1)
        with self.assertRaises(SpeechError):
            self.manager.append(self.owner, self.job, {**packet, 'audio': base64.b64encode(b'\1' * 4800).decode()})
        with self.assertRaises(SpeechError):
            self.manager.create(self.owner, self.job, {**self.data, 'provider': 'openai'})

    def test_owner_offset_finish_and_restart_guards(self):
        self.start()
        with self.assertRaises(SpeechError):
            self.manager.read(digest(b'other'), self.job)
        with self.assertRaises(SpeechError):
            self.manager.finish(self.owner, self.job, {'bytes': 4800})
        restarted = Manager(self.store, stream=FakeStream)
        self.addCleanup(restarted.close)
        self.assertEqual(restarted.read(self.owner, self.job)['code'], 'interrupted')
        restarted.create(self.owner, self.job, self.data)
        self.assertEqual(len(FakeStream.calls), 1)

    def test_completion_survives_finish_race_and_does_not_start_again(self):
        self.start()
        self.manager.append(self.owner, self.job, {'offset': 0, 'audio': base64.b64encode(b'\0' * 4800).decode()})
        self.assertEqual(self.manager.finish(self.owner, self.job, {'bytes': 4800})['state'], 'completed')
        self.assertEqual(self.manager.finish(self.owner, self.job, {'bytes': 4800})['text'], '测试语音')
        restarted = Manager(self.store, stream=FakeStream)
        self.addCleanup(restarted.close)
        self.assertEqual(restarted.read(self.owner, self.job)['state'], 'completed')

    def test_revoked_device_and_replay_hash_reject_before_provider(self):
        with closing(self.store.connect()) as db, db:
            db.execute('DELETE FROM devices')
        with self.assertRaises(SpeechError):
            self.manager.create(self.owner, self.job, self.data)
        with self.assertRaises(SpeechError):
            self.manager.create(self.owner, self.job, {**self.data, 'audio': base64.b64encode(b'wrong').decode()})
        self.assertEqual(FakeStream.calls, [])

    def test_public_status_does_not_return_credentials(self):
        path = Path(self.folder.name) / 'config.json'
        path.write_text(json.dumps({'aliyun': {'apiKey': 'secret-test-value'}}))
        view = public_providers(path)
        self.assertTrue(view[0]['configured'])
        self.assertNotIn('secret-test-value', json.dumps(view))

    def test_sentence_revisions_heartbeats_and_foreign_task_are_ignored(self):
        result = Results('aliyun', 'task')
        def receive(begin, text, **extra):
            result.receive({'header': {'task_id': 'task', 'event': 'result-generated'}, 'payload': {'output': {'sentence': {'begin_time': begin, 'text': text, **extra}}}})
        receive(100, '世界'); receive(0, '你'); receive(0, '你好', sentence_end=True); receive(0, '迟到的临时句'); receive(1, 'noise', heartbeat=True)
        result.receive({'header': {'task_id': 'other', 'event': 'task-failed'}})
        self.assertEqual(result.text(), '你好世界')

    def test_openai_completion_before_commit_is_bound_to_exact_item(self):
        result = Results('openai', 'task')
        result.receive({'type': 'conversation.item.input_audio_transcription.completed', 'item_id': 'other', 'transcript': 'wrong'})
        result.receive({'type': 'conversation.item.input_audio_transcription.completed', 'item_id': 'own', 'transcript': '正确'})
        self.assertFalse(result.finished)
        result.receive({'type': 'input_audio_buffer.committed', 'item_id': 'own'})
        self.assertTrue(result.finished)
        self.assertEqual(result.text(), '正确')

    def test_openai_failure_before_commit_is_retained_for_its_exact_item(self):
        result = Results('openai', 'task')
        result.receive({'type': 'conversation.item.input_audio_transcription.failed', 'item_id': 'own', 'error': {'code': 'quota'}})
        with self.assertRaises(SpeechError) as raised:
            result.receive({'type': 'input_audio_buffer.committed', 'item_id': 'own'})
        self.assertEqual(raised.exception.code, 'quota')

    def test_http_authentication_precedes_job_routes_and_foreign_jobs_stay_private(self):
        def get(token, path):
            request = f'GET {path} HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer {token}\r\n\r\n'.encode()
            socket = MemorySocket(request, False)
            Handler(socket, ('127.0.0.1', 1), SimpleNamespace(store=self.store, worker=None, speech=self.manager))
            return socket.output.getvalue()
        self.start()
        self.assertIn(b'200 OK', get(self.token, '/v1/voice/jobs/' + self.job))
        self.assertIn(b'403 Forbidden', get(secrets.token_urlsafe(32), '/v1/voice/providers'))
        other = secrets.token_urlsafe(32)
        with closing(self.store.connect()) as db, db:
            db.execute('INSERT INTO devices VALUES(?,?,?)', ('other', 'other', digest(other.encode())))
        response = get(other, '/v1/voice/jobs/' + self.job)
        self.assertIn(b'404 Not Found', response)
        self.assertNotIn(self.job.encode(), response)

    @unittest.skipUnless(shutil.which('ffmpeg'), 'requires the replay decoder')
    def test_playlist_cannot_read_other_files_as_an_audio_attachment(self):
        private = Path(self.folder.name) / 'private.wav'
        with wave.open(str(private), 'wb') as audio:
            audio.setnchannels(1); audio.setsampwidth(2); audio.setframerate(RATE); audio.writeframes(b'\0' * 4800)
        playlist = ("ffconcat version 1.0\nfile '" + private.as_posix() + "'\n").encode()
        self.manager.create(self.owner, self.job, {'provider': 'aliyun', 'source': hashlib.sha256(playlist).hexdigest(), 'audio': base64.b64encode(playlist).decode()})
        for _ in range(200):
            result = self.manager.read(self.owner, self.job)
            if result['state'] == 'failed':break
            time.sleep(.01)
        self.assertEqual(result['state'], 'failed')
        self.assertEqual(result['code'], 'decode')
        self.assertEqual(FakeStream.calls[0].parts, [])


if __name__ == '__main__':
    unittest.main()
