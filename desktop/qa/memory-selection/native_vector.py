"""Isolated SQLite/sqlite-vec prototype with the same Chinese embedding weights.

This measures retrieval only. The Python host is an experiment fixture, not a
claim that a Rust/Hub embedding runtime or production memory backend is ready.
"""
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import time

ROOT = Path(__file__).resolve().parents[2]
WORK = ROOT / ".local/hbm-00"
REPORTS = ROOT / "artifacts/hbm-00-20261018"
os.environ["HF_HOME"] = str(WORK / "cache/huggingface")
os.environ["FASTEMBED_CACHE_PATH"] = str(WORK / "cache/models")
os.environ["TOKENIZERS_PARALLELISM"] = "false"

import psutil
import sqlite_vec
from fastembed import TextEmbedding


def main():
    began = time.perf_counter()
    corpus_path = Path(__file__).with_name("corpus.json")
    corpus = json.loads(corpus_path.read_text(encoding="utf-8"))
    lexical = json.loads((REPORTS / "native.json").read_text(encoding="utf-8"))
    lexical_results = {row["id"]: row["ids"] for row in lexical["results"]}
    identity = int(time.time())
    config = {"format": "hub-native-vector-prototype-contract-v1", "corpusSha256": hashlib.sha256(corpus_path.read_bytes()).hexdigest(), "embeddingModel": "BAAI/bge-small-zh-v1.5", "dimensions": 512, "queryEmbedding": "embed_documents, same as the Basic Memory tested provider", "minSimilarity": 0.65, "topK": 5, "rawLimit": 20, "hybridRanking": "Reciprocal rank fusion of existing Hub lexical IDs and cosine-qualified vector IDs, k=60", "runtimeScope": "Isolated Python prototype; Rust packaging and production integration unverified"}
    (REPORTS / f"native-vector-contract-{identity}.json").write_text(json.dumps(config, ensure_ascii=False, indent=2), encoding="utf-8")
    model = TextEmbedding(model_name=config["embeddingModel"], cache_dir=str(WORK / "cache/models"), threads=2)
    database = WORK / f"native-vector-{identity}.sqlite3"
    c = sqlite3.connect(database)
    c.enable_load_extension(True)
    sqlite_vec.load(c)
    c.enable_load_extension(False)
    c.executescript("CREATE TABLE memory(id TEXT PRIMARY KEY,project TEXT NOT NULL,status TEXT NOT NULL,body TEXT NOT NULL,body_hash TEXT NOT NULL); CREATE VIRTUAL TABLE memory_vec USING vec0(memory_id TEXT PRIMARY KEY, embedding FLOAT[512] distance_metric=cosine, project TEXT);")
    records = corpus["records"]
    bodies = [f'# {record["title"]}\n\n{record["content"]}' for record in records]
    for record, body, vector in zip(records, bodies, model.embed(bodies)):
        c.execute("INSERT INTO memory VALUES(?,?,?,?,?)", (record["id"], record["project"], record["status"], body, hashlib.sha256(body.encode()).hexdigest()))
        c.execute("INSERT INTO memory_vec(memory_id,embedding,project) VALUES(?,?,?)", (record["id"], sqlite_vec.serialize_float32(vector), record["project"]))
    c.commit()
    initialize_ms = (time.perf_counter() - began) * 1000
    vector_results, hybrid_results = [], []
    for question in corpus["queries"]:
        start = time.perf_counter()
        vector = next(model.embed([question["query"]]))
        rows = c.execute("SELECT memory_id,distance FROM memory_vec WHERE embedding MATCH ? AND k=20 AND project=? ORDER BY distance", (sqlite_vec.serialize_float32(vector), question["project"])).fetchall()
        ids = []
        for key, distance in rows:
            if 1.0 - distance < config["minSimilarity"]:
                continue
            record = c.execute("SELECT project,status,body,body_hash FROM memory WHERE id=?", (key,)).fetchone()
            if not record or record[0] != question["project"] or record[1] != "confirmed" or hashlib.sha256(record[2].encode()).hexdigest() != record[3]:
                continue
            ids.append(key)
        elapsed = (time.perf_counter() - start) * 1000
        vector_results.append({"id": question["id"], "ids": ids[:5], "rawCandidates": len(rows), "elapsedMs": elapsed})
        scores = {}
        for ranked in [lexical_results[question["id"]], ids]:
            for rank, key in enumerate(ranked, 1):
                scores[key] = scores.get(key, 0) + 1 / (60 + rank)
        fused = sorted(scores, key=lambda key: (-scores[key], key))[:5]
        hybrid_results.append({"id": question["id"], "ids": fused, "rawCandidates": len(scores), "elapsedMs": elapsed + next(row["elapsedMs"] for row in lexical["results"] if row["id"] == question["id"])})
    for mode, results in [("vector", vector_results), ("hybrid", hybrid_results)]:
        report = {"format": "hub-memory-selection-native-prototype-v1", "status": "completed", "mode": mode, "backend": config["runtimeScope"], "corpusSha256": config["corpusSha256"], "contract": config, "initializeAndIndexMs": initialize_ms, "results": results, "rssMiB": psutil.Process().memory_info().rss / 1024 ** 2, "databaseBytes": database.stat().st_size}
        path = REPORTS / f"native-{mode}-{identity}.json"
        path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(json.dumps({"report": str(path), "queries": len(results), "rssMiB": report["rssMiB"], "initializeAndIndexMs": initialize_ms}))
    c.close()


if __name__ == "__main__":
    main()
