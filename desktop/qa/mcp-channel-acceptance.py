"""Run the owned WebView/IPC fixture in separate normal application sessions."""
import argparse, hashlib, json, os, sqlite3, subprocess, time
from pathlib import Path

parser=argparse.ArgumentParser()
parser.add_argument('--executable',type=Path,required=True)
parser.add_argument('--root',type=Path,required=True)
parser.add_argument('--phase',choices=['settings','run','stop','resume','narrow','unknown'],required=True)
parser.add_argument('--settings-work-id')
parser.add_argument('--other-work-id')
parser.add_argument('--work-id')
parser.add_argument('--previous-run-id')
parser.add_argument('--save-id')
parser.add_argument('--save-title')
parser.add_argument('--failure-probe',action='store_true')
parser.add_argument('--save-only',action='store_true')
args=parser.parse_args()
root=args.root.resolve()
assert root.is_dir() and (root/'.hub-isolated-runtime-v1').read_bytes()==b'Hub isolated runtime v1\n'
assert root.parent==Path(os.environ['TEMP']).resolve(), 'only an explicit temporary profile is allowed'
vault=(root/'vault').resolve(strict=True)
assert vault.parent==root, 'fixture vault must stay inside the isolated profile'
expected_sources={
 'allowed': '# 合成资料 A\n本次虚构项目的数量为 7 件，验收条件尚未确认。证据编号 MCP-A-719。\n',
 'extra': '# 合成资料 B\n本次虚构项目负责人为林，截止日期为 2026-11-20。证据编号 MCP-B-283。\n',
 'excluded': '# 未授权对照\nPRIVATE_MCP_SENTINEL_97531，不得出现在未授权读取或答案中。\n',
}
for name,body in expected_sources.items():
 source=(vault/(name+'.md')).resolve(strict=True)
 assert source.parent==vault and source.read_bytes()==body.encode('utf-8'), 'unexpected fixture source: '+name
with sqlite3.connect(root/'craft-search.sqlite3') as db:
 location=db.execute("select location from libraries where id='mcp-fixture' and provider='obsidian'").fetchone()
 assert location and Path(location[0]).samefile(vault), 'fixture library must use this isolated vault'
config={'format':'hub-mcp-channel-acceptance-v1','phase':args.phase}
if args.failure_probe: config['failureProbe']=True
if args.save_only: config['saveOnly']=True
for key in ['settings_work_id','other_work_id','work_id','previous_run_id','save_id','save_title']:
 value=getattr(args,key)
 if value: config[key.split('_')[0]+''.join(p.title() for p in key.split('_')[1:])]=value
(root/'mcp-channel-acceptance.json').write_text(json.dumps(config),encoding='utf-8')
evidence=root/'evidence';evidence.mkdir(exist_ok=True)
result_path=evidence/(args.phase+'.json')
if result_path.exists():
 result_path.rename(evidence/(args.phase+'-previous-'+str(time.time_ns())+'.json'))
session_path=evidence/(args.phase+'-session.json')
if session_path.exists():
 session_path.rename(evidence/(args.phase+'-session-previous-'+str(time.time_ns())+'.json'))
before_files={p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in (root/'vault').glob('*.md')}
stdout=(evidence/(args.phase+'-stdout.log')).open('ab')
stderr=(evidence/(args.phase+'-stderr.log')).open('ab')
process=subprocess.Popen([str(args.executable.resolve()),'--isolated-data-root',str(root)],stdout=stdout,stderr=stderr,creationflags=subprocess.CREATE_NO_WINDOW)
print(json.dumps({'phase':args.phase,'pid':process.pid,'state':'started'}),flush=True)
last=None;result=None;deadline=time.monotonic()+360
try:
 while time.monotonic()<deadline:
  if result_path.exists():
   try: result=json.loads(result_path.read_text(encoding='utf-8'))
   except (ValueError,OSError): result=None
   if result:
    event=result.get('events',[])
    name=event[-1].get('name') if event else None
    if name and name!=last:
     print(json.dumps({'phase':args.phase,'event':name}),flush=True);last=name
    if result.get('state') in ['passed','failed']: break
  if process.poll() is not None: break
  time.sleep(.25)
 if not result or result.get('state') not in ['passed','failed']:
  raise RuntimeError('No terminal fixture result; inspect the owned evidence directory')
 try: process.wait(timeout=20)
 except subprocess.TimeoutExpired: raise RuntimeError('The owned application did not exit normally')
 after_files={p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in (root/'vault').glob('*.md')}
 if args.phase in ['stop','resume','narrow','unknown'] and result['state']=='passed':
  assert before_files==after_files, 'A read/recovery/inspection phase unexpectedly changed vault files'
 receipt={'phase':args.phase,'pid':process.pid,'executableSha256':hashlib.sha256(args.executable.read_bytes()).hexdigest(),'exitCode':process.returncode,'state':result['state'],'beforeFiles':before_files,'afterFiles':after_files,'details':result.get('details',{}),'events':result.get('events',[])}
 (evidence/(args.phase+'-session.json')).write_text(json.dumps(receipt,ensure_ascii=False,indent=2),encoding='utf-8')
 print(json.dumps({'phase':args.phase,'state':result['state'],'events':len(result.get('events',[])),'error':result.get('events',[])[-1].get('error') if result.get('events') else None},ensure_ascii=True),flush=True)
 if result['state']!='passed': raise SystemExit(1)
finally:
 # This exact process belongs to this script and this isolated root only.
 if process.poll() is None: process.terminate();process.wait(timeout=15)
 stdout.close();stderr.close()
