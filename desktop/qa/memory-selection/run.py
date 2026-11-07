"""HBM-00 real local MCP protocol/retrieval and bounded soak runner.

Requires the explicitly selected isolated Python environment. Never touches the
default Basic Memory configuration, personal vaults, or production Hub data.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import queue
import subprocess
import sys
import threading
import time

import psutil

ROOT = Path(__file__).resolve().parents[2]
WORK = ROOT / ".local/hbm-00"
REPORTS = ROOT / "artifacts/hbm-00-20261018"
MODEL = "BAAI/bge-small-zh-v1.5"


def save(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".partial")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(path)


def prepare(mode):
    corpus_path = Path(__file__).with_name("corpus.json")
    corpus = json.loads(corpus_path.read_text(encoding="utf-8"))
    state = WORK / (mode + "-v2")
    config = state / "config"
    config.mkdir(parents=True, exist_ok=True)
    projects = {project: {"path": str(state / "notes" / project), "mode": "local"} for project in ["hub", "other", "private"]}
    for project in projects.values():
        Path(project["path"]).mkdir(parents=True, exist_ok=True)
    for item in corpus["records"]:
        path = Path(projects[item["project"]]["path"]) / (item["id"] + ".md")
        body = f'---\ntitle: {item["title"]}\ntype: note\npermalink: {item["id"]}\nhub_id: {item["id"]}\nhub_status: {item["status"]}\n---\n\n# {item["title"]}\n\n{item["content"]}\n'
        if not path.exists():
            path.write_text(body, encoding="utf-8")
    settings = {"projects": projects, "default_project": None, "auto_update": False, "cloud_promo_opt_out": True, "logfire_enabled": False, "logfire_send_to_logfire": False, "semantic_search_enabled": mode == "hybrid", "semantic_embedding_model": MODEL, "semantic_embedding_dimensions": 512, "semantic_embedding_threads": 2, "semantic_embedding_cache_dir": str(WORK / "cache/models"), "semantic_min_similarity": 0.65, "reranker_enabled": False, "index_changes": True, "index_delay": 1000}
    save(config / "config.json", settings)
    REPORTS.mkdir(parents=True, exist_ok=True)
    contract = {"format": "hub-memory-selection-contract-v2", "corpusSha256": hashlib.sha256(corpus_path.read_bytes()).hexdigest(), "basicMemoryVersion": importlib.metadata.version("basic-memory"), "python": sys.version, "embeddingModel": MODEL, "embeddingDimensions": 512, "semanticMinSimilarity": 0.65, "topK": 5, "rawCandidateLimit": 20, "warmRssCeilingMiB": 1536, "warm24hGrowthCeilingPercent": 10, "managedDiskCeilingGiB": 8, "freeDiskFloorGiB": 10, "soakSeconds": 86400, "cadenceSeconds": 60, "sourceScope": corpus["sourceScope"], "nativeBackend": "Existing Hub SQLite/Tantivy/EvidenceReader; experimental manifest only", "modelEffects": "Separate opt-in model evaluation; no model calls in retrieval or soak", "revisionReason": "Set supported Chinese embedding dimensions explicitly (512); v1 failed configuration retained"}
    contract_path = REPORTS / "contract-v2.json"
    if contract_path.exists() and json.loads(contract_path.read_text(encoding="utf-8")) != contract:
        raise RuntimeError("Frozen contract changed; create a new experiment identity")
    save(contract_path, contract)
    versions = sorted(f'{dist.metadata["Name"]}=={dist.version}' for dist in importlib.metadata.distributions())
    (REPORTS / "requirements.freeze.txt").write_text("\n".join(versions) + "\n", encoding="utf-8")
    return corpus, state


def environment(state, mode):
    inherited = ["SYSTEMROOT", "WINDIR", "PATH", "TEMP", "TMP", "COMSPEC", "PATHEXT", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "PROGRAMDATA"]
    env = {name: os.environ[name] for name in inherited if name in os.environ}
    env.update({"PYTHONIOENCODING": "utf-8", "PYTHONUTF8": "1", "BASIC_MEMORY_CONFIG_DIR": str(state / "config"), "BASIC_MEMORY_HOME": str(state / "notes/hub"), "BASIC_MEMORY_FORCE_LOCAL": "true", "BASIC_MEMORY_AUTO_UPDATE": "false", "BASIC_MEMORY_NO_PROMOS": "1", "BASIC_MEMORY_LOGFIRE_ENABLED": "false", "BASIC_MEMORY_LOGFIRE_SEND_TO_LOGFIRE": "false", "BASIC_MEMORY_SEMANTIC_SEARCH_ENABLED": str(mode == "hybrid").lower(), "BASIC_MEMORY_SEMANTIC_EMBEDDING_MODEL": MODEL, "BASIC_MEMORY_SEMANTIC_EMBEDDING_DIMENSIONS": "512", "BASIC_MEMORY_SEMANTIC_EMBEDDING_THREADS": "2", "BASIC_MEMORY_SEMANTIC_EMBEDDING_CACHE_DIR": str(WORK / "cache/models"), "FASTEMBED_CACHE_PATH": str(WORK / "cache/models"), "HF_HOME": str(WORK / "cache/huggingface"), "TOKENIZERS_PARALLELISM": "false", "FASTMCP_CHECK_FOR_UPDATES": "off", "FASTMCP_SHOW_SERVER_BANNER": "false"})
    return env


class Mcp:
    def __init__(self, state, mode):
        self.state = state
        self.sequence = 0
        self.lines = queue.Queue()
        self.stderr = (state / "mcp.stderr.log").open("ab")
        began = time.perf_counter()
        self.process = subprocess.Popen([sys.executable, "-m", "basic_memory.cli.main", "mcp", "--transport", "stdio"], cwd=ROOT, env=environment(state, mode), stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=self.stderr, creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
        self.started_at = psutil.Process(self.process.pid).create_time()
        save(state / "process.json", {"pid": self.process.pid, "createTime": self.started_at, "python": sys.executable, "state": str(state), "status": "starting"})
        threading.Thread(target=self._read, daemon=True).start()
        try:
            response = self.rpc("initialize", {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "hub-hbm-00", "version": "1"}}, timeout=180)
            self.notify("notifications/initialized", {})
            self.catalog = self.rpc("tools/list", {}, timeout=180)["tools"]
        except BaseException:
            self.close()
            raise
        self.initialize_ms = (time.perf_counter() - began) * 1000
        save(state / "process.json", {"pid": self.process.pid, "createTime": self.started_at, "python": sys.executable, "state": str(state), "initializeMs": self.initialize_ms, "protocol": response.get("protocolVersion"), "status": "running"})

    def _read(self):
        for line in self.process.stdout:
            self.lines.put(line)
        self.lines.put(None)

    def notify(self, method, params):
        self.process.stdin.write((json.dumps({"jsonrpc": "2.0", "method": method, "params": params}) + "\n").encode())
        self.process.stdin.flush()

    def rpc(self, method, params, timeout=60):
        self.sequence += 1
        identity = self.sequence
        self.process.stdin.write((json.dumps({"jsonrpc": "2.0", "id": identity, "method": method, "params": params}) + "\n").encode())
        self.process.stdin.flush()
        deadline = time.monotonic() + timeout
        while True:
            try:
                line = self.lines.get(timeout=max(0.01, deadline - time.monotonic()))
            except queue.Empty:
                raise TimeoutError(f"MCP {method} timed out")
            if line is None:
                raise RuntimeError(f"MCP exited {self.process.poll()}; see {self.state / 'mcp.stderr.log'}")
            value = json.loads(line)
            if value.get("id") != identity:
                continue
            if "error" in value:
                raise RuntimeError(json.dumps(value["error"], ensure_ascii=False))
            return value["result"]

    def call(self, name, arguments):
        result = self.rpc("tools/call", {"name": name, "arguments": arguments}, timeout=180)
        if result.get("isError"):
            raise RuntimeError(json.dumps(result, ensure_ascii=False)[:2000])
        if isinstance(result.get("structuredContent"), dict):
            return result["structuredContent"]
        texts = [item["text"] for item in result.get("content", []) if item.get("type") == "text"]
        if len(texts) == 1:
            try:
                return json.loads(texts[0])
            except ValueError:
                return {"text": texts[0]}
        return result

    def usage(self):
        try:
            parent = psutil.Process(self.process.pid)
            processes = [parent, *parent.children(recursive=True)]
        except psutil.NoSuchProcess:
            processes = []
        members = []
        for process in processes:
            try:
                if process.is_running():
                    members.append({"pid": process.pid, "createTime": process.create_time(), "name": process.name(), "rssMiB": process.memory_info().rss / 1024 ** 2})
            except psutil.NoSuchProcess:
                pass
        return {"processes": len(members), "rssMiB": sum(p["rssMiB"] for p in members), "pid": self.process.pid, "members": members}

    def close(self):
        owned = self.usage()["members"] if self.process.poll() is None else []
        if self.process.poll() is None:
            self.process.stdin.close()
            try:
                self.process.wait(timeout=15)
            except subprocess.TimeoutExpired:
                self.process.terminate()
                self.process.wait(timeout=10)
        residual = []
        for member in owned:
            try:
                process = psutil.Process(member["pid"])
                if process.create_time() != member["createTime"]:
                    continue
                process.wait(timeout=3)
            except psutil.TimeoutExpired:
                process.terminate()
                try:
                    process.wait(timeout=5)
                except psutil.TimeoutExpired:
                    residual.append(member)
            except psutil.NoSuchProcess:
                pass
        self.residual = residual
        self.stderr.close()
        save(self.state / "process.json", {"pid": self.process.pid, "createTime": self.started_at, "status": "residual" if residual else "exited", "exitCode": self.process.returncode, "owned": owned, "residual": residual})


def results_from(response):
    if isinstance(response.get("result"), dict):
        response = response["result"]
    if "results" not in response:
        raise ValueError(f"Unexpected structured search response: {json.dumps(response, ensure_ascii=False)[:2000]}")
    return response["results"]


def hit_identity(hit):
    permalink = hit.get("permalink") or hit.get("file_path") or hit.get("entity", {}).get("permalink") or ""
    return permalink.replace("\\", "/").rstrip("/").split("/")[-1].removesuffix(".md")


def wait_ready(client, corpus, mode, receipt, destination):
    """MCP initialization does not imply that background file/vector indexing ended."""
    began = time.monotonic()
    missing = list(corpus["records"])
    while missing:
        remaining = []
        for record in missing:
            response = client.call("search_notes", {"query": record["content"] if mode == "hybrid" else record["title"], "project": record["project"], "search_type": "vector" if mode == "hybrid" else "text", "entity_types": ["entity"], "page_size": 20, "output_format": "json", "min_similarity": 0.0})
            if not any(hit_identity(hit) == record["id"] for hit in results_from(response)):
                remaining.append(record)
        missing = remaining
        receipt["indexReadiness"] = {"expectedRecords": len(corpus["records"]), "missingIds": [record["id"] for record in missing], "elapsedMs": (time.monotonic() - began) * 1000, "status": "waiting" if missing else "ready"}
        save(destination, receipt)
        if missing:
            if time.monotonic() - began > 300:
                raise TimeoutError("Background index did not become ready within the declared 300-second initialization budget")
            time.sleep(2)


def retrieve(client, corpus, state, question, mode):
    began = time.perf_counter()
    response = client.call("search_notes", {"query": question["query"], "project": question["project"], "search_all_projects": False, "page_size": 20, "search_type": "hybrid" if mode == "hybrid" else "text", "entity_types": ["entity"], "output_format": "json", "min_similarity": 0.65})
    records = {record["id"]: record for record in corpus["records"]}
    ids, raw = [], results_from(response)
    for hit in raw:
        identity = hit_identity(hit)
        record = records.get(identity)
        if not record or record["status"] != "confirmed" or record["project"] != question["project"] or identity in ids:
            continue
        source = state / "notes" / record["project"] / (identity + ".md")
        if record["content"] not in source.read_text(encoding="utf-8"):
            continue
        ids.append(identity)
        if len(ids) == 5:
            break
    return {"id": question["id"], "ids": ids, "rawCandidates": len(raw), "elapsedMs": (time.perf_counter() - began) * 1000}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("phase", choices=["smoke", "benchmark", "soak"])
    parser.add_argument("--mode", choices=["text", "hybrid"], default="text")
    parser.add_argument("--seconds", type=int, default=86400)
    args = parser.parse_args()
    corpus, state = prepare(args.mode)
    if psutil.disk_usage(str(WORK)).free < 10 * 1024 ** 3:
        raise RuntimeError("Managed experiment free-disk floor not met")
    client = None
    receipt = {"format": "hub-memory-selection-bm-v1", "contractRevision": 2, "phase": args.phase, "mode": args.mode, "runnerSha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(), "startedAt": time.time(), "status": "starting"}
    destination = REPORTS / f"basic-memory-{args.mode}-{args.phase}-{int(receipt['startedAt'])}.json"
    save(destination, receipt)
    try:
        client = Mcp(state, args.mode)
        receipt.update({"initializeMs": client.initialize_ms, "tools": [tool["name"] for tool in client.catalog], "usageAtStart": client.usage(), "status": "running"})
        save(destination, receipt)
        wait_ready(client, corpus, args.mode, receipt, destination)
        if args.phase == "smoke":
            result = client.call("search_notes", {"query": "记忆后端", "project": "hub", "search_type": "hybrid" if args.mode == "hybrid" else "text", "output_format": "json", "entity_types": ["entity"]})
            receipt["searchResponse"] = result
            receipt["readResponse"] = client.call("read_note", {"identifier": "backend-selection", "project": "hub", "output_format": "json"})
            content = receipt["readResponse"].get("result", receipt["readResponse"]).get("content")
            if not content or "HBM-00" not in content:
                raise RuntimeError("MCP read did not return the expected authoritative note")
        elif args.phase == "benchmark":
            receipt["results"] = []
            for question in corpus["queries"]:
                receipt["results"].append(retrieve(client, corpus, state, question, args.mode))
                save(destination, receipt)
        else:
            receipt["samples"] = []
            deadline = time.monotonic() + args.seconds
            while time.monotonic() < deadline:
                question = corpus["queries"][len(receipt["samples"]) % len(corpus["queries"])]
                result = retrieve(client, corpus, state, question, args.mode)
                receipt["samples"].append({"at": time.time(), **client.usage(), "queryId": question["id"], "elapsedMs": result["elapsedMs"]})
                save(destination, receipt)
                time.sleep(min(60, max(0, deadline - time.monotonic())))
            receipt["durationSeconds"] = args.seconds
            receipt["qualifies24h"] = args.seconds >= 86400
        receipt["usageAtEnd"] = client.usage()
        receipt["status"] = "completed"
    except Exception as error:
        receipt.update({"status": "failed", "error": str(error)[:3000]})
        raise
    finally:
        if client is not None:
            client.close()
            receipt["processExitCode"] = client.process.returncode
            receipt["residual"] = client.residual
        receipt["finishedAt"] = time.time()
        save(destination, receipt)
        print(json.dumps({"report": str(destination), "status": receipt["status"], "initializeMs": receipt.get("initializeMs"), "usage": receipt.get("usageAtEnd"), "queries": len(receipt.get("results", []))}))


if __name__ == "__main__":
    main()
