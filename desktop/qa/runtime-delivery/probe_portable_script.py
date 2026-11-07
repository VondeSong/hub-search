"""Exercise the production PowerShell packager with tiny synthetic inputs."""
import json,os,pathlib,shutil,subprocess,zipfile
ROOT=pathlib.Path(__file__).resolve().parents[2]
AREA=ROOT/'.local/memory-distribution/portable-script-probe'
AREA.mkdir(exist_ok=False)
(AREA/'scripts').mkdir();(AREA/'src-tauri/target/release').mkdir(parents=True)
shutil.copyfile(ROOT/'scripts/build-portable.ps1',AREA/'scripts/build-portable.ps1')
binary=b'synthetic executable assets/index-test.js'
(AREA/'src-tauri/target/release/craft-search.exe').write_bytes(binary)
(AREA/'component.zip').write_bytes(b'synthetic component')
(AREA/'notice.txt').write_bytes(b'synthetic notice')
config={'productName':'SyntheticHub','version':'0.0.0','bundle':{'resources':{'../component.zip':'memory-runtime.zip','../notice.txt':'THIRD_PARTY_NOTICES.txt'}}}
(AREA/'src-tauri/tauri.conf.json').write_text(json.dumps(config),encoding='utf-8')
environment=os.environ.copy();environment['CARGO_TARGET_DIR']=str(AREA/'src-tauri/target')
command=[str(pathlib.Path(os.environ['SYSTEMROOT'])/'System32/WindowsPowerShell/v1.0/powershell.exe'),'-NoProfile','-ExecutionPolicy','Bypass','-File',str(AREA/'scripts/build-portable.ps1')]
result=subprocess.run(command,cwd=AREA,env=environment,capture_output=True,text=True,encoding='utf-8',errors='replace',timeout=30)
receipt={'exitCode':result.returncode,'stdout':result.stdout,'stderr':result.stderr}
if result.returncode==0:
    with zipfile.ZipFile(AREA/'src-tauri/target/release/bundle/portable/SyntheticHub_0.0.0_x64_portable.zip') as bundle:
        assert set(bundle.namelist())=={'Hub.exe','memory-runtime.zip','THIRD_PARTY_NOTICES.txt'}
        assert bundle.read('Hub.exe')==binary
        assert bundle.read('memory-runtime.zip')==b'synthetic component'
        receipt['entries']=bundle.namelist()
(ROOT/'artifacts/runtime-delivery-20261020/portable-script-probe.json').write_text(json.dumps(receipt,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps(receipt,ensure_ascii=False))
raise SystemExit(result.returncode)
