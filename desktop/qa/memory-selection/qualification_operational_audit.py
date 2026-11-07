"""Summarize existing operational evidence against the preregistered gates.

No backend runs, repair, score relabeling or adoption. An incomplete gate fails
closed. Component timings must never be compared as complete product costs.
"""
from collections import Counter
import json
import psutil

from qualification_contract import ROOT, WORK, REPORTS, read, save, digest, now


def alive(pid, created):
    try:
        return abs(psutil.Process(pid).create_time() - created) < .01
    except psutil.NoSuchProcess:
        return False


def audit():
    rust = read('rust-runtime-probe.json')
    bm = read('bm-lifecycle-result.json')
    assert rust['status'] in ['completed', 'failed']
    assert bm['status'] in ['completed', 'failed']
    method = read('new-method-contract-v2.json')
    scope = read('scope-contract.json')
    unchanged = {
        'qualityMethod': all(digest(ROOT/'qa/memory-selection'/name) == sha
                             for name, sha in method['sourceIdentity'].items()),
        'bmLifecycleDriver': digest(ROOT/'qa/memory-selection/qualification_bm_lifecycle.py') ==
                             read('bm-lifecycle-contract-v2.json')['sources']['qualification_bm_lifecycle.py'],
        'productionCargo': all(digest(ROOT/name) == scope['baseline'][name]
                               for name in ['src-tauri/Cargo.toml', 'src-tauri/Cargo.lock']),
    }
    assert all(unchanged.values()), unchanged
    residual = []
    for run in rust.get('runs', []):
        if alive(run['pid'], run['createTime']):
            residual.append({'kind': 'rust', 'pid': run['pid']})
    for directory in ['state', 'restored']:
        path = WORK/'bm-lifecycle'/directory/'process.json'
        if not path.exists():
            continue
        process = json.loads(path.read_text(encoding='utf-8'))
        for member in process.get('owned', [process]):
            if alive(member['pid'], member['createTime']):
                residual.append({'kind': 'bm', 'pid': member['pid']})
    operations = bm.get('operations', [])
    counts = Counter(r['kind'] for r in operations if r['status'] == 'completed')
    cold = bm.get('coldRuns', [])
    report = {
        'at': now(), 'kind': 'post-run operational evidence, not backend adoption',
        'unchanged': unchanged,
        'rawReports': {name: digest(REPORTS/name) for name in [
            'rust-runtime-probe.json', 'bm-managed-runtime-install.json',
            'bm-lifecycle-result.json', 'bm-lifecycle-contract-v2.json', 'scope-contract.json']},
        'rustComponent': {'runStatus': rust['status'], 'coldFirstUsableMs':
                          [r['firstUsableMs'] for r in rust.get('runs', [])],
                          'completeHubBackendTest': False},
        'basicMemory': {
            'runStatus': bm['status'], 'errorType': bm.get('errorType'), 'error': bm.get('error'),
            'initialIndex': bm.get('initialIndex'),
            'coldFirstUsableMs': [r['firstUsableMs'] for r in cold],
            'fiveColdStartsWithin10s': len(cold) == 5 and all(r['firstUsableMs'] <= 10000 for r in cold),
            'completedOperations': dict(counts),
            'all60MutationChecks': all(counts[k] == 20 for k in ['update', 'delete', 'replace']),
            'backupRestorePassed': bm.get('backupRestorePassed', False),
            'crashVerified': False, 'derivedHubSummariesVerified': False,
            'real24hVerified': False, 'wallMs': bm.get('wallMs'),
        },
        'residualOwnedProcesses': residual,
        'fullOperationalGatePassed': False,
        'backendSelected': False,
        'limitations': [
            'Rust embedding component and Basic Memory full service are different scopes.',
            'Shared segmentation, evidence budget and reranker still use Python QA.',
            'Initial index setup is separate from fresh-process startup with installed index.',
            'No full native persistent lifecycle arm, crash recovery, derived-history erasure, upgrade/rollback or real24h proof.',
            'Quality, true task benefit, exact model budget and local latency gates remain open.',
        ],
    }
    save('operational-audit.json', report)
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    audit()
