"""Isolated cross-question connection experiment; previous evidence stays immutable."""
import hashlib
import json
from pathlib import Path

ROOT=Path(__file__).resolve().parents[2]
WORK=ROOT/'.local/hbm-00/connection-20261018'
REPORTS=ROOT/'artifacts/hbm-00-connection-20261018'
PREVIOUS=ROOT/'artifacts/hbm-00-latency-20261018'
HOME=WORK/'codex-home'
MODEL='gpt-6.1-sol'
EFFORT='xhigh'

def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()

def save(name,data):
    REPORTS.mkdir(parents=True,exist_ok=True)
    with (REPORTS/name).open('x',encoding='utf-8') as f:
        json.dump(data,f,ensure_ascii=False,indent=2)
        f.write('\n')

def read(name):
    return json.loads((REPORTS/name).read_text(encoding='utf-8'))
