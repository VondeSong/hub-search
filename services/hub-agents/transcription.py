"""Authenticated speech transcription; credentials stay on the VPS."""

import base64
import binascii
import hashlib
import http.client
import json
import os
import queue
import re
import sqlite3
import subprocess
import tempfile
import threading
import time
import uuid
from contextlib import closing
from pathlib import Path

RATE = 24000
MAX_AUDIO = 20 * 1024**2
MAX_PCM = RATE * 2 * 30 * 60
MODELS = {"aliyun": "paraformer-realtime-v2", "openai": "gpt-live-transcribe"}
FILE_MODELS = {"aliyun": "qwen3-asr-flash", "openai": "gpt-transcribe"}
FILE_MAX_SECONDS = {"aliyun": 300, "openai": 1800}
CONFIG = Path(os.environ.get("HUB_TRANSCRIPTION_CONFIG", "/etc/hub-agents/transcription.json"))
ID = re.compile(r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}")
HEX = re.compile(r"[0-9a-f]{32}")


class SpeechError(Exception):
    def __init__(self, code, message, status=400):
        super().__init__(message)
        self.code, self.status = code, status


def settings(path=CONFIG):
    try:
        value = json.loads(Path(path).read_text())
        return value if isinstance(value, dict) else {}
    except (OSError, ValueError):
        return {}


def public_providers(path=CONFIG):
    configured = settings(path)
    return [{"id": name, "model": model, "configured": bool(configured.get(name, {}).get("apiKey")),
             "sampleRate": RATE, "fileModel": FILE_MODELS[name],
             "fileMaxSeconds": FILE_MAX_SECONDS[name]} for name, model in MODELS.items()]


def error_for(code):
    # Provider diagnostics may repeat credentials; return only known public errors.
    code = str(code).lower()
    if any(x in code for x in ("401", "403", "invalid_api_key", "unauthorized", "authentication")):
        return SpeechError("authentication", "转写服务密钥无效或没有使用权限，请检查服务配置。", 503)
    if any(x in code for x in ("429", "quota", "balance", "arrear", "insufficient", "throttl")):
        return SpeechError("quota", "转写服务额度不足或请求过多，原音仍保留，可以稍后重试。", 503)
    return SpeechError("service", "转写服务未能完成识别，原音仍保留，可以稍后重试。", 503)


def aliyun_host(config):
    workspace = config.get("workspaceId", "")
    if workspace and (not isinstance(workspace, str) or not re.fullmatch(r"[a-zA-Z0-9-]{1,80}", workspace)):
        raise SpeechError("configuration", "阿里业务空间编号无效。", 503)
    return f"{workspace}.cn-beijing.maas.aliyuncs.com" if workspace else "dashscope.aliyuncs.com"


def encode_file(audio, limit):
    with tempfile.TemporaryDirectory(prefix="hub-speech-") as folder:
        source = Path(folder) / "original"
        source.write_bytes(audio)
        try:
            result = subprocess.run([
                "ffmpeg", "-v", "error", "-nostdin", "-threads", "1",
                "-protocol_whitelist", "file,pipe",
                "-format_whitelist", "wav,mov,mp3,ogg,matroska,webm,aac,flac,amr",
                "-i", str(source), "-map", "0:a:0", "-t", str(limit + .2),
                "-ac", "1", "-ar", "16000", "-codec:a", "libmp3lame", "-b:a", "64k",
                "-progress", "pipe:2", "-f", "mp3", "pipe:1",
            ], capture_output=True, timeout=90)
        except (OSError, subprocess.TimeoutExpired):
            raise SpeechError("decode", "个人云端未能读取原音，附件仍保留。", 503) from None
    times = re.findall(rb"^out_time_us=(\d+)\r?$", result.stderr, re.MULTILINE)
    if result.returncode or not result.stdout or not times:
        raise SpeechError("decode", "无法读取这个音频文件，附件仍保留。")
    # MP3 encoder padding can add a few milliseconds to the output clock.
    if int(times[-1]) > (limit + .05) * 1_000_000:
        raise SpeechError("duration", f"所选文件转写服务每段最多 {limit // 60} 分钟，原音仍保留。")
    return result.stdout


