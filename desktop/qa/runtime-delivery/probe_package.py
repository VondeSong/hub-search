"""Verify the actual produced runtime with all developer discovery removed."""
import json,os,pathlib,subprocess,sys,time,zipfile
ROOT=pathlib.Path(__file__).resolve().parents[2]
AREA=ROOT/'.local/memory-distribution/package-probe'
OUT=ROOT/'artifacts/runtime-delivery-20261020'
OUT.mkdir(parents=True,exist_ok=True)
AREA.mkdir(exist_ok=False)
started=time.monotonic()
with zipfile.ZipFile(ROOT/'.local/memory-distribution/windows-x64/memory-runtime.zip') as z:
    z.extractall(AREA)
environment={key:os.environ[key] for key in ('SYSTEMROOT','WINDIR','TEMP','TMP') if key in os.environ}
environment.update(PATH=str(AREA/'python'),HF_HUB_OFFLINE='1',TRANSFORMERS_OFFLINE='1',HF_HUB_DISABLE_TELEMETRY='1')
command=[str(AREA/'python/python.exe'),'-I','-B','-X','utf8','-c',
         (ROOT/'src-tauri/src/shared_memory/runtime_probe.py').read_text(encoding='utf-8'),str(AREA/'models')]
result=subprocess.run(command,cwd=AREA,env=environment,capture_output=True,text=True,encoding='utf-8',timeout=90)
receipt=dict(exitCode=result.returncode,seconds=round(time.monotonic()-started,3),stdout=result.stdout,stderr=result.stderr,
             executable=command[0],path=environment['PATH'],pythonDiscovery=False,legacyConfiguration=False)
(OUT/'package-probe.json').write_text(json.dumps(receipt,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps(receipt,ensure_ascii=False))
sys.exit(result.returncode)
