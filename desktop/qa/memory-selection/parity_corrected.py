"""Preparation-only protocol repair BEFORE any holdout query ever executed.

Retains the failed B experiment and byte-identical corpus/questions/scorer.
No retrieval, model, prompt, budget or score parameters are changed.
"""
import argparse
import json
import os
from pathlib import Path
import runpy
import shutil
import subprocess
import sys
import time
import psutil
from parity_support import *

PREVIOUS=ROOT/'artifacts/hbm-00-parity-20261018b'
PREVIOUS_WORK=ROOT/'.local/hbm-00/parity-20261018b'
STATE=PREVIOUS_WORK/'formal-index/bm'

def register():
    previous=json.loads((PREVIOUS/'summary.json').read_text(encoding='utf-8'))
    assert previous['formalModelCalls']==0 and previous['ownedProcessesStopped']
    failure=json.loads((PREVIOUS/'native-preparation-failure.json').read_text(encoding='utf-8'))
    assert failure['queryPhaseNotReached']
    WORK.mkdir(parents=True,exist_ok=False);HOME.mkdir();(WORK/'tmp').mkdir();(WORK/'shared-cwd').mkdir()
    scope=json.loads((PREVIOUS/'scope-contract.json').read_text(encoding='utf-8'))
    scope.update({'registeredAt':now(),'repairOf':str(PREVIOUS),'priorFailureSummarySha256':digest(PREVIOUS/'summary.json'),
        'preparationAmendment':{
            'why':'Both initializers failed before any holdout query. Generic fixture defects, not observed validation quality, require repair.',
            'changes':['Native fixture uses exactly the same production upsert and row values in one transaction instead of reopening/migrating twice per passage',
                       'Compare source snippets with CRLF/LF normalization; actual BM semantic strings are still shared byte-for-byte with native embedding',
                       'Explicit installed BM incremental vector completion before serving; retained partial derived DB belongs to this continued experiment',
                       'Common passage manifest/canonical files prepared independently of BM vector readiness'],
            'unchanged':['Frozen corpus/question/label bytes','Passage offsets and IDs','Query text and generic term extraction','Vector model/weights/dimensions/normalization','Raw limits/RRF60/parent20/final5','One best passage/2000BGE budget','Policy/schema/Sol/xhigh','Scorer/quality gates'],
            'primaryValidationExecutionsBeforeThis':0,'newQualityTuning':False,
            'borrowedMutableDerivedState':str(STATE),'borrowedReadOnlyCanonicalFiles':str(PREVIOUS_WORK/'formal-index/canonical'),
            'initialCost':'All failed B preparations, native fixture timeout and backfill are included in final aggregate; no claimed cold-start speedup.'},
        'budget':{**scope['budget'],'explicitVectorCompletionSeconds':900,'explicitVectorCompletionRuns':1,'nativeTargetedBuildsMaxAcrossBAndC':2}})
    save('scope-contract.json',scope)
    for name in ['corpus.json','validation.json','real-notes.json','label-quality-caveat.json','preflight.json','environment-receipt.json']:
        data=(PREVIOUS/name).read_bytes()
        with (REPORTS/name).open('xb') as stream:stream.write(data)
    save('preparation-repair-proof.json',{'at':now(),'originalFailedNativeDocuments':failure['fixtures'],
        'noHoldoutQueriesOrModelCallsBeforeRepair':True,'identicalDatasetFiles':{name:digest(REPORTS/name) for name in ['corpus.json','validation.json']},
        'rawLineEndingMismatch':909,'normalizedLineEndingMismatch':0,
        'sourceVersionsOfFailedExperiment':str(PREVIOUS/'executed-sources')})
    print('Corrected preparation registered; frozen dataset bytes unchanged.')