def transcribe_file(provider, config, audio, is_active):
    selected = config.get(provider, {})
    key = selected.get("apiKey")
    if not isinstance(key, str) or not key:
        raise SpeechError("configuration", "所选转写服务尚未配置。", 503)
    encoded = encode_file(audio, FILE_MAX_SECONDS[provider])
    model = FILE_MODELS[provider]
    if provider == "openai":
        host, path = "api.openai.com", "/v1/audio/transcriptions"
        boundary = uuid.uuid4().hex
        content_type = f"multipart/form-data; boundary={boundary}"
        fields = (
            f'--{boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\n{model}\r\n'
            f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="recording.mp3"\r\n'
            'Content-Type: audio/mpeg\r\n\r\n'
        )
        body = fields.encode() + encoded + f"\r\n--{boundary}--\r\n".encode()
    else:
        host, path = aliyun_host(selected), "/compatible-mode/v1/chat/completions"
        content_type = "application/json"
        data_url = "data:audio/mpeg;base64," + base64.b64encode(encoded).decode("ascii")
        body = json.dumps({
            "model": model, "stream": False,
            "messages": [{"role": "user", "content": [{
                "type": "input_audio", "input_audio": {"data": data_url},
            }]}],
        }).encode()
    if not is_active():
        return None
    with closing(http.client.HTTPSConnection(host, timeout=180)) as connection:
        connection.request("POST", path, body, {
            "Authorization": "Bearer " + key, "Content-Type": content_type,
        })
        response = connection.getresponse()
        if response.status != 200:
            raise error_for(response.status)
        raw = response.read(512 * 1024 + 1)
    if len(raw) > 512 * 1024:
        raise error_for("")
    result = json.loads(raw)
    text = result.get("text") if provider == "openai" else result["choices"][0]["message"]["content"]
    if not isinstance(text, str):
        raise error_for("")
    usage = result.get("usage", {})
    return {"text": text, "usage": {
        k: v for k, v in usage.items()
        if (k.endswith("_tokens") or k in ("seconds", "duration")) and type(v) in (int, float)
    } if isinstance(usage, dict) else {}}


class Results:
    """Reconcile provider sentence revisions and out-of-order item completion."""
    def __init__(self, provider, task):
        self.provider, self.task = provider, task
        self.sentences, self.partials, self.completed, self.failures = {}, {}, {}, {}
        self.final_sentences = set()
        self.committed, self.usage, self.finished = None, {}, False

    def receive(self, event):
        if self.provider == "aliyun":
            header = event.get("header", {})
            if header.get("task_id") != self.task:
                return
            kind = header.get("event")
            if kind == "task-failed":
                raise error_for(header.get("error_code", ""))
            if kind == "result-generated":
                sentence = event.get("payload", {}).get("output", {}).get("sentence", {})
                if sentence.get("heartbeat"):
                    return
                begin, text = sentence.get("begin_time"), sentence.get("text")
                if isinstance(begin, int) and isinstance(text, str) and begin not in self.final_sentences:
                    self.sentences[begin] = text
                    if sentence.get('sentence_end'):
                        self.final_sentences.add(begin)
                usage = event.get("payload", {}).get("usage")
                if isinstance(usage, dict) and isinstance(usage.get("duration"), (int, float)):
                    self.usage = {"billedSeconds": usage["duration"]}
            elif kind == "task-finished":
                self.finished = True
        else:
            kind, item = event.get("type"), event.get("item_id")
            if kind == "error":
                raise error_for(event.get("error", {}).get("code", ""))
            if kind == "input_audio_buffer.committed":
                self.committed = item
            elif kind == "conversation.item.input_audio_transcription.delta" and isinstance(item, str):
                self.partials[item] = self.partials.get(item, "") + str(event.get("delta", ""))
            elif kind == "conversation.item.input_audio_transcription.completed" and isinstance(item, str):
                self.completed[item] = str(event.get("transcript", ""))
                usage = event.get("usage")
                if isinstance(usage, dict):
                    self.usage = {k: v for k, v in usage.items() if k.endswith("tokens") and isinstance(v, (int, float))}
            elif kind == "conversation.item.input_audio_transcription.failed":
                self.failures[item] = event.get("error", {}).get("code", "")
            if self.committed in self.failures:
                raise error_for(self.failures[self.committed])
            self.finished = bool(self.committed and self.committed in self.completed)

    def text(self):
        if self.provider == "aliyun":
            return "".join(self.sentences[k] for k in sorted(self.sentences))
        if self.committed:
            return self.completed.get(self.committed, self.partials.get(self.committed, ""))
        return next(iter(self.partials.values()), "")


