"""Inspect the relocated interpreter's actual imports and native libraries."""
import csv,base64,hashlib,io,json,os,pathlib,posixpath,subprocess,time,zipfile
import psutil
ROOT=pathlib.Path(__file__).resolve().parents[2]
AREA=ROOT/'.local/memory-distribution/package-probe'
OUT=ROOT/'artifacts/runtime-delivery-20261020'
source=(ROOT/'src-tauri/src/shared_memory/runtime_probe.py').read_text(encoding='utf-8')
hold="""
import json
external = sorted({str(Path(m.__file__).resolve()) for m in list(sys.modules.values()) if getattr(m, '__file__', None) and not str(m.__file__).startswith('<') and not Path(m.__file__).resolve().is_relative_to(root)})
print(json.dumps({'basePrefix':sys.base_prefix,'externalModules':external}),flush=True)
sys.stdin.readline()
"""
environment={key:os.environ[key] for key in ('SYSTEMROOT','WINDIR','TEMP','TMP') if key in os.environ}
environment.update(PATH=str(AREA/'python'),HF_HUB_OFFLINE='1',TRANSFORMERS_OFFLINE='1',HF_HUB_DISABLE_TELEMETRY='1')
began=time.monotonic()
process=subprocess.Popen([str(AREA/'python/python.exe'),'-I','-B','-X','utf8','-u','-c',source+hold,str(AREA/'models')],
                         env=environment,cwd=AREA,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,encoding='utf-8')
try:
    ready=json.loads(process.stdout.readline());imports=json.loads(process.stdout.readline())
    native=sorted({m.path for m in psutil.Process(process.pid).memory_maps() if pathlib.Path(m.path).name.lower().startswith(('vcruntime140','msvcp140','onnxruntime'))})
    (OUT/'runtime-audit-observed.json').write_text(json.dumps(dict(ready=ready,imports=imports,native=native),ensure_ascii=False,indent=2),encoding='utf-8')
    assert ready['dimensions']==512 and not imports['externalModules']
    assert any(pathlib.Path(p).name.lower().startswith(('onnxruntime.dll','onnxruntime_pybind11_state')) for p in native)
    assert any(pathlib.Path(p).name.lower()=='msvcp140.dll' for p in native)
    assert all(pathlib.Path(p).resolve().is_relative_to(AREA.resolve()) for p in native),native
    process.stdin.write('\n');process.stdin.flush();code=process.wait(timeout=15)
    assert code==0
finally:
    if process.poll() is None:process.kill();process.wait()
with zipfile.ZipFile(ROOT/'.local/memory-distribution/windows-x64/memory-runtime.zip') as bundle:
    names=set(bundle.namelist())
    checked=0;excluded=[]
    for name in bundle.namelist():
        if name.endswith('.dist-info/RECORD'):
            for file,hash_value,length in csv.reader(io.StringIO(bundle.read(name).decode('utf-8'))):
                if not hash_value:continue
                path=posixpath.normpath('python/Lib/site-packages/'+file)
                if path not in names:excluded.append(path);continue
                algorithm,expected=hash_value.split('=',1)
                actual=base64.urlsafe_b64encode(hashlib.new(algorithm,bundle.read(path)).digest()).rstrip(b'=').decode()
                assert actual==expected,('Distribution modified since wheel installation',path)
                checked+=1
receipt=dict(status='passed',seconds=round(time.monotonic()-began,3),ready=ready,imports=imports,loadedNativeLibraries=native,
             wheelRecordsVerified=checked,excludedNonRuntimeEntries=excluded)
(OUT/'runtime-audit.json').write_text(json.dumps(receipt,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps({k:v for k,v in receipt.items() if k!='excludedNonRuntimeEntries'},ensure_ascii=False))
