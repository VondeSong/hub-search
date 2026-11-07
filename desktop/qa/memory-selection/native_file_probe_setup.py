"""One isolated file-boundary diagnosis; do not reuse a consumed identity."""
from pathlib import Path
import datetime,hashlib,json,shutil
ROOT=Path(__file__).resolve().parents[2]
R=ROOT/'artifacts/hbm-00-native-file-20261019'
PRIOR=ROOT/'artifacts/hbm-00-native-worker-20261019'
OLD=ROOT/'.local/hbm-00/lifecycle-20261018/recovery-20261019/worker-probe/tantivy'
DEP=ROOT/'.local/hbm-00/lifecycle-20261018/recovery-20261019/file-probe/tantivy'
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def main():
 R.mkdir(exist_ok=False)
 prev=json.loads((PRIOR/'contract.json').read_text());files=list(prev['originals'])
 for f,h in prev['originals'].items():assert sha(ROOT/f)==h,f
 contract=dict(prev,at=datetime.datetime.now(datetime.timezone.utc).isoformat(),
    hypotheses=['actual file create/open','managed registry lock and rewrite','buffered File.write','File.flush','File.sync_data','atomic metadata persist/replace'],
    telemetry='Same memory-only20000-event collector extended with bounded4096 file identities, basename only and requested bytes. File and atomic-write boundaries plus managed lock/save. No suspend,ETW,hot-path disk output; close-time dump.',
    scope='One build (one mechanical compile repair max); off/on fixed12ops each fresh100note/5100vector copies;360s total measurement budget; original5s/10s and failures retained; no24h/backend/later batches',
    decision='Median full-path increase >10% or lost events/file identities => overhead uncertain. Off/on sequential order not randomized, no speedup claim. No automatic rerun.')
 (R/'contract.json').write_text(json.dumps(contract,indent=2),encoding='utf-8')
 for i,f in enumerate(files):(R/f'original-{i}.bin').write_bytes((ROOT/f).read_bytes())
 shutil.copytree(OLD,DEP)
 for i,f in enumerate(files[:4]):(ROOT/f).write_bytes((PRIOR/f'instrumented-{i}.bin').read_bytes())
 (ROOT/'src-tauri/src/hbm_stage_diag.rs').write_bytes((PRIOR/'hbm_stage_diag.rs').read_bytes())
 p=ROOT/files[4];p.write_text(p.read_text()+f'\n[patch.crates-io]\ntantivy = {{ path = "{DEP.as_posix()}" }}\n')
 def edit(rel,old,new,count=1):
  p=DEP/rel;s=p.read_text();assert s.count(old)==count,(rel,old,s.count(old));p.write_text(s.replace(old,new))
 hp='src/hbm_probe.rs'
 edit(hp,'events:Mutex<Vec<Event>>,lost:', 'events:Mutex<Vec<Event>>,files:Mutex<Vec<String>>,lost:')
 edit(hp,'cpu_ns:u64}', 'cpu_ns:u64,file_id:u64,requested_bytes:usize}')
 edit(hp,'events:Mutex::new(Vec::with_capacity(20000)),lost:', 'events:Mutex::new(Vec::with_capacity(20000)),files:Mutex::new(Vec::with_capacity(4096)),lost:')
 edit(hp,'tid:u32,enabled:bool}', 'tid:u32,enabled:bool,file_id:u64,requested_bytes:usize}')
 edit(hp,'tid:0,enabled:false}', 'tid:0,enabled:false,file_id:0,requested_bytes:0}')
 edit(hp,'GetCurrentThreadId()},enabled:true}', 'GetCurrentThreadId()},enabled:true,file_id:0,requested_bytes:0}')
 edit(hp,'tid:self.tid,start_ns:', 'tid:self.tid,file_id:self.file_id,requested_bytes:self.requested_bytes,start_ns:')
 edit(hp,'"events":*events,"lost":','"events":*events,"files":*s.files.lock().unwrap(),"lost":')
 p=DEP/hp;p.write_text(p.read_text()+'''
pub fn file_id(path:&std::path::Path)->u64{let s=state();if !s.enabled{return 0;}let mut files=s.files.lock().unwrap();if files.len()>=4096{s.lost.fetch_add(1,Ordering::Relaxed);return 0;}files.push(path.file_name().unwrap_or_default().to_string_lossy().into_owned());files.len() as u64}
pub fn file_span(name:&'static str,id:u64,bytes:usize)->Span{let mut event=span(name);event.file_id=id;event.requested_bytes=bytes;event}
''')
 mm='src/directory/mmap_directory.rs'
 edit(mm,'struct SafeFileWriter(File);','struct SafeFileWriter(File,u64);')
 edit(mm,'fn new(file: File) -> SafeFileWriter {\n        SafeFileWriter(file)','fn new(file: File, id:u64) -> SafeFileWriter {\n        SafeFileWriter(file,id)')
 edit(mm,'        self.0.write(buf)','        let _span=crate::hbm_probe::file_span("file-write",self.1,buf.len());\n        self.0.write(buf)')
 edit(mm,'        self.0.flush()?;\n        self.0.sync_data()?;','        let flush=crate::hbm_probe::file_span("file-terminate-flush",self.1,0);\n        self.0.flush()?;\n        drop(flush);\n        let sync=crate::hbm_probe::file_span("file-sync-data",self.1,0);\n        self.0.sync_data()?;\n        drop(sync);')
 edit(mm,'    let mut tempfile = tempfile::Builder::new().tempfile_in(parent_path)?;\n    tempfile.write_all(content)?;\n    tempfile.flush()?;\n    tempfile.as_file_mut().sync_data()?;\n    tempfile.into_temp_path().persist(path)?;', '''    let id=crate::hbm_probe::file_id(path);
    let _all=crate::hbm_probe::file_span("atomic-total",id,content.len());
    let create=crate::hbm_probe::file_span("atomic-temp-create",id,0);
    let mut tempfile = tempfile::Builder::new().tempfile_in(parent_path)?;
    drop(create);
    let write=crate::hbm_probe::file_span("atomic-write-all",id,content.len());
    tempfile.write_all(content)?;
    drop(write);
    let flush=crate::hbm_probe::file_span("atomic-flush",id,0);
    tempfile.flush()?;
    drop(flush);
    let sync=crate::hbm_probe::file_span("atomic-sync-data",id,0);
    tempfile.as_file_mut().sync_data()?;
    drop(sync);
    let persist=crate::hbm_probe::file_span("atomic-persist",id,0);
    tempfile.into_temp_path().persist(path)?;
    drop(persist);''')
 edit(mm,'        let open_res = OpenOptions::new()','        let id=crate::hbm_probe::file_id(path);\n        let opening=crate::hbm_probe::file_span("file-create-new",id,0);\n        let open_res = OpenOptions::new()')
 edit(mm,'        let mut file = open_res.map_err','        drop(opening);\n        let mut file = open_res.map_err')
 edit(mm,'        // making sure the file is created.','        let flushing=crate::hbm_probe::file_span("file-created-flush",id,0);\n        // making sure the file is created.')
 edit(mm,'        let writer = SafeFileWriter::new(file);','        drop(flushing);\n        let writer = SafeFileWriter::new(file,id);')
 md='src/directory/managed_directory.rs'
 edit(md,'    fn register_file_as_managed(&self, filepath: &Path) -> io::Result<()> {','    fn register_file_as_managed(&self, filepath: &Path) -> io::Result<()> {\n        let id=crate::hbm_probe::file_id(filepath);\n        let _all=crate::hbm_probe::file_span("managed-register",id,0);')
 edit(md,'        let mut meta_wlock = self\n            .meta_informations\n            .write()\n            .expect("Managed file lock poisoned");','        let locking=crate::hbm_probe::file_span("managed-lock-wait",id,0);\n        let mut meta_wlock = self\n            .meta_informations\n            .write()\n            .expect("Managed file lock poisoned");\n        drop(locking);')
 edit(md,'        save_managed_paths(self.directory.as_ref(), &meta_wlock)?;','        let saving=crate::hbm_probe::file_span("managed-save",id,0);\n        save_managed_paths(self.directory.as_ref(), &meta_wlock)?;\n        drop(saving);')
 for i,f in enumerate(files[:5]):(R/f'instrumented-{i}.bin').write_bytes((ROOT/f).read_bytes())
 (R/'hbm_stage_diag.rs').write_bytes((ROOT/'src-tauri/src/hbm_stage_diag.rs').read_bytes())
 for f in ['src/hbm_probe.rs',mm,md]:
  target=R/'dependency-snapshots'/f;target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes((DEP/f).read_bytes())
 (R/'dependency-manifest.json').write_text(json.dumps({str(p.relative_to(DEP)):sha(p) for p in DEP.rglob('*') if p.is_file()},indent=2))
 for old,new in [('native_worker_probe_run.py','native_file_probe_run.py'),('native_worker_probe_analyze.py','native_file_probe_analyze.py')]:
  source=(ROOT/'qa/memory-selection'/old).read_text().replace('hbm-00-native-worker-20261019','hbm-00-native-file-20261019').replace("AREA/'worker-probe'","AREA/'file-probe'")
  (ROOT/'qa/memory-selection'/new).write_text(source)
 print('Frozen file-boundary probe prepared')
if __name__=='__main__':main()