class Stream:
    def __init__(self, provider, config, emit, factory=None):
        self.provider, self.emit = provider, emit
        self.task = str(uuid.uuid4())
        self.results = Results(provider, self.task)
        self.done, self.lock = threading.Event(), threading.Lock()
        self.ending, self.error, self.audio_bytes = False, None, 0
        self.started, self.first_text = time.monotonic(), None
        key = config.get(provider, {}).get("apiKey")
        if provider not in MODELS or not isinstance(key, str) or not key:
            raise SpeechError("configuration", "所选转写服务尚未配置。", 503)
        if factory is None:
            try:
                import websocket
            except ImportError:
                raise SpeechError("configuration", "VPS 尚未安装语音连接组件。", 503) from None
            factory = websocket.create_connection
        if provider == "openai":
            url = "wss://api.openai.com/v1/realtime?intent=transcription"
        else:
            host = aliyun_host(config[provider])
            url = f"wss://{host}/api-ws/v1/inference"
        try:
            self.socket = factory(url, timeout=20, header=["Authorization: Bearer " + key],
                                  suppress_origin=True, enable_multithread=True, redirect_limit=0,
                                  http_no_proxy=["*"])
            if provider == "aliyun":
                start = {"header": {"action": "run-task", "task_id": self.task, "streaming": "duplex"},
                         "payload": {"task_group": "audio", "task": "asr", "function": "recognition",
                                     "model": MODELS[provider], "parameters": {"format": "pcm", "sample_rate": RATE,
                                     "heartbeat": True}, "input": {}}}
            else:
                start = {"type": "session.update", "session": {"type": "transcription", "audio": {"input": {
                    "format": {"type": "audio/pcm", "rate": RATE},
                    "transcription": {"model": MODELS[provider], "delay": "medium"}, "turn_detection": None}}}}
            self.socket.send(json.dumps(start))
            deadline = time.monotonic() + 25
            while time.monotonic() < deadline:
                event = json.loads(self.socket.recv())
                self.results.receive(event)
                ready = (event.get("header", {}).get("event") == "task-started" and
                         event.get("header", {}).get("task_id") == self.task) if provider == "aliyun" else event.get("type") == "session.updated"
                if ready:
                    break
            else:
                raise TimeoutError()
            self.socket.settimeout(3)
        except SpeechError:
            if hasattr(self, "socket"):
                self.socket.close()
            raise
        except Exception as error:
            if hasattr(self, "socket"):
                self.socket.close()
            raise error_for(getattr(error, "status_code", "")) from None
        self.reader = threading.Thread(target=self._receive, daemon=True)
        self.reader.start()

    def _receive(self):
        last_text = ""
        deadline = None
        try:
            while not self.done.is_set():
                if self.ending and deadline is None:
                    deadline = time.monotonic() + 90
                try:
                    raw = self.socket.recv()
                except TimeoutError:
                    if deadline and time.monotonic() > deadline:
                        raise SpeechError("timeout", "等待转写结果超时，原音仍保留，请核对后重试。", 503)
                    continue
                except Exception as error:
                    # websocket-client's timeout is not necessarily a TimeoutError subclass.
                    if type(error).__name__ == "WebSocketTimeoutException":
                        if deadline and time.monotonic() > deadline:
                            raise SpeechError("timeout", "等待转写结果超时，原音仍保留。", 503)
                        continue
                    raise error
                if not raw or len(raw) > 2 * 1024**2:
                    raise SpeechError("connection", "转写连接中断，原音仍保留，可以补转写。", 503)
                self.results.receive(json.loads(raw))
                text = self.results.text()
                if len(text) > 50_000:
                    raise SpeechError("size", "识别文字超出本条记录限制，原音仍保留。")
                if text and self.first_text is None:
                    self.first_text = time.monotonic() - self.started
                if text != last_text or self.results.finished:
                    last_text = text
                    self.emit(self.view("completed" if self.results.finished else "running"))
                if self.results.finished:
                    break
        except Exception as error:
            self.error = error if isinstance(error, SpeechError) else error_for("")
            self.emit({**self.view("failed"), "code": self.error.code, "error": str(self.error)})
        finally:
            self.done.set()
            self.socket.close()

    def view(self, state):
        return {"state": state, "text": self.results.text(), "usage": self.results.usage,
                "metrics": {"audioSeconds": round(self.audio_bytes / (RATE * 2), 3),
                            "firstTextSeconds": self.first_text, "elapsedSeconds": round(time.monotonic() - self.started, 3)}}

    def push(self, pcm):
        with self.lock:
            if self.ending or self.done.is_set():
                raise self.error or SpeechError("ended", "这一轮转写已结束，请核对当前结果。", 409)
            if not pcm or len(pcm) % 2 or self.audio_bytes + len(pcm) > MAX_PCM:
                raise SpeechError("audio", "音频数据无效或超过单段 30 分钟限制。")
            try:
                if self.provider == "aliyun":
                    self.socket.send_binary(pcm)
                else:
                    self.socket.send(json.dumps({"type": "input_audio_buffer.append", "audio": base64.b64encode(pcm).decode()}))
                self.audio_bytes += len(pcm)
            except Exception:
                raise SpeechError("connection", "上传音频时连接中断，原音仍保留。", 503) from None

    def finish(self):
        with self.lock:
            if self.ending or self.done.is_set():
                return
            self.ending = True
            if self.audio_bytes < RATE // 5:
                raise SpeechError("audio", "录音过短，请保留原音并重新录一段。")
            event = {"header": {"action": "finish-task", "task_id": self.task, "streaming": "duplex"}, "payload": {"input": {}}} if self.provider == "aliyun" else {"type": "input_audio_buffer.commit"}
            self.socket.send(json.dumps(event))

    def cancel(self):
        self.done.set()
        self.socket.close()


