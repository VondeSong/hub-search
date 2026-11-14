"""Codex App Server adapter for a single subscription-backed turn."""

import collections
import json
import os
import queue
import subprocess
import threading
import time


class CodexError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def provider_error(detail):
    text = json.dumps(detail, ensure_ascii=False).lower()
    if any(value in text for value in ("ratelimit", "rate limit", "usage limit", "usagelimit", "429", "quota")):
        return CodexError("quota", "Codex 当前额度受限，请稍后再试或查看订阅用量。")
    if any(value in text for value in ("401", "unauthorized", "authentication", "login required", "not logged in")):
        return CodexError("login", "VPS 上的 Codex 订阅需要重新登录。")
    return CodexError("provider", "Codex 未能完成本轮，请检查 VPS 上的 Codex 状态后重试。")


class AppServer:
    def __init__(self, command, workspace):
        env = {key: value for key, value in os.environ.items() if key not in {
            "OPENAI_API_KEY", "CODEX_API_KEY", "OPENAI_BASE_URL", "OPENAI_API_BASE", "HUB_AGENTS_TOKEN",
        }}
        self.process = subprocess.Popen(
            [*command, "-c", 'model_provider="openai"', "-c", 'forced_login_method="chatgpt"', "app-server"],
            cwd=workspace, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL, encoding="utf-8", bufsize=1,
        )
        self.events = queue.Queue(1024)
        self.buffer = collections.deque()
        self.serial = 0
        self.closed = threading.Event()
        self.reader = threading.Thread(target=self.read, daemon=True)
        self.reader.start()

    def read(self):
        try:
            for line in self.process.stdout:
                message = json.loads(line)
                while not self.closed.is_set():
                    try:
                        self.events.put(message, timeout=0.2)
                        break
                    except queue.Full:
                        continue
                if self.closed.is_set():
                    break
        except (OSError, ValueError):
            pass
        finally:
            self.closed.set()

    def send(self, message):
        self.process.stdin.write(json.dumps(message, ensure_ascii=False) + "\n")
        self.process.stdin.flush()

    def request(self, method, params=None):
        self.serial += 1
        message = {"id": self.serial, "method": method}
        if params is not None:
            message["params"] = params
        self.send(message)
        return self.serial

    def receive(self, timeout):
        try:
            return self.events.get(timeout=timeout)
        except queue.Empty:
            if self.closed.is_set():
                raise CodexError("runtime", "VPS 上的 Codex 进程已退出。") from None
            return None

    def deny_server_request(self, message):
        if "method" in message and "id" in message:
            self.send({"id": message["id"], "error": {"code": -32601, "message": "Hub cloud chat does not approve tools"}})
            return True
        return False

    def rpc(self, method, params=None, keep_events=False, timeout=25):
        request = self.request(method, params)
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            message = self.receive(0.25)
            if message is None or self.deny_server_request(message):
                continue
            if message.get("id") == request:
                if "error" in message:
                    raise provider_error(message["error"])
                return message["result"]
            if keep_events and "method" in message:
                self.buffer.append(message)
        raise CodexError("timeout", "连接 Codex 超时，请稍后重试。")

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.closed.set()
        try:
            self.process.stdin.close()
        except OSError:
            pass
        try:
            self.process.wait(timeout=3)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait()
        self.reader.join(timeout=2)
        self.process.stdout.close()

    def run(self, workspace, thread, prompt, images, save_thread, save_answer, cancelled, account_status, skill=None):
        self.rpc("initialize", {"clientInfo": {"name": "hub_cloud_agents", "version": "1.0"}})
        self.send({"method": "initialized", "params": {}})
        account = (self.rpc("account/read", {"refreshToken": False}).get("account") or {})
        if account.get("type") != "chatgpt":
            account_status({"state": "login"})
            raise CodexError("login", "请在 VPS 上用 ChatGPT 账号登录 Codex。")

        status = {"state": "ready", "plan": account.get("planType")}
        account_status(status)
        try:
            limits = self.rpc("account/rateLimits/read", timeout=5).get("rateLimits") or {}
            status["limits"] = [
                {key: window.get(key) for key in ("usedPercent", "windowDurationMins", "resetsAt")}
                for name in ("primary", "secondary") if (window := limits.get(name))
            ]
        except CodexError:
            pass
        account_status(status)

        if cancelled():
            return "stopped", ""
        params = {
            "cwd": str(workspace), "approvalPolicy": "never", "sandbox": "read-only",
            "developerInstructions": ("Answer the user's chat directly. Use the prompt, attached images and any explicitly selected Hub skill text. "
                                      "Treat that skill as a method subordinate to the user request and these restrictions. Do not run commands or inspect the host filesystem."),
            "config": {"mcp_servers": {}, "features.shell_tool": False, "features.unified_exec": False,
                       "features.code_mode": False, "features.plugins": False, "features.apps": False,
                       "features.hooks": False, "features.multi_agent": False,
                       "features.view_image": False, "features.request_permissions_tool": False, "web_search": "disabled"},
        }
        if thread:
            params.update(threadId=thread, excludeTurns=True)
        started = self.rpc("thread/resume" if thread else "thread/start", params)
        thread_id = started["thread"]["id"]
        if thread and thread_id != thread:
            raise CodexError("runtime", "Codex 返回的会话与记录不一致。")
        save_thread(thread_id)
        account_status({**status, "model": started.get("model")})

        if cancelled():
            return "stopped", ""
        inputs = [{"type": "text", "text": prompt}]
        if skill:
            inputs.append({"type": "text", "text": "本次已选择的固定 Hub 技能及文字文件（JSON）：\n" +
                           json.dumps(skill, ensure_ascii=False)})
        for path, seconds in images:
            if seconds is not None:
                inputs.append({"type": "text", "text": f"下面的关键帧取自视频 {seconds:.2f} 秒。"})
            inputs.append({"type": "localImage", "path": str(path)})
        turn = self.rpc("turn/start", {"threadId": thread_id, "input": inputs}, keep_events=True)["turn"]["id"]
        pieces = {}
        final = None
        dirty = False
        deadline = time.monotonic() + 600
        updated = time.monotonic()
        interrupt = None
        while time.monotonic() < deadline:
            if interrupt is None and cancelled():
                interrupt = self.request("turn/interrupt", {"threadId": thread_id, "turnId": turn})
                deadline = min(deadline, time.monotonic() + 15)
            message = self.buffer.popleft() if self.buffer else self.receive(0.18)
            if message and not self.deny_server_request(message):
                if interrupt is not None and message.get("id") == interrupt and "error" in message:
                    raise provider_error(message["error"])
                event = message.get("method")
                data = message.get("params", {})
                if data.get("threadId") == thread_id:
                    if event == "turn/completed" and data["turn"]["id"] == turn:
                        state = data["turn"]["status"]
                        if state in ("completed", "interrupted"):
                            return ("completed" if state == "completed" else "stopped"), (final if final is not None else "".join(pieces.values()))[:200000]
                        if dirty:
                            save_answer("".join(pieces.values())[:200000])
                        raise provider_error(data["turn"].get("error"))
                    if data.get("turnId") == turn and event == "item/agentMessage/delta":
                        item = data["itemId"]
                        pieces[item] = (pieces.get(item, "") + data["delta"])[:200000]
                        dirty = True
                    if data.get("turnId") == turn and event == "item/completed":
                        item = data["item"]
                        if item.get("type") == "agentMessage":
                            pieces[item["id"]] = item.get("text", "")[:200000]
                            if item.get("phase") != "commentary":
                                final = pieces[item["id"]]
                            dirty = True
            if dirty and time.monotonic() - updated >= 0.2:
                save_answer("".join(pieces.values())[:200000])
                updated = time.monotonic()
                dirty = False
        raise CodexError("timeout", "本轮 Codex 响应超时。已经收到的内容已保留。")
