"""Read-only diagnosis of the preserved first lifecycle visibility failure."""
import json
import re
from datetime import datetime
from qualification_contract import read, save, digest, now
from qualification_bm_lifecycle import AREA, inspect, body


def diagnose():
    result = read('bm-lifecycle-result.json')
    assert result['status'] == 'failed' and result['errorType'] == 'TimeoutError'
    process = json.loads((AREA/'state/process.json').read_text(encoding='utf-8'))
    assert process['status'] == 'exited' and not process['residual']
    state = inspect(AREA/'state')
    mid = 'hbm-op-000'
    note = AREA/'state/notes/left'/f'{mid}.md'
    text = note.read_text(encoding='utf-8')
    chunks = [c for c in state['chunks'] if c[0] == mid]
    rows = [s for s in state['search'] if s[0] == mid]
    logs = list((AREA/'state/config').glob('basic-memory-*.log'))
    matches = [(p, p.read_text(encoding='utf-8')) for p in logs]
    matches = [(p,t) for p,t in matches if 'tool=write_note' in t]
    assert len(matches) == 1
    path, log = matches[0]
    events = [line for line in log.splitlines() if any(marker in line for marker in [
        'MCP tool response: tool=write_note', 'Vector batch sync start:',
        'Vector batch sync complete:', 'Stopping watch coordinator',
        'Indexing markdown file: hbm-op-000.md'])]
    ack = next(line for line in events if 'MCP tool response:' in line)
    done = next(line for line in events if 'Vector batch sync complete:' in line)
    stamp = lambda line: datetime.strptime(line[:23], '%Y-%m-%d %H:%M:%S.%f')
    report = {
        'at': now(), 'kind': 'post-failure read-only diagnosis; no rerun or threshold change',
        'frozenResultUnchanged': True,
        'classification': 'post-acknowledgement vector readiness exceeded5s; eventually consistent at shutdown',
        'persistedAfterShutdown': {
            'noteBodyMatchesV1': body(0,1).strip() in text,
            'noteV0Markers': len(re.findall(r'HBMOP000S\d+V0', text)),
            'noteV1Markers': len(re.findall(r'HBMOP000S\d+V1', text)),
            'entitiesForId': len([e for e in state['entities'] if e[1] == mid]),
            'chunksForId': len(chunks),
            'chunksWithV0': sum('V0' in c[1] for c in chunks),
            'chunksWithV1': sum('V1' in c[1] for c in chunks),
            'allChunksReady': all(c[2] == 'ready' for c in state['chunks']),
            'textRowsWithV0': sum('V0' in s[1] for s in rows),
            'textRowsWithV1': sum('V1' in s[1] for s in rows),
            'orphanVectors': state['orphanVectors'],
            'orphanChunks': state['orphanChunks'],
            'orphanSearch': state['orphanSearch'],
        },
        'serverEventEvidence': {
            'path': str(path), 'sha256': digest(path), 'events': events,
            'responseToVectorCompleteMs': (stamp(done)-stamp(ack)).total_seconds()*1000,
            'meaning': 'Same server wall-clock event timestamps, not collector timestamps. Client acknowledgement instant was not persisted on failure; do not substitute this interval for exact client latency.',
            'dominantReportedPhase': 'write_seconds_total=4.743 versus embed_seconds_total=0.993; logged phase times are cumulative, not a complete critical-path profile',
            'duplicateIndexStarts': 'The same note was indexed again twice after the MCP response; this is evidence of overlapping watcher work, not a measured causal attribution.',
        },
        'testCoverage': {'updateAttempted': 1, 'updatePassed': 0, 'deleteAttempted': 0,
                         'replaceAttempted': 0, 'backupRestoreAttempted': False,
                         'real24hStarted': False},
        'interpretation': 'No evidence of permanent stale data in this final snapshot. The frozen5s visibility gate nevertheless failed; later convergence does not turn it into a pass.',
        'nextScope': 'Keep failed raw state. Any timing repair requires a new registered run and client receipt plus per-stage events; full native lifecycle arm remains untested. No quality retuning, backend adoption or later batch.',
    }
    save('bm-lifecycle-failure-diagnosis.json', report)
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    diagnose()
