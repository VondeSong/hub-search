"""HBM-00 common query/evidence repair; owned paths, immutable old evidence."""
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
WORK = ROOT / '.local/hbm-00/grounding-20261018c'
REPORTS = ROOT / 'artifacts/hbm-00-grounding-20261018c'
HOME = WORK / 'codex-home'
VAULT = Path('D:/03_Resources/Software/Apps/Obsidian/OS')
MODEL, EFFORT = 'gpt-6.1-sol', 'xhigh'

def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()

def now():
    return datetime.now(timezone.utc).isoformat()

def save(name, value):
    REPORTS.mkdir(parents=True, exist_ok=True)
    with (REPORTS / name).open('x', encoding='utf-8') as f:
        json.dump(value, f, ensure_ascii=False, indent=2)
        f.write('\n')

def read(name):
    return json.loads((REPORTS / name).read_text(encoding='utf-8'))

def sources():
    names = ['grounding_support.py','grounding_index.py','grounding_policy.py',
             'grounding_run.py','grounding_score.py','grounding_data.py','grounding_checks.py',
             'parity_index.py','passage_index.py','run.py','applicability_policy.py',
             'accounting_transport.py','accounting_support.py','connection_transport.py',
             'connection_support.py','latency_transport.py','latency_reuse.py']
    return {n: digest(Path(__file__).with_name(n)) for n in names}

def transport():
    import accounting_support as shared
    shared.WORK, shared.HOME, shared.REPORTS = WORK, HOME, REPORTS
    import accounting_transport
    return accounting_transport
