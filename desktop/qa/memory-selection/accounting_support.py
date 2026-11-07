"""Final HBM-00 latency/accounting round; old evidence remains immutable."""
import hashlib
import json
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
WORK=ROOT/'.local/hbm-00/accounting-20261018'
REPORTS=ROOT/'artifacts/hbm-00-accounting-20261018'
HOME=WORK/'codex-home'
PREVIOUS=ROOT/'artifacts/hbm-00-connection-20261018'
MODEL='gpt-6.1-sol'
EFFORT='xhigh'
def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()
def save(name,value):
    REPORTS.mkdir(parents=True,exist_ok=True)
    with (REPORTS/name).open('x',encoding='utf-8') as file:
        json.dump(value,file,ensure_ascii=False,indent=2); file.write('\n')
def read(name):
    return json.loads((REPORTS/name).read_text(encoding='utf-8'))
