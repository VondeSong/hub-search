"""Aggregate only retrieval receipts whose corpus/index readiness was proved."""
import hashlib
import json
from pathlib import Path
import statistics

ROOT = Path(__file__).resolve().parents[2]
REPORTS = ROOT / "artifacts/hbm-00-20261018"


def evaluate(corpus, result):
    by_id = {q["id"]: q for q in corpus["queries"]}
    records = {r["id"]: r for r in corpus["records"]}
    positives = [q for q in corpus["queries"] if q["expected"]]
    recovered = relevant = selected = negative_cases = scope_violations = 0
    failures = []
    if {row["id"] for row in result["results"]} != set(by_id):
        raise ValueError("Retrieval receipt did not cover the exact frozen query set")
    for row in result["results"]:
        question = by_id[row["id"]]
        ids = row["ids"]
        hits = set(ids) & set(question["expected"])
        recovered += bool(hits)
        relevant += len(hits)
        selected += len(ids)
        negative_cases += bool(not question["expected"] and ids)
        for identity in ids:
            record = records.get(identity)
            scope_violations += int(not record or record["project"] != question["project"] or record["status"] != "confirmed")
        if question["expected"] and not hits or not question["expected"] and ids:
            failures.append({"id": row["id"], "category": question["category"], "query": question["query"], "expected": question["expected"], "selected": ids})
    latency = [row["elapsedMs"] for row in result["results"]]
    recall = recovered / len(positives)
    precision = relevant / selected if selected else 0.0
    return {"queries": len(by_id), "positiveQueries": len(positives), "recallAt5": recall, "selectedContextPrecision": precision, "negativeContextCases": negative_cases, "scopeStateViolationsInSelectedContext": scope_violations, "latencyMedianMs": statistics.median(latency), "latencyP95Ms": statistics.quantiles(latency, n=100, method="inclusive")[94], "retrievalGatesPassed": recall >= 0.9 and precision >= 0.8 and negative_cases == 0 and scope_violations == 0, "failures": failures, "gateScope": "Experimental context selection only; no model or production memory integration"}


def main():
    corpus_path = Path(__file__).with_name("corpus.json")
    corpus = json.loads(corpus_path.read_text(encoding="utf-8"))
    corpus_hash = hashlib.sha256(corpus_path.read_bytes()).hexdigest()
    summaries = {}
    candidates = sorted(REPORTS.glob("basic-memory-*-benchmark-*.json"))
    candidates.extend(sorted(REPORTS.glob("native-vector-[0-9]*.json")))
    candidates.extend(sorted(REPORTS.glob("native-hybrid-[0-9]*.json")))
    native = REPORTS / "native.json"
    if native.exists():
        candidates.append(native)
    excluded = []
    for path in candidates:
        result = json.loads(path.read_text(encoding="utf-8"))
        is_native = result.get("format") in ["hub-memory-selection-native-v1", "hub-memory-selection-native-prototype-v1"]
        if not is_native and (result.get("status") != "completed" or result.get("indexReadiness", {}).get("status") != "ready"):
            excluded.append({"path": path.name, "reason": "Not completed or index readiness unproved"})
            continue
        if is_native and result["corpusSha256"] != corpus_hash:
            raise ValueError("Native corpus identity mismatch")
        key = ("native-" + result["mode"] if result.get("format") == "hub-memory-selection-native-prototype-v1" else "native") if is_native else "basic-memory-" + result["mode"]
        summaries[key] = {"receipt": path.name, "receiptSha256": hashlib.sha256(path.read_bytes()).hexdigest(), **evaluate(corpus, result), "initializeMs": result.get("initializeMs"), "initializeAndIndexMs": result.get("initializeAndIndexMs"), "indexReadiness": result.get("indexReadiness"), "usageAtEnd": result.get("usageAtEnd"), "residual": result.get("residual")}
    summary = {"format": "hub-memory-selection-summary-v1", "corpusSha256": corpus_hash, "corpusScope": corpus["sourceScope"], "results": summaries, "excluded": excluded, "backendDecision": "undecided", "unverifiedGates": ["20-task real-model paired effect evaluation", "24-hour fixed workload and restart/lifecycle validation", "Representative personal-library corpus", "Production memory integration and installed Hub cold start"]}
    (REPORTS / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({key: {name: value for name, value in item.items() if name not in ["failures", "usageAtEnd", "receiptSha256"]} for key, item in summaries.items()}, ensure_ascii=False))


if __name__ == "__main__":
    main()
