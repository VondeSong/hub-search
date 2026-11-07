"""At most ONE checkpoint resume, only if preparation ended BEFORE any retrieval.

This never changes the frozen methods, labels, queries, budgets or scorer.
Original failure remains evaluation.json; completed continuation is separately named.
Read routing is explicit here so old evidence is not overwritten or hidden.
"""
import argparse
import json
from pathlib import Path
import runpy
import time
import psutil
import parity_support as support
from parity_support import ROOT, WORK, REPORTS, digest, now

def resume():
    import parity_index
    import parity_evaluate
    from passage_index import tokenizer
    failed=support.read('evaluation.json')
    assert failed['status']=='failed' and failed.get('errorType')=='TimeoutError'
    assert failed['rows']==[] and failed['modelCalls']==[]
    assert not (WORK/'formal-index/formal-native-input.json').exists()
    assert not (WORK/'formal-server').exists()
    assert not list(REPORTS.glob('row-*.json'))
    assert support.read('method-contract.json')['sources']==parity_evaluate.source_hashes()
    prior=json.loads((WORK/'formal-index/bm/process.json').read_text(encoding='utf-8'))
    assert prior['status']=='exited' and prior['residual']==[]
    try:
        p=psutil.Process(prior['pid'])
        assert p.create_time()!=prior['createTime']
    except psutil.NoSuchProcess:
        pass
    support.save('preparation-resume-contract.json',{
        'at':now(),'reason':'Full real-note passage materialization exceeded the unchanged900s preparation safety window. Zero holdout queries/model calls occurred.',
        'maximumCheckpointResumes':1,'validationExecutions':1,'validationRowsAlreadyExecuted':0,
        'unchanged':['Corpus bytes','Questions and labels','Search methods and limits','Embedding weights','Policy/schema/model/effort','Scorer and gates','900s preparation safety window'],
        'onlyChanges':['Restore Index object from original frozen canonical/passages manifest instead of rewriting files',
                       'Restart same owned BM service against its persisted partial index',
                       'Name start/result continuation receipts separately, explicitly route offline consumers'],
        'priorFailureSha256':digest(REPORTS/'evaluation.json'),'priorBmExitReceipt':prior,
        'resumeDriverSha256':digest(Path(__file__)),'totalPreparationCost':'First failed preparation wall plus resumed preparation; never report resumed warm checkpoint as independent cold-start improvement.',
        'stop':'If this preparation also fails, retain both and stop the experiment. No further initialization/query/model retries.'})
    original_save=parity_evaluate.save
    def save(name,value):
        route={'execution-start.json':'execution-resume-start.json','evaluation.json':'evaluation-resumed.json'}
        original_save(route.get(name,name),value)
    parity_evaluate.save=save
    def restore(self,corpus,name):
        assert name=='formal-index'
        self.root=WORK/name
        self.records={r['id']:r for r in corpus['records']}
        manifest=json.loads((self.root/'passages.json').read_text(encoding='utf-8'))
        self.files,self.passages=manifest['files'],manifest['passages']
        assert set(self.files)==set(self.records)
        for item in self.files.values():
            assert digest(item['path'])==item['sha256']
        self.tok=tokenizer(); self.client=self.native=None
        self.state=self.root/'bm'
        import jieba
        jieba.dt.tmp_dir=str(self.root);jieba.initialize()
    parity_index.Index.__init__=restore
    parity_evaluate.evaluate()

def consume(phase):
    original_read=support.read
    completed=original_read('evaluation-resumed.json')
    assert completed['status']=='completed'
    # Explicit alias for these two offline consumers, not a replaced source file.
    def read(name):
        return original_read('evaluation-resumed.json' if name=='evaluation.json' else name)
    support.read=read
    runpy.run_path(str(Path(__file__).with_name('parity_'+phase+'.py')),run_name='__main__')
    if phase=='report':
        summary=original_read('summary.json');failed=original_read('evaluation.json')
        support.save('preparation-resume-cost.json',{'at':now(),'failedPreparationWallMs':failed['totalMs'],
            'completedContinuationWallMs':completed['totalMs'],
            'fullFormalWallIncludingFailedPreparationMs':failed['totalMs']+completed['totalMs'],
            'withPreflightWallMs':failed['totalMs']+completed['totalMs']+original_read('preflight.json')['wallMs'],
            'failedPreparationModelCalls':0,'actualModelAndPrewarmCost':summary['cost'],
            'validationRetrievalPassesPerBackend':1,'notLatencyOptimization':True})

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('phase',choices=['evaluate','report','deliver'])
    phase=p.parse_args().phase
    resume() if phase=='evaluate' else consume(phase)
