"""Freeze exact real project documents for normal UI import; never seed a database."""
from pathlib import Path
import hashlib
import json

desktop = Path(__file__).resolve().parents[2]
target = desktop / ".local/hbm-shared-memory-acceptance-20261020/vault"
target.mkdir(parents=True, exist_ok=False)
sources = ["INSIGHTS_IMPLEMENTATION_PLAN.md", "CODEX_SUITE.md", "LIBRARY_MANAGEMENT.md", "数据目录与整库备份.md"]
rows = []
for name in sources:
    source = desktop / "docs" / name
    content = source.read_bytes()
    assert len(content) <= 2_000_000
    (target / name).write_bytes(content)
    rows.append({"name": name, "source": f"docs/{name}", "sha256": hashlib.sha256(content).hexdigest(), "bytes": len(content)})
report = desktop / "artifacts/hbm-shared-memory-acceptance-20261020/corpus.json"
with report.open("x", encoding="utf-8") as stream:
    json.dump({"format": "hub-real-project-corpus-v1", "documents": rows, "vault": str(target), "originalsReadOnly": True}, stream, ensure_ascii=False, indent=2)
print(json.dumps({"documents": len(rows), "bytes": sum(row["bytes"] for row in rows), "manifest": str(report)}, ensure_ascii=False))