class Manager:
    """Durable identities prevent retries from starting a second paid session."""
    def __init__(self, store, config=CONFIG, stream=Stream, file_transcriber=transcribe_file):
        self.store, self.config, self.factory = store, config, stream
        self.file_transcriber = file_transcriber
        self.lock, self.live = threading.RLock(), {}
        self.stopped = threading.Event()
        with closing(store.connect()) as db, db:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS voice_jobs (
                    id TEXT PRIMARY KEY, owner TEXT NOT NULL, provider TEXT NOT NULL,
                    source TEXT NOT NULL, body TEXT NOT NULL, updated REAL NOT NULL);
                CREATE TABLE IF NOT EXISTS voice_chunks (
                    job TEXT NOT NULL, offset INTEGER NOT NULL, sha256 TEXT NOT NULL,
                    PRIMARY KEY(job,offset));
            """)
            for row in db.execute("SELECT id,body FROM voice_jobs"):
                body = json.loads(row['body'])
                if body['state'] not in ('completed', 'failed', 'cancelled'):
                    body.update(state='failed', code='interrupted', error='VPS 已重启，本轮转写中断。原音仍保留，请明确选择补转写。')
                    db.execute("UPDATE voice_jobs SET body=? WHERE id=?", (json.dumps(body), row['id']))
        self.expirer = threading.Thread(target=self._expire, daemon=True)
        self.expirer.start()

    def close(self):
        self.stopped.set()
        entries = list(self.live.items())
        for job, entry in entries:
            self.cancel(entry['owner'], job)
        for _, entry in entries:
            entry['thread'].join(25)
        self.expirer.join(2)

    def _authorized(self, owner):
        with closing(self.store.connect()) as db:
            return bool(db.execute('SELECT 1 FROM devices WHERE token_hash=?', (owner,)).fetchone())

    def _row(self, owner, job):
        if not isinstance(job, str) or not ID.fullmatch(job):
            raise SpeechError('identity', '转写任务编号无效。')
        with closing(self.store.connect()) as db:
            row = db.execute('SELECT * FROM voice_jobs WHERE id=? AND owner=?', (job, owner)).fetchone()
        if row is None:
            raise SpeechError('missing', '未找到本设备的转写记录。', 404)
        return row

    def _update(self, job, **fields):
        with self.lock, closing(self.store.connect()) as db, db:
            row = db.execute('SELECT body FROM voice_jobs WHERE id=?', (job,)).fetchone()
            value = json.loads(row['body'])
            if value['state'] in ('completed', 'failed', 'cancelled'):
                return value
            value.update(fields)
            db.execute('UPDATE voice_jobs SET body=?,updated=? WHERE id=?', (json.dumps(value), time.time(), job))
            return value

    def read(self, owner, job):
        with self.lock:
            value = json.loads(self._row(owner, job)['body'])
            if job in self.live:
                self.live[job]['touched'] = time.monotonic()
            return value

    def create(self, owner, job, data):
        if not isinstance(data, dict) or set(data) - {'provider', 'source', 'audio'}:
            raise SpeechError('format', '转写请求格式无效。')
        provider, source = data.get('provider'), data.get('source')
        if provider not in MODELS or not isinstance(source, str) or not re.fullmatch(r'[a-f0-9]{32}|[a-f0-9]{64}', source):
            raise SpeechError('format', '转写服务或原音身份无效。')
        audio = None
        if 'audio' in data:
            try:
                audio = base64.b64decode(data['audio'], validate=True)
            except (TypeError, ValueError, binascii.Error):
                raise SpeechError('audio', '原音编码无效。') from None
            if not audio or len(audio) > MAX_AUDIO or hashlib.sha256(audio).hexdigest() != source:
                raise SpeechError('audio', '原音大小或校验不一致。')
        elif not HEX.fullmatch(source):
            raise SpeechError('source', '实时录音身份无效。')
        if not isinstance(job, str) or not ID.fullmatch(job):
            raise SpeechError('identity', '转写任务编号无效。')
        with self.lock, closing(self.store.connect()) as db, db:
            row = db.execute('SELECT * FROM voice_jobs WHERE id=?', (job,)).fetchone()
            if row:
                if row['owner'] == owner and row['provider'] == '':
                    return json.loads(row['body'])
                if (row['owner'], row['provider'], row['source']) != (owner, provider, source):
                    raise SpeechError('conflict', '转写编号已用于其他原音或服务。', 409)
                return json.loads(row['body'])
            if len(self.live) >= 2:
                raise SpeechError('busy', '当前已有两段语音正在转写，请稍后再试。', 429)
            if not self._authorized(owner):
                raise SpeechError('device', '本设备连接已撤销。', 403)
            is_file = audio is not None
            value = {'id': job, 'provider': provider, 'source': source,
                     'model': (FILE_MODELS if is_file else MODELS)[provider],
                     'state': 'connecting', 'text': '', 'offset': 0, 'usage': {}, 'metrics': {},
                     'mode': 'file' if is_file else 'realtime', 'replay': is_file}
            db.execute('INSERT INTO voice_jobs VALUES(?,?,?,?,?,?)', (job, owner, provider, source, json.dumps(value), time.time()))
            entry = {'stream': None, 'lock': threading.RLock(), 'owner': owner, 'touched': time.monotonic(), 'created': time.monotonic(), 'file': is_file}
            entry['thread'] = threading.Thread(
                target=self._transcribe_file if is_file else self._start,
                args=(job, provider, audio, entry) if is_file else (job, provider, entry),
                daemon=True,
            )
            # Make the receipt visible before the worker uses its own connection.
            db.commit()
            self.live[job] = entry
            entry['thread'].start()
        return value

    def _start(self, job, provider, entry):
        stream = None
        try:
            if not self._authorized(entry['owner']) or self.read(entry['owner'], job)['state'] != 'connecting':
                return
            stream = self.factory(provider, settings(self.config), lambda v: self._update(job, **{k: x for k, x in v.items() if k != 'state' or x in ('completed', 'failed')}))
            with self.lock:
                if not self._authorized(entry['owner']) or self.read(entry['owner'], job)['state'] != 'connecting':
                    stream.cancel()
                    return
                entry['stream'] = stream
                self._update(job, state='running')
        except Exception as error:
            error = error if isinstance(error, SpeechError) else error_for('')
            self._update(job, state='failed', code=error.code, error=str(error))
            if stream:
                stream.cancel()
        finally:
            if self.read(entry['owner'], job)['state'] in ('completed', 'failed', 'cancelled'):
                with self.lock:
                    self.live.pop(job, None)

    def _transcribe_file(self, job, provider, audio, entry):
        owner = entry['owner']

        def active():
            return self._authorized(owner) and self.read(owner, job)['state'] == 'running'

        try:
            self._update(job, state='running')
            result = self.file_transcriber(provider, settings(self.config), audio, active) if active() else None
            if result is not None and active():
                self._update(job, state='completed', **result)
            elif not self._authorized(owner):
                self._update(job, state='cancelled')
        except Exception as error:
            error = error if isinstance(error, SpeechError) else error_for('')
            self._update(job, state='failed', code=error.code, error=str(error))
        finally:
            with self.lock:
                self.live.pop(job, None)

    def append(self, owner, job, data):
        if not isinstance(data, dict) or set(data) != {'offset', 'audio'} or type(data['offset']) is not int or data['offset'] < 0:
            raise SpeechError('audio', '音频分段编号无效。')
        try:
            pcm = base64.b64decode(data['audio'], validate=True)
        except (ValueError, TypeError, binascii.Error):
            raise SpeechError('audio', '音频分段格式无效。') from None
        if not pcm or len(pcm) > 96000 or len(pcm) % 2:
            raise SpeechError('audio', '音频分段为空或超出限制。')
        self._row(owner, job)
        entry = self.live.get(job)
        if entry is None:
            raise SpeechError('ended', '这一轮转写已经结束，请核对结果。', 409)
        with entry['lock']:
            value = self.read(owner, job)
            offset, sha = data['offset'], hashlib.sha256(pcm).hexdigest()
            with closing(self.store.connect()) as db:
                prior = db.execute('SELECT sha256 FROM voice_chunks WHERE job=? AND offset=?', (job, offset)).fetchone()
            if prior:
                if prior['sha256'] != sha:
                    raise SpeechError('conflict', '已接收分段的内容不能改变。', 409)
                return value
            if value['replay'] or value['state'] != 'running' or offset != value['offset']:
                raise SpeechError('sequence', '音频接收进度已改变，请先核对当前进度。', 409)
            try:
                self._update(job, state='sending')
                entry['stream'].push(pcm)
            except SpeechError as error:
                self._update(job, state='failed', code=error.code, error=str(error))
                entry['stream'].cancel()
                raise
            with closing(self.store.connect()) as db, db:
                db.execute('INSERT INTO voice_chunks VALUES(?,?,?)', (job, offset, sha))
            return self._update(job, offset=offset + len(pcm), state='running')

    def finish(self, owner, job, data):
        self._row(owner, job)
        entry = self.live.get(job)
        if entry is None:
            return self.read(owner, job)
        with entry['lock']:
            value = self.read(owner, job)
            if value['state'] in ('completed', 'failed', 'cancelled', 'finishing'):
                return value
            if not isinstance(data, dict) or set(data) != {'bytes'} or type(data['bytes']) is not int or data['bytes'] != value['offset']:
                raise SpeechError('sequence', '原音尚未全部接收，请核对后完成转写。', 409)
            if value['state'] != 'running' or value['replay']:
                raise SpeechError('pending', '转写仍在准备，请稍候。', 409)
            try:
                entry['stream'].finish()
            except Exception as error:
                error = error if isinstance(error, SpeechError) else error_for('')
                entry['stream'].cancel()
                return self._update(job, state='failed', code=error.code, error=str(error))
            return self._update(job, state='finishing')

    def cancel(self, owner, job):
        with self.lock:
            try:
                self._row(owner, job)
            except SpeechError as error:
                if error.code != 'missing' or not self._authorized(owner):
                    raise
                # A cancel can arrive before a large upload on another connection.
                value = {'id': job, 'state': 'cancelled', 'text': '', 'offset': 0}
                with closing(self.store.connect()) as db, db:
                    inserted = db.execute('INSERT OR IGNORE INTO voice_jobs VALUES(?,?,?,?,?,?)',
                                          (job, owner, '', '', json.dumps(value), time.time()))
                    if not inserted.rowcount:
                        raise error
                return value
            entry = self.live.get(job)
            value = self._update(job, state='cancelled')
            if not entry or not entry['file']:
                self.live.pop(job, None)
        if entry and entry['stream']:
            entry['stream'].cancel()
        return value

    def _expire(self):
        while not self.stopped.wait(10):
            for job, entry in list(self.live.items()):
                if entry['file']:
                    if not self._authorized(entry['owner']):
                        self.cancel(entry['owner'], job)
                    continue
                stream = entry['stream']
                if not self._authorized(entry['owner']) or time.monotonic() - entry['touched'] > 120 or time.monotonic() - entry['created'] > 40 * 60:
                    self._update(job, state='failed', code='interrupted', error='转写连接已结束，原音仍保留，可以补转写。')
                    if stream:
                        stream.cancel()
                if stream and stream.done.is_set() or self.read(entry['owner'], job)['state'] in ('completed', 'failed', 'cancelled'):
                    with self.lock:
                        self.live.pop(job, None)
