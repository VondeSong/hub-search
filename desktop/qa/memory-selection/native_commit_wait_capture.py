"""Owned short WPR capture around one frozen diagnosis; never restarts a workload."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[2]
REPORT = ROOT / 'artifacts/hbm-00-native-commit-wait-20261019'
INSTANCE = 'HBMCommitWait20261019'

def main():
    evidence = {'startedUnixMs': time.time()*1000, 'commands': [], 'instance': INSTANCE}
    def command(args, timeout=60):
        p = subprocess.run(args, cwd=ROOT, capture_output=True, timeout=timeout,
                           creationflags=subprocess.CREATE_NO_WINDOW)
        evidence['commands'].append({'args': args, 'code': p.returncode,
                                    'output': (p.stdout+p.stderr).decode('utf-8', errors='replace')})
        return p.returncode
    with (REPORT/'capture-started.json').open('x', encoding='utf-8') as f:
        json.dump({'pid': os.getpid(), 'at': time.time(),
                   'driverSha256': hashlib.sha256((Path(__file__).with_name('native_commit_wait_diagnosis.py')).read_bytes()).hexdigest(),
                   'captureSha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest()}, f, indent=2)
    owned = False
    try:
        command(['wpr', '-status'])
        output = evidence['commands'][-1]['output']
        if 'not recording' not in output.lower():
            raise RuntimeError('No unequivocal proof WPR is idle; refusing to start capture/workload')
        owned = command(['wpr', '-start', 'CPU', '-instancename', INSTANCE]) == 0
        if not owned:
            raise RuntimeError('WPR start failed; no workload run')
        with (REPORT/'driver.stdout.log').open('xb') as out, (REPORT/'driver.stderr.log').open('xb') as err:
            p = subprocess.run([sys.executable, '-X', 'utf8', str(Path(__file__).with_name('native_commit_wait_diagnosis.py'))],
                               cwd=ROOT, stdout=out, stderr=err, timeout=330,
                               creationflags=subprocess.CREATE_NO_WINDOW)
            evidence['driverExitCode'] = p.returncode
    except BaseException as exc:
        evidence['error'] = repr(exc)
    finally:
        if owned:
            try:
                code = command(['wpr', '-stop', str(REPORT/'wait-stacks.etl'),
                                'HBM bounded commit split diagnosis', '-skipPdbGen', '-instancename', INSTANCE], timeout=180)
                if code:
                    command(['wpr', '-cancel', '-instancename', INSTANCE])
            except BaseException as exc:
                evidence['stopError'] = repr(exc)
                command(['wpr', '-cancel', '-instancename', INSTANCE])
            command(['wpr', '-status', '-instancename', INSTANCE])
        evidence['endedUnixMs'] = time.time()*1000
        (REPORT/'capture-result.json').write_text(json.dumps(evidence, indent=2, ensure_ascii=False), encoding='utf-8')
        print(json.dumps(evidence, ensure_ascii=False))

if __name__ == '__main__':
    main()
