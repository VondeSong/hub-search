"""Owned, bounded backend comparison. Previous experiment evidence is immutable."""
import hashlib
import json
from pathlib import Path
from datetime import datetime, timezone

ROOT = Path(__file__).resolve().parents[2]
WORK = ROOT / '.local/hbm-00/parity-20261018c'
REPORTS = ROOT / 'artifacts/hbm-00-parity-20261018c'
HOME = WORK / 'codex-home'
VAULT = Path('D:/03_Resources/Software/Apps/Obsidian/OS')
MODEL, EFFORT = 'gpt-6.1-sol', 'xhigh'

def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()

def now():
    return datetime.now(timezone.utc).isoformat()

def save(name, value):
    REPORTS.mkdir(parents=True, exist_ok=True)
    with (REPORTS / name).open('x', encoding='utf-8') as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2)
        stream.write('\n')

def read(name):
    return json.loads((REPORTS / name).read_text(encoding='utf-8'))

def runtime_save(name, value):
    path = WORK / name
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('x', encoding='utf-8') as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2)

