"""Bounded developer-host relocation evidence, explicitly not offline acceptance."""
from deployment_component import *
import struct

OUT=ROOT/'artifacts/hbm-00-portable-inventory-v2-20261019'
BASE=ROOT/'.local/hbm-00/portable-inventory-v2-20261019'

def imports(path):
    b=path.read_bytes(); pe=struct.unpack_from('<I',b,60)[0]
    count=struct.unpack_from('<H',b,pe+6)[0]; size=struct.unpack_from('<H',b,pe+20)[0]; opt=pe+24
    directory=opt+(112 if struct.unpack_from('<H',b,opt)[0]==523 else 96)
    sections=[]
    for i in range(count):
        s=opt+size+i*40; vs,va,rs,rp=struct.unpack_from('<IIII',b,s+8);sections.append((va,max(vs,rs),rp))
    def off(rva):
        for va,n,rp in sections:
            if va<=rva<va+n:return rp+rva-va
        raise ValueError(rva)
    def string(rva):
        p=off(rva);return b[p:b.index(b'\0',p)].decode('ascii')
    def table(index,stride,namepos):
        rva=struct.unpack_from('<I',b,directory+index*8)[0]
        if not rva:return []
        p=off(rva);names=[]
        while any(b[p:p+stride]):
            names.append(string(struct.unpack_from('<I',b,p+namepos)[0]));p+=stride
        return names
    return {'imports':table(1,20,12),'delayImports':table(13,32,4)}

def main():
    assert not OUT.exists() and not BASE.exists()
    OUT.mkdir();BASE.mkdir(parents=True)
    receipt=read(PREV/'native-harness-v2.json')
    protected=read(ROOT/'artifacts/hbm-00-deployment-components-20261019/contract.json')
    assert digest(receipt['executable'])==receipt['binarySha256']
    save(OUT/'contract.json',{'at':now(),'driverSha256':digest(__file__),'budgetSeconds':180,
        'firstUsableLimitMs':10000,'rpcLimitSeconds':30,'cases':2,
        'scope':'Same-host closed-state copy between two Unicode/space roots; empty profile/cache and System32-only PATH; no network isolation, clean OS, GUI or production integration claim.',
        'pass':'Each actual lexical/vector query plus full100note5100chunk state matches, startup<=10s, clean exit; copied bytes exact; originals unchanged.',
        'stop':'No retry/tuning/24h/backend choice; retain failure.', 'seed':manifest(SEED),'bundle':manifest(BUNDLE),
        'oldFailureSha256':digest(PREV/'soak-result.json')})
    source=ROOT/'artifacts/hbm-00-qualification-20261018/backend-dependency-inventory.json'
    inventory={'provenanceInventory':str(source),'provenanceSha256':digest(source),'files':[],
               'limit':'PE direct/delay imports only; dynamic loading and clean-host DLL availability remain unverified.'}
    for p in [Path(receipt['executable']),Path(receipt['executable']+'.manifest'),*sorted(BUNDLE.iterdir())]:
        row={'source':str(p),'bytes':p.stat().st_size,'sha256':digest(p),'role':'QA harness' if p.name.startswith('tests.exe') else 'embedding resource'}
        if p.suffix.lower() in ('.exe','.dll'):row.update(imports(p))
        inventory['files'].append(row)
    inventory['totalBytes']=sum(x['bytes'] for x in inventory['files']);save(OUT/'inventory.json',inventory)
    r={'startedAt':now(),'cases':[],'offlineExecuted':False,'cleanWindowsExecuted':False}
    started=time.perf_counter();client=None;original_env=os.environ.copy();original_receive=native.Native.receive
    def bounded(self):
        remaining=180-(time.perf_counter()-started)
        if remaining<=0:raise TimeoutError('180s budget exceeded')
        value=self.queue.get(timeout=min(30,remaining))
        if value is None:raise RuntimeError('RPC exited')
        if isinstance(value,Exception):raise value
        return value
    native.Native.receive=bounded
    previous=None
    try:
        for label in ['首次 空配置','迁移 新位置']:
            root=BASE/label;run=root/'lifecycle-20261018';run.mkdir(parents=True);(run/'tmp').mkdir()
            resources=root/'resources';state=run/'state'
            shutil.copytree(previous/'resources' if previous else ROOT/'.local/hbm-00/deployment-components-20261019/resources',resources)
            source_state=previous/'lifecycle-20261018/state' if previous else SEED
            before=manifest(source_state);shutil.copytree(source_state,state);assert manifest(state)==before
            case_report=OUT/str(len(r['cases'])+1);case_report.mkdir()
            rr=dict(receipt);rr['executable']=str(resources/'harness/tests.exe');save(case_report/'native-harness-v2.json',rr)
            profile=root/'empty-profile';profile.mkdir()
            os.environ.clear();os.environ.update(original_env)
            for key in list(os.environ):
                if key.startswith(('HBM_','HF_','HUGGINGFACE_','ORT_','PYTHON')):os.environ.pop(key,None)
            os.environ.update(PATH=str(Path(os.environ['SystemRoot'])/'System32'),USERPROFILE=str(profile),HOME=str(profile),
                              APPDATA=str(profile/'Roaming'),LOCALAPPDATA=str(profile/'Local'),HF_HOME=str(profile/'hf'),
                              XDG_CACHE_HOME=str(profile/'cache'),HF_HUB_OFFLINE='1',TRANSFORMERS_OFFLINE='1')
            native.ROOT=root;native.REPORTS=case_report;native.WORK=run;native.OLD=resources
            t=time.perf_counter();client=start(state);found=lookup(client,'hbm-op-000',body(0))
            row={'root':str(root),'firstUsableMs':(time.perf_counter()-t)*1000,'found':found,'copyExact':True,
                 'fullState':matches(client.snapshot(),{v['id']:v['content'] for v in corpus()}),'owned':client.usage()['members']}
            row['residual']=client.close();client=None
            row['passed']=found and row['fullState'] and row['firstUsableMs']<=10000 and not row['residual']
            r['cases'].append(row);save(OUT/f'case-{len(r["cases"])}.json',row);assert row['passed']
            previous=root
        r['passed']=True
    except BaseException as e:r.update(passed=False,error=repr(e))
    finally:
        r['cleanupResidual']=client.close() if client else []
        os.environ.clear();os.environ.update(original_env);native.Native.receive=original_receive
        r['wallMs']=(time.perf_counter()-started)*1000
        c=read(OUT/'contract.json');r['originalSeedUnchanged']=manifest(SEED)==c['seed'];r['originalResourcesUnchanged']=manifest(BUNDLE)==c['bundle']
        r['oldFailureUnchanged']=digest(PREV/'soak-result.json')==c['oldFailureSha256']
        r['finishedAt']=now();save(OUT/'result.json',r)
    print(json.dumps(r,ensure_ascii=False))

if __name__=='__main__':main()
