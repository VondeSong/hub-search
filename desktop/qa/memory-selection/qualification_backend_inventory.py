"""Read-only local dependency inventory; not operational backend acceptance."""
import importlib.metadata
import json
import os
import platform
import sys
from pathlib import Path
from packaging.version import Version
from qualification_contract import *

def tree_bytes(root):
    count=total=0
    for directory,_,files in os.walk(root,followlinks=False):
        for name in files:
            p=Path(directory)/name
            if p.is_file():count+=1;total+=p.stat().st_size
    return {'path':str(root),'files':count,'logicalBytes':total,
        'meaning':'Sum of file lengths, not compressed download or deduplicated physical allocation'}

def main():
    package_names=['basic-memory','fastmcp','mcp','fastembed','onnxruntime','tokenizers','sqlite-vec']
    packages={}
    for name in package_names:
        d=importlib.metadata.distribution(name);version=d.version
        packages[name]={'version':version,'prerelease':Version(version).is_prerelease,
            'declaredLicense':d.metadata.get('License') or d.metadata.get('License-Expression'),
            'requiresPython':d.metadata.get('Requires-Python'),
            'licenseFiles':[{ 'path':str(d.locate_file(p)), 'sha256':digest(d.locate_file(p))}
                for p in (d.files or []) if 'LICENSE' in str(p).upper() and Path(d.locate_file(p)).is_file()]}
    dll_root=Path(importlib.metadata.distribution('onnxruntime').locate_file('onnxruntime/capi'))
    dlls=[{'path':str(p),'bytes':p.stat().st_size,'sha256':digest(p)} for p in dll_root.glob('*.dll')]
    model=ROOT/'.local/hbm-00/cache/models/models--Qdrant--bge-small-zh-v1.5/snapshots/46fbe35fd4374a00fee7de77dfddaeb6dd6a2c59'
    assets=[{'path':str(p),'bytes':p.stat().st_size,'sha256':digest(p)} for p in model.iterdir() if p.is_file()]
    report={'at':now(),'kind':'STATIC installed dependency inventory, NOT backend acceptance',
        'packages':packages,'runtimeEnvironment':tree_bytes(Path(sys.prefix)),
        'pythonBase':tree_bytes(Path(sys.base_prefix)),
        'pythonVersion':sys.version,'baseSeparateFromVenv':sys.base_prefix!=sys.prefix,
        'windows':platform.platform(),'onnxDlls':dlls,'embeddingAssets':assets,
        'basicMemoryPackaging':'Current venv refers to separate global uv-managed CPython. Copying venv alone is NOT a managed portable deployment test.',
        'nativePackaging':'Rust probe source prepared; compilation, binary/dependency closure, same-weight parity and startup NOT yet measured.',
        'nativePrerelease':'Published fastembed7.1.1 specifies ort=2.0.0-rc.13. Verify resolved Cargo.lock; do not assume native path is prerelease-free.',
        'licenseGate':'Inventory exact third-party license/source identity and intended distribution boundaries. This private local test neither republishes Hub nor establishes distribution compliance.',
        'operationalGatesUnrun':['same-condition CRUD and hard deletion','restart/reindex/crash/backup recovery',
            'managed relocation/install/update/recovery','fresh-process first usable','real24h RSS/load/stability'],
        'backendSelected':False,'laterBatchesStarted':False}
    save('backend-dependency-inventory.json',report)
    print(json.dumps({'packages':{n:{k:v[k] for k in ['version','prerelease','declaredLicense']} for n,v in packages.items()},
        'venvMiB':report['runtimeEnvironment']['logicalBytes']/1024**2,'pythonBaseMiB':report['pythonBase']['logicalBytes']/1024**2,
        'dllMiB':sum(d['bytes'] for d in dlls)/1024**2,'modelAssetsMiB':sum(a['bytes'] for a in assets)/1024**2,
        'operationalAcceptance':False}),flush=True)

if __name__=='__main__':main()
