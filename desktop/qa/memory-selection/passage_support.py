"""Token-aware HBM-00 experiment only. No production backend adoption."""
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
WORK = ROOT / '.local/hbm-00/passages-20261018'
REPORTS = ROOT / 'artifacts/hbm-00-passages-20261018'
PREVIOUS = ROOT / 'artifacts/hbm-00-independent-20261018'
MODEL = 'gpt-6.1-sol'
EFFORT = 'xhigh'


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def save(name, data):
    REPORTS.mkdir(parents=True, exist_ok=True)
    with (REPORTS / name).open('x', encoding='utf-8') as handle:
        handle.write(json.dumps(data, ensure_ascii=False, indent=2) + '\n')


def read(name):
    return json.loads((REPORTS / name).read_text(encoding='utf-8'))
