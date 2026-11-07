"""Independent Gemini CLI protocol preflight, no benchmark labels or tools."""
import json
import os
import subprocess
import time
from pathlib import Path

from independent_support import NODE, WORK, save

GEMINI = Path('C:/Users/yongs/AppData/Roaming/npm/node_modules/@google/gemini-cli/bundle/gemini.js')


def call(prompt, name, timeout=60):
    directory = WORK / name
    directory.mkdir(parents=True, exist_ok=False)
    settings = {'tools': {'core': ['__hbm_no_tools__']}, 'hooksConfig': {'enabled': False},
                'hooks': {}, 'mcpServers': {}, 'skills': {'enabled': False},
                'telemetry': {'enabled': False}, 'general': {'disableAutoUpdate': True},
                'context': {'fileName': '__HBM_NO_CONTEXT__.md', 'includeDirectories': []}}
    (directory / 'system-settings.json').write_text(json.dumps(settings), encoding='utf-8')
    (directory / 'system.md').write_text('You are a tool-free JSON classifier. Use only the supplied text. Return JSON only, without markdown.', encoding='utf-8')
    (directory / 'input.txt').write_text(prompt, encoding='utf-8')
    env = os.environ.copy()
    env.update({'GEMINI_CLI_SYSTEM_SETTINGS_PATH': str(directory / 'system-settings.json'),
                'GEMINI_SYSTEM_MD': str(directory / 'system.md'), 'GEMINI_CLI_NO_RELAUNCH': '1',
                'NO_BROWSER': '1'})
    command = [str(NODE), str(GEMINI), '--model', 'gemini-2.5-flash', '--extensions', 'none',
               '--output-format', 'json', '--prompt', 'Classify the input supplied on stdin.']
    began = time.perf_counter()
    with (directory / 'stderr.log').open('wb') as error:
        result = subprocess.run(command, input=prompt.encode(), stdout=subprocess.PIPE,
                                stderr=error, cwd=directory, env=env, timeout=timeout,
                                creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
    (directory / 'output.json').write_bytes(result.stdout)
    receipt = {'exitCode': result.returncode, 'durationMs': (time.perf_counter() - began) * 1000}
    (directory / 'receipt.json').write_text(json.dumps(receipt), encoding='utf-8')
    if result.returncode:
        print(json.dumps({'status': 'failed', **receipt}))
        return None
    value = json.loads(result.stdout)
    print(json.dumps({'status': 'received', 'keys': list(value), **receipt}))
    return value


if __name__ == '__main__':
    value = call('Protocol smoke only. Fact: Widget K costs 17 credits. Question: What does Widget K cost? Return {"supported":true,"quote":"Widget K costs 17 credits."}.', 'gemini-protocol-smoke')
    if value:
        save('gemini-provider-smoke.json', value)
