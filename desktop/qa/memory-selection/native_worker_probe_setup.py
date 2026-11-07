"""Prepare isolated dependency instrumentation; original sources retained byte for byte."""
from pathlib import Path
import datetime,hashlib,json,shutil
ROOT=Path(__file__).resolve().parents[2]
R=ROOT/'artifacts/hbm-00-native-worker-20261019'
DEP=ROOT/'.local/hbm-00/lifecycle-20261018/recovery-20261019/worker-probe/tantivy'
ORIGIN=Path('C:/Users/yongs/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/tantivy-0.22.1')
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def main():
 R.mkdir(exist_ok=False)
 files=['src-tauri/src/lib.rs','src-tauri/src/search_index.rs','src-tauri/src/search_index_runtime.rs','src-tauri/src/agent_work/memory_lifecycle_tests.rs','src-tauri/Cargo.toml','src-tauri/Cargo.lock']
 originals={f:sha(ROOT/f) for f in files}
 for i,f in enumerate(files):(R/f'original-{i}.bin').write_bytes((ROOT/f).read_bytes())
 contract={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'originals':originals,
 'scope':'One build (at most one mechanical compile repair if necessary); one frozen paired run, off then on,12 identical operations each; 360s measurement budget total. No suspension/stack/symbol/ETW sampling. No24h/backend/later batches.',
 'input':[[2,664],[3,664],[2,665],[4,664],[2,666],[5,664]],'retryEach':True,'gateMs':5000,
 'method':'Fresh process and full closed source copy per arm. Same binary flags disabled/enabled. Nonrandom order limits causal overhead conclusion; do not tune/repeat.',
 'telemetry':'In-memory bounded 20000 events. Monotonic timestamps + UTC anchor,PID/TID,threadCPU. No hot-path log/serialization. Dump only on close after final query. Init/reserve before ready. Mutex contention measured as record overhead, no claim zero overhead.',
 'hypotheses':['worker ingest/serialization CPU','writer close/sync','deletion processing','updater queue or execution','thread exit/restart overhead'],
 'decision':'If on/off median full-path increase >10% or lost events, mark overhead uncertain and no performance improvement claim; all original gate failures retained; no automatic rerun.',
 'restore':'Restore all six original files exactly; helper removed; isolated dependency snapshots retained; global cargo registry untouched'}
 (R/'contract.json').write_text(json.dumps(contract,indent=2),encoding='utf-8')
 shutil.copytree(ORIGIN,DEP)
 prior=ROOT/'artifacts/hbm-00-native-commit-wait-20261019'
 for i,f in enumerate(files[:4]):
  assert originals[f]==json.loads((prior/'contract.json').read_text())['originals'][f]
  (ROOT/f).write_bytes((prior/f'instrumented-{i}.rs').read_bytes())
 (ROOT/'src-tauri/src/hbm_stage_diag.rs').write_text('pub(crate) fn span(name: &\'static str) -> tantivy::hbm_probe::Span { tantivy::hbm_probe::span(name) }\n')
 p=ROOT/files[3];s=p.read_text();s=s.replace('if op=="close" { reply(', 'if op=="close" { tantivy::hbm_probe::dump(); reply(')
 s=s.replace('fn native_lifecycle_rpc() {','fn native_lifecycle_rpc() {\n    tantivy::hbm_probe::init();')
 assert 'hbm_probe::init' in s;p.write_text(s)
 p=ROOT/'src-tauri/Cargo.toml';p.write_text(p.read_text()+f'\n[patch.crates-io]\ntantivy = {{ path = "{DEP.as_posix()}" }}\n')
 helper=r'''#![allow(missing_docs)]
use std::sync::{Mutex,OnceLock};
use std::sync::atomic::{AtomicU64,Ordering};
use std::time::{Instant,SystemTime,UNIX_EPOCH};
#[repr(C)] #[derive(Default)] struct Ft {lo:u32,hi:u32}
#[link(name="kernel32")] extern "system" {fn GetCurrentThreadId()->u32;fn GetCurrentThread()->*mut std::ffi::c_void;fn GetThreadTimes(h:*mut std::ffi::c_void,c:*mut Ft,e:*mut Ft,k:*mut Ft,u:*mut Ft)->i32;}
fn cpu()->u64{unsafe{let(mut c,mut e,mut k,mut u)=(Ft::default(),Ft::default(),Ft::default(),Ft::default());if GetThreadTimes(GetCurrentThread(),&mut c,&mut e,&mut k,&mut u)==0{return u64::MAX;}((((k.hi as u64)<<32)|k.lo as u64)+(((u.hi as u64)<<32)|u.lo as u64))*100}}
struct State{enabled:bool,origin:Instant,unix_ms:f64,events:Mutex<Vec<Event>>,lost:AtomicU64,cost:AtomicU64,max_cost:AtomicU64}
#[derive(serde::Serialize)] struct Event{phase:&'static str,tid:u32,start_ns:u64,end_ns:u64,cpu_ns:u64}
static STATE:OnceLock<State>=OnceLock::new();
fn state()->&'static State{STATE.get_or_init(||State{enabled:std::env::var("HBM_WORKER_PROBE").ok().as_deref()==Some("1"),origin:Instant::now(),unix_ms:SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs_f64()*1000.,events:Mutex::new(Vec::with_capacity(20000)),lost:AtomicU64::new(0),cost:AtomicU64::new(0),max_cost:AtomicU64::new(0)})}
pub fn init(){let _=state();}
pub struct Span{name:&'static str,start:u64,cpu:u64,tid:u32,enabled:bool}
pub fn span(name:&'static str)->Span{let s=state();if !s.enabled{return Span{name,start:0,cpu:0,tid:0,enabled:false}};Span{name,start:s.origin.elapsed().as_nanos() as u64,cpu:cpu(),tid:unsafe{GetCurrentThreadId()},enabled:true}}
impl Drop for Span{fn drop(&mut self){if !self.enabled{return}let s=state();let end=s.origin.elapsed().as_nanos() as u64;let cost=Instant::now();let end_cpu=cpu();let mut events=s.events.lock().unwrap();if events.len()<20000{events.push(Event{phase:self.name,tid:self.tid,start_ns:self.start,end_ns:end,cpu_ns:if self.cpu==u64::MAX||end_cpu==u64::MAX{u64::MAX}else{end_cpu-self.cpu}})}else{s.lost.fetch_add(1,Ordering::Relaxed);}drop(events);let ns=cost.elapsed().as_nanos() as u64;s.cost.fetch_add(ns,Ordering::Relaxed);s.max_cost.fetch_max(ns,Ordering::Relaxed);}}
pub fn dump(){let s=state();if let Some(path)=std::env::var_os("HBM_WORKER_REPORT"){let events=s.events.lock().unwrap();let value=serde_json::json!({"enabled":s.enabled,"pid":std::process::id(),"unixAnchorMs":s.unix_ms,"events":*events,"lost":s.lost.load(Ordering::Relaxed),"recordCostNs":s.cost.load(Ordering::Relaxed),"maxRecordCostNs":s.max_cost.load(Ordering::Relaxed)});std::fs::write(path,serde_json::to_vec(&value).unwrap()).unwrap();}}
'''
 (DEP/'src/hbm_probe.rs').write_text(helper)
 p=DEP/'src/lib.rs';p.write_text(p.read_text()+'\n#[allow(missing_docs)] pub mod hbm_probe;\n')
 def edit(rel,old,new,count=1):
  p=DEP/rel;s=p.read_text();assert s.count(old)==count,(rel,old,s.count(old));p.write_text(s.replace(old,new))
 iw='src/indexer/index_writer.rs'
 edit(iw,'    let mut segment_writer = SegmentWriter::for_segment(memory_budget, segment.clone())?;','    let _all = crate::hbm_probe::span("worker-index-documents");\n    let init = crate::hbm_probe::span("worker-create-writer");\n    let mut segment_writer = SegmentWriter::for_segment(memory_budget, segment.clone())?;\n    drop(init);\n    let ingest = crate::hbm_probe::span("worker-ingest-and-channel");')
 edit(iw,'    if !segment_updater.is_alive() {','    drop(ingest);\n    if !segment_updater.is_alive() {')
 edit(iw,'    let doc_opstamps: Vec<Opstamp> = segment_writer.finalize()?;','    let finalize = crate::hbm_probe::span("worker-finalize");\n    let doc_opstamps: Vec<Opstamp> = segment_writer.finalize()?;\n    drop(finalize);')
 edit(iw,'    let alive_bitset_opt = apply_deletes(&segment_with_max_doc, &mut delete_cursor, &doc_opstamps)?;','    let deletes = crate::hbm_probe::span("worker-apply-deletes");\n    let alive_bitset_opt = apply_deletes(&segment_with_max_doc, &mut delete_cursor, &doc_opstamps)?;\n    drop(deletes);')
 edit(iw,'    segment_updater.schedule_add_segment(segment_entry).wait()?;','    let scheduled = crate::hbm_probe::span("worker-register-segment-wait");\n    segment_updater.schedule_add_segment(segment_entry).wait()?;\n    drop(scheduled);')
 edit(iw,'        self.recreate_document_channel();','        let channel = crate::hbm_probe::span("prepare-channel-close");\n        self.recreate_document_channel();\n        drop(channel);')
 edit(iw,'            let indexing_worker_result = worker_handle','            let joining = crate::hbm_probe::span("prepare-one-worker-join");\n            let indexing_worker_result = worker_handle')
 edit(iw,'            indexing_worker_result?;\n            self.add_indexing_worker()?;','            indexing_worker_result?;\n            drop(joining);\n            let spawning = crate::hbm_probe::span("prepare-new-worker");\n            self.add_indexing_worker()?;\n            drop(spawning);')
 sw='src/indexer/segment_writer.rs'
 edit(sw,'    debug!("remap-and-write");','    let norms = crate::hbm_probe::span("finalize-fieldnorms");\n    debug!("remap-and-write");')
 edit(sw,'    serialize_postings(\n','    drop(norms);\n    let postings = crate::hbm_probe::span("finalize-postings");\n    serialize_postings(\n')
 edit(sw,'    debug!("fastfield-serialize");','    drop(postings);\n    let fast = crate::hbm_probe::span("finalize-fastfields");\n    debug!("fastfield-serialize");')
 edit(sw,'    // finalize temp docstore and create version, which reflects the doc_id_map','    drop(fast);\n    let store = crate::hbm_probe::span("finalize-remap-store");\n    // finalize temp docstore and create version, which reflects the doc_id_map')
 edit(sw,'    debug!("serializer-close");','    drop(store);\n    let close = crate::hbm_probe::span("finalize-serializer-close");\n    debug!("serializer-close");')
 edit(sw,'    serializer.close()?;','    serializer.close()?;\n    drop(close);')
 ss='src/indexer/segment_serializer.rs'
 for old,name in [('        self.fast_field_write.terminate()?;','close-fastfield-terminate'),('        self.postings_serializer.close()?;','close-postings'),('        self.store_writer.close()?;','close-docstore')]:
  edit(ss,old,f'        let measure = crate::hbm_probe::span("{name}");\n{old}\n        drop(measure);')
 su='src/indexer/segment_updater.rs'
 edit(su,'        let segment_updater = self.clone();\n        self.schedule_task(move || {\n            segment_updater.segment_manager.add_segment(segment_entry);','        let segment_updater = self.clone();\n        let queued = crate::hbm_probe::span("updater-add-queue");\n        self.schedule_task(move || {\n            drop(queued);\n            let _run = crate::hbm_probe::span("updater-add-execute");\n            segment_updater.segment_manager.add_segment(segment_entry);')
 # Queue spans cross threads: their cpu delta is not interpreted; tids identify enqueue side.
 for i,f in enumerate(files[:5]):(R/f'instrumented-{i}.bin').write_bytes((ROOT/f).read_bytes())
 (R/'hbm_stage_diag.rs').write_bytes((ROOT/'src-tauri/src/hbm_stage_diag.rs').read_bytes())
 (R/'dependency-manifest.json').write_text(json.dumps({str(p.relative_to(DEP)):sha(p) for p in DEP.rglob('*') if p.is_file()},indent=2))
 print('Frozen setup prepared',R)
if __name__=='__main__':main()
