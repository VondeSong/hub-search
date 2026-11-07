"""HBM-00 operational continuation. New identities; old results are read-only."""
from pathlib import Path
import hashlib, json, os, shutil, subprocess, time
from datetime import datetime, timezone

ROOT=Path(__file__).resolve().parents[2]
WORK=ROOT/'.local/hbm-00/lifecycle-20261018'
REPORTS=ROOT/'artifacts/hbm-00-lifecycle-20261018'
OLD=ROOT/'.local/hbm-00/qualification-20261018'
OLD_REPORTS=ROOT/'artifacts/hbm-00-qualification-20261018'
PYTHON=OLD/'bm-lifecycle/runtime/Scripts/python.exe'
FLAGS=getattr(subprocess,'CREATE_NO_WINDOW',0)
def now():return datetime.now(timezone.utc).isoformat()
def digest(p):return hashlib.sha256(Path(p).read_bytes()).hexdigest()
def read(p):return json.loads(Path(p).read_text(encoding='utf-8'))
def save(p,data):
    with Path(p).open('x',encoding='utf-8') as f:json.dump(data,f,ensure_ascii=False,indent=2)
def register():
    WORK.mkdir(exist_ok=False);REPORTS.mkdir(exist_ok=False);(WORK/'tmp').mkdir()
    assert shutil.disk_usage(WORK).free>=10*1024**3
    save(REPORTS/'scope.json',{'at':now(),'userScope':'HBM-00 native same-condition lifecycle; repair BM readiness; deletes/replacements/recovery; no quality retuning, backend adoption or later batch',
      'methods':{'profile':'Four updates per arm, independent100note seed copies, sync flush2 vs32; provider batch2/CPU threads2 unchanged. All actual client ACK/ready times retained. 5s gate unchanged; continued observation <=60s is diagnosis only.',
       'formal':'Same100whole synthetic notes/5100chunks;5freshstarts<=10s;20updates20deletes20replacements;5s after ACK readback, all tested even if another gate fails when safe; duplicate replay; isolated closed backup restore and fresh-process restart.',
       'native':'Existing Hub upsert/delete/index jobs/EvidenceReader, test-only vector table in the same SQLite transaction, actual Rust embedding child. Controlled shared chunk inputs from pure BM parser, no copied stored vectors. Rust cosine scanning is experimental, not a production memory module.',
       'accounting':'Record request-to-ack, ack-to-ready, total including checks/retry, process resources, all failures. ACK may not be moved after an artificial wait. No new LLM calls.',
       'runtime':'Windows local; initial indexing separate; no OS cache flush; sequential timed arms; closed-owned process trees only; no24hclaim.'},
      'corpusSha256':digest(OLD_REPORTS/'backend-operational-corpus.json'),
      'priorFailureSha256':digest(OLD_REPORTS/'bm-lifecycle-result.json'),
      'thresholds':{'postAckVisibilityMs':5000,'coldFirstUsableMs':10000,'wholeNotes':100,'semanticChunks':5100},
      'ci':'No Git root/remote found; formal test-rust.mjs collect-only exact one opt-in lifecycle RPC; no full suite or packaging.',
      'budget':'One focused native build (<=30min), four+four BM diagnostics (<=15min), two formal lifecycle arms (<=30min each); bounded repair only of demonstrated harness/operational defects. User explicitly authorized operational tests.',
      'paths':{'ownedWork':str(WORK),'reports':str(REPORTS),'managedPython':str(PYTHON),'producer':'qa/memory-selection and one test-only Rust module','retention':'Keep evidence; no deletion of prior runs or production data'},
      'baseline':{n:digest(ROOT/n) for n in ['src-tauri/Cargo.toml','src-tauri/Cargo.lock','qa/memory-selection/qualification_bm_lifecycle.py','qa/memory-selection/qualification_run.py']}})
    print('Operational scope and unchanged thresholds registered.')
if __name__=='__main__':register()
