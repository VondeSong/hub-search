"""Build and verify Hub's self-contained Windows memory runtime.

Inputs are explicit, qualified installations, never searched from PATH. The
archive includes the interpreter, all package files, model snapshot and notices.
The checked-in descriptor pins every distributed byte for native consumers.
"""
from __future__ import annotations
import argparse
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import zipfile

ROOT = Path(__file__).resolve().parents[1]
GENERATED = ROOT / '.local/memory-distribution/windows-x64'
DESCRIPTOR = ROOT / 'assets/shared-memory-runtime.json'
MODEL = 'models--Qdrant--bge-small-zh-v1.5'
SNAPSHOT = '46fbe35fd4374a00fee7de77dfddaeb6dd6a2c59'
MODEL_HASH = '1294ea4b6331115a353d81f96b85e8c8d7fdcc284453d5b2fab5b016230aad38'
MAX_EXPANDED = 2 * 1024**3

def digest(path):
    h = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()

def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + '.tmp')
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    temporary.replace(path)

def source_files(root):
    for directory, folders, files in os.walk(root):
        folders[:] = sorted(n for n in folders if n not in ('__pycache__', '.git', '.cache'))
        for name in sorted(files):
            path = Path(directory) / name
            if path.suffix not in ('.pyc', '.pyo'):
                yield path.relative_to(root).as_posix(), path

def prepare(args):
    started = time.monotonic()
    python, packages, models, crt = (Path(x).resolve(strict=True) for x in
                                    (args.python_root, args.site_packages, args.model_cache, args.crt))
    exe = python / 'python.exe'
    version = subprocess.check_output([str(exe), '-I', '-c', 'import platform;print(platform.python_version())'], text=True).strip()
    if version != '3.12.12':
        raise ValueError('Qualified CPython 3.12.12 required')
    distributions = sorted(importlib.metadata.distributions(path=[str(packages)]), key=lambda d: d.metadata['Name'].lower())
    if {d.metadata['Name'].lower(): d.version for d in distributions}.get('basic-memory') != '0.23.2':
        raise ValueError('Qualified Basic Memory 0.23.2 required')
    weights = models / MODEL / 'snapshots' / SNAPSHOT / 'model_optimized.onnx'
    if digest(weights) != MODEL_HASH:
        raise ValueError('Pinned Chinese model does not match')
    sources = {}
    for name, path in source_files(python):
        if not name.startswith(('Lib/site-packages/', 'Scripts/', 'include/', 'libs/', 'tcl/')):
            sources['python/' + name] = path
    for name, path in source_files(packages):
        sources['python/Lib/site-packages/' + name] = path
    for name, path in source_files(models / MODEL):
        sources['models/' + MODEL + '/' + name] = path
    dlls = sorted(crt.glob('*.dll'))
    if not dlls or not any(p.name == 'msvcp140.dll' for p in dlls):
        raise ValueError('Microsoft app-local x64 CRT required')
    for path in dlls:
        sources['python/' + path.name] = path
    notice_lines = [
        'Hub shared-memory runtime (Windows x64)',
        'CPython 3.12.12: PSF license and bundled notices in python/LICENSE.txt.',
        'Python standalone build 20260211: https://github.com/astral-sh/python-build-standalone',
        'Basic Memory 0.23.2: https://github.com/basicmachines-co/basic-memory/tree/v0.23.2',
        'Basic Memory is distributed unmodified; its full license/source files are included under python/Lib/site-packages.',
        'Model: https://huggingface.co/Qdrant/bge-small-zh-v1.5/tree/' + SNAPSHOT,
        'Original model: https://huggingface.co/BAAI/bge-small-zh-v1.5 (MIT).',
        'Microsoft VC143 CRT: https://learn.microsoft.com/en-us/cpp/windows/redistributing-visual-cpp-files',
        'App-local CRT deployment: https://learn.microsoft.com/en-us/cpp/windows/choosing-a-deployment-method',
        'Package licenses/copyright notices are retained in each distribution below.', '',
    ]
    inventory = []
    for distribution in distributions:
        name = distribution.metadata['Name']
        license_value = distribution.metadata.get('License-Expression') or distribution.metadata.get('License') or 'See included package notices'
        files = [str(p) for p in distribution.files or [] if
                 any(word in str(p).upper() for word in ('LICENSE', 'COPYING', 'NOTICE')) and distribution.locate_file(p).is_file()]
        inventory.append(dict(name=name, version=distribution.version, license=license_value,
                              licenseFiles=files, source=distribution.metadata.get_all('Project-URL') or []))
        notice_lines.append(f'{name} {distribution.version}: {license_value}')
    notice = ('\n'.join(notice_lines) + '\n').encode('utf-8')
    extras = {'THIRD_PARTY_NOTICES.txt': notice,
              'package-inventory.json': (json.dumps(inventory, ensure_ascii=False, indent=2) + '\n').encode('utf-8')}
    files = {name: dict(bytes=p.stat().st_size, sha256=digest(p)) for name, p in sorted(sources.items())}
    for name, data in extras.items():
        files[name] = dict(bytes=len(data), sha256=hashlib.sha256(data).hexdigest())
    expanded = sum(row['bytes'] for row in files.values())
    if expanded > MAX_EXPANDED or shutil.disk_usage(ROOT).free < expanded * 3 + 2 * 1024**3:
        raise ValueError('Runtime size/free-space budget exceeded before package creation')
    manifest = dict(schemaVersion=1, platform='windows-x64', python=version, basicMemory='0.23.2',
                    model='BAAI/bge-small-zh-v1.5', modelSnapshot=SNAPSHOT, files=files, expandedBytes=expanded)
    manifest_bytes = (json.dumps(manifest, ensure_ascii=False, sort_keys=True, separators=(',', ':')) + '\n').encode('utf-8')
    GENERATED.mkdir(parents=True, exist_ok=True)
    archive = GENERATED / 'memory-runtime.zip'
    temporary = GENERATED / 'memory-runtime.zip.preparing'
    with zipfile.ZipFile(temporary, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=6) as bundle:
        for name, data in [('manifest.json', manifest_bytes), *sorted(extras.items())]:
            info = zipfile.ZipInfo(name, date_time=(2026, 1, 1, 0, 0, 0)); info.compress_type = zipfile.ZIP_DEFLATED
            bundle.writestr(info, data)
        for name, path in sorted(sources.items()):
            info = zipfile.ZipInfo(name, date_time=(2026, 1, 1, 0, 0, 0)); info.compress_type = zipfile.ZIP_DEFLATED
            with path.open('rb') as stream, bundle.open(info, 'w') as output:
                shutil.copyfileobj(stream, output, 1024 * 1024)
    descriptor = dict(schemaVersion=1, platform='windows-x64', python=version, basicMemory='0.23.2',
                      id=hashlib.sha256(manifest_bytes).hexdigest(), archiveSha256=digest(temporary),
                      archiveBytes=temporary.stat().st_size, expandedBytes=expanded, files=len(files))
    temporary.replace(archive)
    write_json(DESCRIPTOR, descriptor)
    (GENERATED / 'THIRD_PARTY_NOTICES.txt').write_bytes(notice)
    write_json(GENERATED / 'preparation.json', dict(**descriptor, seconds=round(time.monotonic()-started, 3),
                                                 sources=dict(python=str(python), packages=str(packages), models=str(models), crt=str(crt))))
    verify_archive(archive, descriptor)
    return dict(status='prepared', **descriptor, archive=str(archive))