def backfill():
    import run as bm
    read('scope-contract.json')
    save('backfill-start.json',{'at':now(),'state':str(STATE),'maxSeconds':900,'modelCalls':0,'attempt':1})
    env=bm.environment(STATE,'hybrid');env.update({'TEMP':str(WORK/'tmp'),'TMP':str(WORK/'tmp')})
    began=time.perf_counter();p=None;members=[]
    with (WORK/'backfill.log').open('xb') as log:
        try:
            p=subprocess.Popen([sys.executable,'-m','basic_memory.cli.main','reindex','--embeddings','--project','notes'],
                cwd=ROOT,env=env,stdout=log,stderr=subprocess.STDOUT,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
            parent=psutil.Process(p.pid);created=parent.create_time()
            while p.poll() is None and time.perf_counter()-began<900:
                try:
                    members=[{'pid':q.pid,'createTime':q.create_time()} for q in [parent,*parent.children(recursive=True)]]
                except psutil.NoSuchProcess:pass
                time.sleep(.5)
            if p.poll() is None:raise TimeoutError('Bounded explicit vector completion exceeded900s')
            assert p.returncode==0,'Supported BM vector completion failed; retain log'
        finally:
            for identity in reversed(members):
                try:
                    child=psutil.Process(identity['pid'])
                    if child.create_time()==identity['createTime'] and child.is_running():child.terminate();child.wait(timeout=5)
                except psutil.NoSuchProcess:pass
            if p:p.wait(timeout=10)
            save('backfill.json',{'finishedAt':now(),'wallMs':(time.perf_counter()-began)*1000,
                 'exitCode':p.returncode if p else None,'members':members,'modelCalls':0,'logSha256':digest(WORK/'backfill.log')})
    print('Explicit complete-vector preparation finished.')

def freeze():
    from parity_evaluate import source_hashes
    from applicability_policy import POLICY,SCHEMA
    back=read('backfill.json');assert back['exitCode']==0
    # Find only the newly collected exact test identity, not an arbitrary binary.
    candidates=[]
    for path in (ROOT/'.local/rust-test-runs').glob('*/receipt.json'):
        r=json.loads(path.read_text(encoding='utf-8'))
        if r.get('status')=='collected' and r.get('collected')==1 and 'native_sqlite_tantivy_passage_parity' in str(r.get('tests')):
            candidates.append((r['finishedAt'],r))
    _,h=max(candidates)
    assert digest(h['executable'])==h['binarySha256'] and h['byteIdentical']
    save('native-harness.json',{k:h[k] for k in ['executable','binarySha256','byteIdentical','manifestSha256','collected']})
    save('method-contract.json',{'frozenAt':now(),'scopeSha256':digest(REPORTS/'scope-contract.json'),
         'sources':source_hashes(),'model':MODEL,'effort':EFFORT,'policy':POLICY,'schema':SCHEMA,
         'gates':read('scope-contract.json')['gates'],'repairDriverSha256':digest(Path(__file__)),
         'noRetrievalMethodChange':True,'priorFrozenDatasetReusedWithoutChanges':True})
    old=json.loads((PREVIOUS/'validation-contract.json').read_text(encoding='utf-8'))
    assert all(digest(REPORTS/name)==digest(PREVIOUS/name) for name in ['corpus.json','validation.json'])
    old.update({'adoptedAt':now(),'originalDatasetFrozenAt':old['frozenAt'],'methodSha256':digest(REPORTS/'method-contract.json'),
                'preparationOnlyAmendmentSha256':digest(REPORTS/'preparation-repair-proof.json'),
                'scorerSha256':digest(Path(__file__).with_name('parity_report.py'))})
    save('validation-contract.json',old)
    print('Repaired protocol frozen before first holdout query; labels/data/scorer unchanged.')

def evaluate():
    import parity_index
    import parity_evaluate
    assert read('method-contract.json')['repairDriverSha256']==digest(Path(__file__))
    os.environ['TEMP']=os.environ['TMP']=str(WORK/'tmp')
    def restore(self,corpus,name):
        assert name=='formal-index'
        self.root=WORK/name;self.root.mkdir(exist_ok=False)
        old=PREVIOUS_WORK/'formal-index/passages.json'
        manifest=json.loads(old.read_text(encoding='utf-8'))
        self.records={r['id']:r for r in corpus['records']}
        self.files,self.passages=manifest['files'],manifest['passages']
        assert set(self.files)==set(self.records)
        for item in self.files.values():assert digest(item['path'])==item['sha256']
        shutil.copy2(old,self.root/'passages.json')
        self.state=STATE;self.client=self.native=None;self.tok=parity_index.tokenizer()
        import jieba
        jieba.dt.tmp_dir=str(self.root);jieba.initialize()
    parity_index.Index.__init__=restore
    parity_evaluate.evaluate()

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('phase',choices=['register','backfill','freeze','evaluate'])
    {'register':register,'backfill':backfill,'freeze':freeze,'evaluate':evaluate}[p.parse_args().phase]()
