"""Isolated, immutable evidence and a bounded tool-free model test adapter."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import time

import psutil

ROOT = Path(__file__).resolve().parents[2]
WORK = ROOT / '.local/hbm-00/applicability-20261018'
REPORTS = ROOT / 'artifacts/hbm-00-applicability-20261018'
CORPUS_ORIGINAL = Path(__file__).with_name('corpus.json')
ORIGINAL_HASH = 'f1863d81f07bf1997fefdd23a97dc597e5ad276079bb050f3d1b965e3266440b'


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def read(name):
    return json.loads((REPORTS / name).read_text(encoding='utf-8'))


def save(name, value):
    REPORTS.mkdir(parents=True, exist_ok=True)
    path = REPORTS / name
    with path.open('x', encoding='utf-8') as handle:
        handle.write(json.dumps(value, ensure_ascii=False, indent=2) + '\n')


def model_call(executable, prompt, schema, name, timeout=120):
    directory = WORK / name
    directory.mkdir(parents=True, exist_ok=False)
    (directory / 'input.txt').write_text(prompt, encoding='utf-8')
    (directory / 'schema.json').write_text(json.dumps(schema), encoding='utf-8')
    command = [str(executable), 'exec', '--ignore-user-config', '--ephemeral', '--json', '--skip-git-repo-check', '--sandbox', 'read-only', '--disable', 'shell_tool', '--color', 'never', '--output-schema', str(directory / 'schema.json'), '--output-last-message', str(directory / 'output.json'), '-m', 'gpt-6.1-sol', '-c', 'model_reasoning_effort="high"', '-c', 'project_doc_max_bytes=0', '-c', 'web_search="disabled"']
    for feature in ['apps', 'plugins', 'remote_plugin', 'hooks', 'memories', 'skill_search', 'multi_agent', 'multi_agent_v2', 'computer_use', 'browser_use', 'browser_use_external', 'in_app_browser', 'image_generation', 'view_image', 'code_mode', 'code_mode_host', 'workspace_dependencies', 'artifact', 'goals', 'tool_suggest', 'skill_mcp_dependency_install', 'unbounded_connection_retries']:
        command += ['--disable', feature]
    command += ['--enable', 'skip_host_skill_discovery', '-']
    began = time.perf_counter()
    receipt = {'name': name, 'status': 'starting', 'model': 'gpt-6.1-sol', 'reasoning': 'high', 'explicitRetries': 0, 'inputSha256': digest(directory / 'input.txt'), 'schemaSha256': digest(directory / 'schema.json'), 'timeoutSeconds': timeout}
    process = None
    try:
        with (directory / 'stderr.log').open('wb') as error:
            process = subprocess.Popen(command, cwd=directory, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=error, creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
            receipt.update({'pid': process.pid, 'createTime': psutil.Process(process.pid).create_time()})
            (directory / 'process.json').write_text(json.dumps(receipt), encoding='utf-8')
            output, _ = process.communicate(prompt.encode('utf-8'), timeout=timeout)
            (directory / 'events.jsonl').write_bytes(output)
        if process.returncode:
            raise RuntimeError(f'Model test exited {process.returncode}; own stderr retained')
        events = [json.loads(line) for line in output.decode('utf-8').splitlines() if line.strip()]
        if not any(row['type'] == 'turn.completed' for row in events):
            raise RuntimeError('Model test lacks a completed turn')
        forbidden = [row for row in events if row.get('item', {}).get('type') in ['command_execution', 'mcp_tool_call', 'web_search']]
        if forbidden:
            raise RuntimeError('Tool-free model contract violated')
        response = json.loads((directory / 'output.json').read_text(encoding='utf-8'))
        receipt.update({'status': 'completed', 'usage': next(row.get('usage') for row in events if row['type'] == 'turn.completed'), 'toolCalls': 0, 'runtimeWarningCount': sum(row.get('item', {}).get('type') == 'error' for row in events)})
        return response, receipt
    except BaseException as error:
        receipt.update({'status': 'failed', 'errorType': type(error).__name__})
        if process is not None and process.poll() is None:
            parent = psutil.Process(process.pid)
            if parent.create_time() == receipt['createTime']:
                owned = [*parent.children(recursive=True), parent]
                for member in owned:
                    try:
                        member.terminate()
                    except psutil.NoSuchProcess:
                        pass
                psutil.wait_procs(owned, timeout=10)
            process.wait(timeout=10)
        raise
    finally:
        receipt['durationMs'] = (time.perf_counter() - began) * 1000
        receipt['exitCode'] = process.returncode if process else None
        (directory / 'receipt.json').write_text(json.dumps(receipt, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