def verify_archive(archive, descriptor=None):
    descriptor = descriptor or json.loads(DESCRIPTOR.read_text(encoding='utf-8'))
    if digest(archive) != descriptor['archiveSha256'] or archive.stat().st_size != descriptor['archiveBytes']:
        raise ValueError('Runtime archive identity mismatch')
    with zipfile.ZipFile(archive) as bundle:
        manifest_bytes = bundle.read('manifest.json')
        if hashlib.sha256(manifest_bytes).hexdigest() != descriptor['id']:
            raise ValueError('Runtime manifest identity mismatch')
        manifest = json.loads(manifest_bytes)
        expected = set(manifest['files']) | {'manifest.json'}
        if set(bundle.namelist()) != expected or len(bundle.namelist()) != len(expected):
            raise ValueError('Runtime archive has missing, extra or duplicate files')
        for name, row in manifest['files'].items():
            parts = Path(name).parts
            if not parts or name.startswith(('/', '\\')) or any(p in ('.', '..') or ':' in p for p in parts):
                raise ValueError('Unsafe runtime archive path')
            data = bundle.read(name)
            if len(data) != row['bytes'] or hashlib.sha256(data).hexdigest() != row['sha256']:
                raise ValueError('Runtime file integrity mismatch: ' + name)
    return descriptor

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    build = commands.add_parser('prepare')
    for name in ('python-root', 'site-packages', 'model-cache', 'crt'):
        build.add_argument('--' + name, required=True)
    commands.add_parser('verify')
    args = parser.parse_args()
    if args.command == 'prepare': result = prepare(args)
    elif args.command == 'verify': result = verify_archive(GENERATED / 'memory-runtime.zip')
    print(json.dumps(result, ensure_ascii=False))

if __name__ == '__main__':
    if hasattr(sys.stdout, 'reconfigure'): sys.stdout.reconfigure(encoding='utf-8')
    main()
