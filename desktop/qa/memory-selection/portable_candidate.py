"""App-local CRT/resource packaging over the bounded relocation runner."""
import portable_inventory as p
from pathlib import Path
import shutil,json

CRT=Path('C:/Program Files (x86)/Microsoft Visual Studio/2022/BuildTools/VC/Redist/MSVC/14.44.35112/x64/Microsoft.VC143.CRT')
p.OUT=p.ROOT/'artifacts/hbm-00-portable-candidate-20261019'
p.BASE=p.ROOT/'.local/hbm-00/portable-candidate-20261019'
original_save=p.save
original_start=p.start
original_digest=p.digest
records=[]

def save(path,data):
    if path.name=='contract.json':
        data.update(packagingDriverSha256=original_digest(__file__),
            crtSource=str(CRT),crtFiles=p.manifest(CRT),
            addedGate='Loaded VC runtime DLLs in harness and embedding process must resolve inside this case resources. No System32 CRT fallback accepted.',
            limitation='Private QA candidate, not production Hub integration; Python controller and BM parser host-side. No offline/clean Windows claim.')
    original_save(path,data)

def start(state):
    root=state.parent.parent;resources=root/'resources'
    for target in [resources/'harness',resources/'rust-runtime/bundle']:
        for dll in CRT.glob('*.dll'):
            dst=target/dll.name
            if dst.exists():assert original_digest(dst)==original_digest(dll)
            else:shutil.copy2(dll,dst)
    # License/source references remain explicit; this local QA package is not published.
    notice=resources/'THIRD_PARTY_SOURCES.md'
    if not notice.exists():
        notice.write_text('''# HBM-00 private candidate resources

This is a QA candidate, not a production Hub portable distribution.
VC143 x64 CRT: Visual Studio 2022 BuildTools VC/Redist/MSVC/14.44.35112.
Local deployment: https://learn.microsoft.com/en-us/cpp/windows/choosing-a-deployment-method
Distribution terms: https://learn.microsoft.com/en-us/cpp/windows/redistributing-visual-cpp-files
Windows OS/API/UCRT and WebView2 are not bundled by this QA component pack.
Model: Qdrant/bge-small-zh-v1.5 snapshot 46fbe35fd4374a00fee7de77dfddaeb6dd6a2c59.
Source: https://huggingface.co/Qdrant/bge-small-zh-v1.5
ORT and model hashes/provenance: dependency-provenance.json.
Full production license/notice closure remains a release prerequisite.
Python QA controller and BM parser are host dependencies, not shipped runtime claims.
''',encoding='utf-8')
        shutil.copy2(p.ROOT/'artifacts/hbm-00-qualification-20261018/backend-dependency-inventory.json',resources/'dependency-provenance.json')
    original_save(p.OUT/f'package-{len(records)+1}.json',p.manifest(resources))
    client=original_start(state)
    try:
        modules=[]
        for pid in [client.p.pid,client.embedding_pid]:
            paths=sorted({m.path for m in p.psutil.Process(pid).memory_maps() if Path(m.path).name.lower().startswith(('msvcp140','vcruntime140')) or Path(m.path).name.lower()=='onnxruntime.dll'})
            assert paths, 'No runtime modules observed'
            for name in paths:assert Path(name).resolve().is_relative_to(resources.resolve()),'Runtime fallback: '+name
            modules.append({'pid':pid,'createTime':p.psutil.Process(pid).create_time(),'loadedRuntimePaths':paths})
        records.append({'root':str(root),'modules':modules})
        original_save(p.OUT/f'loaded-modules-{len(records)}.json',records[-1])
        return client
    except BaseException:
        client.close();raise

if __name__=='__main__':
    assert CRT.is_dir() and len(list(CRT.glob('*.dll')))==10
    p.save=save;p.start=start
    p.main()
