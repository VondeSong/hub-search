"""HBM-00 only: bounded independent-provider calls and immutable evidence."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import time

import psutil

ROOT = Path(__file__).resolve().parents[2]
WORK = ROOT / '.local/hbm-00/independent-20261018'
REPORTS = ROOT / 'artifacts/hbm-00-independent-20261018'
NODE = Path('C:/Program Files/nodejs/node.exe')
CLAUDE = Path('C:/Users/yongs/AppData/Roaming/npm/node_modules/@anthropic-ai/claude-code/cli.js')
MODEL = 'claude-sonnet-4-6'
CODEX = Path('C:/Users/yongs/AppData/Local/OpenAI/Codex/bin/896a0166b774037a/codex.exe')
CODEX_MODEL = 'gpt-6-astra'


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def save(name, value):
    REPORTS.mkdir(parents=True, exist_ok=True)
    with (REPORTS / name).open('x', encoding='utf-8') as handle:
        handle.write(json.dumps(value, ensure_ascii=False, indent=2) + '\n')


def read(name):
    return json.loads((REPORTS / name).read_text(encoding='utf-8'))


def codex_call(prompt, schema, name, timeout=90):
    """User-authorized same-vendor alternate model; not vendor-independent."""
    directory = WORK / name
    directory.mkdir(parents=True, exist_ok=False)
    (directory / 'input.txt').write_text(prompt, encoding='utf-8')
    (directory / 'schema.json').write_text(json.dumps(schema), encoding='utf-8')
    command = [str(CODEX), 'exec', '--ignore-user-config', '--ephemeral', '--json',
               '--skip-git-repo-check', '--sandbox', 'read-only', '--disable', 'shell_tool',
               '--color', 'never', '--output-schema', str(directory / 'schema.json'),
               '--output-last-message', str(directory / 'output.json'), '-m', CODEX_MODEL,
               '-c', 'model_reasoning_effort="medium"', '-c', 'project_doc_max_bytes=0',
               '-c', 'web_search="disabled"']
    for feature in ['apps', 'plugins', 'remote_plugin', 'hooks', 'memories', 'skill_search',
                    'multi_agent', 'multi_agent_v2', 'computer_use', 'browser_use',
                    'browser_use_external', 'in_app_browser', 'image_generation', 'view_image',
                    'code_mode', 'code_mode_host', 'workspace_dependencies', 'artifact', 'goals',
                    'tool_suggest', 'skill_mcp_dependency_install', 'unbounded_connection_retries']:
        command += ['--disable', feature]
    command += ['--enable', 'skip_host_skill_discovery', '-']
    began = time.perf_counter()
    receipt = {'status': 'starting', 'requestedModel': CODEX_MODEL, 'reasoning': 'medium',
               'explicitRetries': 0, 'inputSha256': digest(directory / 'input.txt'),
               'schemaSha256': digest(directory / 'schema.json'), 'timeoutSeconds': timeout}
    process = None
    try:
        with (directory / 'stderr.log').open('wb') as error:
            process = subprocess.Popen(command, cwd=directory, stdin=subprocess.PIPE,
                                       stdout=subprocess.PIPE, stderr=error,
                                       creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
            receipt.update({'pid': process.pid, 'createTime': psutil.Process(process.pid).create_time()})
            (directory / 'process.json').write_text(json.dumps(receipt), encoding='utf-8')
            output, _ = process.communicate(prompt.encode('utf-8'), timeout=timeout)
            (directory / 'events.jsonl').write_bytes(output)
        if process.returncode:
            raise RuntimeError(f'Codex test exited {process.returncode}; own evidence retained')
        events = [json.loads(line) for line in output.decode('utf-8').splitlines() if line.strip()]
        completed = [row for row in events if row['type'] == 'turn.completed']
        if len(completed) != 1:
            raise ValueError('Expected exactly one completed model turn')
        forbidden = [row for row in events if row.get('item', {}).get('type') in
                     ['command_execution', 'mcp_tool_call', 'web_search']]
        if forbidden:
            raise ValueError('Tool-free model contract violated')
        response = json.loads((directory / 'output.json').read_text(encoding='utf-8'))
        receipt.update({'status': 'completed', 'usage': completed[0].get('usage'), 'toolCalls': 0,
                        'outputSha256': digest(directory / 'output.json'),
                        'runtimeWarningCount': sum(row.get('item', {}).get('type') == 'error' for row in events)})
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


def claude_call(prompt, schema, name, timeout=60):
    directory = WORK / name
    directory.mkdir(parents=True, exist_ok=False)
    (directory / 'input.txt').write_text(prompt, encoding='utf-8')
    (directory / 'schema.json').write_text(json.dumps(schema), encoding='utf-8')
    command = [str(NODE), str(CLAUDE), '--print', '--output-format', 'json',
               '--no-session-persistence', '--setting-sources', '', '--settings',
               '{"disableAllHooks":true,"autoMemoryEnabled":false}',
               '--tools', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
               '--disable-slash-commands', '--no-chrome', '--permission-mode', 'dontAsk',
               '--model', MODEL, '--effort', 'low', '--system-prompt',
               'You are a tool-free JSON classifier. Use only supplied input. No repository, memory, browsing or agent actions.',
               '--json-schema', json.dumps(schema)]
    env = os.environ.copy()
    env.update({'CLAUDE_CODE_DISABLE_AUTO_MEMORY': '1', 'CLAUDE_CODE_DISABLE_CLAUDE_MDS': '1',
                'DISABLE_AUTOUPDATER': '1', 'DISABLE_TELEMETRY': '1',
                'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC': '1'})
    began = time.perf_counter()
    receipt = {'status': 'starting', 'requestedModel': MODEL, 'effort': 'low',
               'inputSha256': digest(directory / 'input.txt'), 'explicitRetries': 0,
               'timeoutSeconds': timeout, 'adapter': 'Claude Code 2.1.92 print, tool-free, settings/hooks/MCP/skills/memory disabled'}
    process = None
    try:
        with (directory / 'stderr.log').open('wb') as error:
            process = subprocess.Popen(command, cwd=directory, env=env, stdin=subprocess.PIPE,
                                       stdout=subprocess.PIPE, stderr=error,
                                       creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
            receipt.update({'pid': process.pid, 'createTime': psutil.Process(process.pid).create_time()})
            (directory / 'process.json').write_text(json.dumps(receipt), encoding='utf-8')
            output, _ = process.communicate(prompt.encode('utf-8'), timeout=timeout)
            (directory / 'output.json').write_bytes(output)
        if process.returncode:
            raise RuntimeError(f'Independent model exited {process.returncode}; isolated stderr retained')
        value = json.loads(output.decode('utf-8'))
        if value.get('is_error') or value.get('subtype') != 'success':
            raise RuntimeError('Independent model returned unsuccessful result')
        response = value.get('structured_output')
        if not isinstance(response, dict):
            raise ValueError('Independent model omitted structured output')
        model_usage = value.get('modelUsage', {})
        if not model_usage or any(not m.startswith(MODEL) for m in model_usage):
            raise ValueError('Unexpected independent provider model identity')
        receipt.update({'status': 'completed', 'models': list(model_usage), 'usage': value.get('usage'),
                        'modelUsage': model_usage, 'providerDurationMs': value.get('duration_api_ms'),
                        'cliDurationMs': value.get('duration_ms'), 'numTurns': value.get('num_turns'),
                        'permissionDenials': len(value.get('permission_denials', [])),
                        'outputSha256': digest(directory / 'output.json')})
        if receipt['permissionDenials']:
            raise ValueError('Model attempted a disabled action')
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


if __name__ == '__main__':
    schema = {'type': 'object', 'additionalProperties': False,
              'properties': {'supported': {'type': 'boolean'}, 'quote': {'type': 'string'}},
              'required': ['supported', 'quote']}
    result, receipt = claude_call('Protocol smoke only, not an evaluation question. Fact: Widget K costs 17 credits. Question: What does Widget K cost? Return supported=true and the exact complete fact as quote.', schema, 'protocol-smoke')
    assert result == {'supported': True, 'quote': 'Widget K costs 17 credits.'}
    save('provider-smoke.json', {'result': result, 'receipt': receipt})
    print(json.dumps({'status': receipt['status'], 'models': receipt['models'], 'durationMs': receipt['durationMs']}))
