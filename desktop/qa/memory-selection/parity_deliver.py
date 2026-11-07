"""Offline diagnostics and ownership audit; does NOT alter frozen scoring."""
from collections import Counter
import json
import os
from pathlib import Path
import time
import psutil
from parity_support import *

def alive(identity):
    try:
        p=psutil.Process(identity['pid'])
        return p.is_running() and abs(p.create_time()-identity['createTime'])<.001
    except psutil.NoSuchProcess:
        return False

if __name__=='__main__':
    started=time.perf_counter()
    summary=read('summary.json'); scored=read('scored-results.json'); evaluation=read('evaluation.json')
    cases={q['id']:q for q in read('validation.json')['cases']}
    caveat=read('label-quality-caveat.json'); ambiguous=caveat['questionId']
    by={(r['id'],r['backend']):r for r in evaluation['rows']}
    arms=['hub-native-hybrid','basic-memory-hybrid']; diagnoses={}
    manifest=json.loads((WORK/'formal-index/passages.json').read_text(encoding='utf-8'))
    assert all(digest(f['path'])==f['sha256'] for f in manifest['files'].values())
    records={r['id']:r for r in read('corpus.json')['records']}
    exposure_violations=[]
    for row in evaluation['rows']:
        for candidate in row['retrieval']['candidates']:
            authority=records[candidate['id']]
            if not (candidate['project']==authority['project']==cases[row['id']]['project'] and
                    candidate['status']==authority['status']=='confirmed'):
                exposure_violations.append({'id':row['id'],'backend':row['backend'],'memory':candidate['id']})
    assert not exposure_violations
    receipts=[c['receipt'] for c in evaluation['modelCalls']]+[c['receipt'] for c in read('preflight.json')['calls']]
    assert all(r['model']==MODEL and r['effort']==EFFORT and r['toolCalls']==0 and
               r['freshEmptyHistory'] and r['ephemeral'] for r in receipts)
    for backend in arms:
        value=scored[backend]; failed=[]; review=[]
        for detail in value['details']:
            row=by[(detail['id'],backend)]
            if detail['positive'] and not detail['strictSelectedCorrect']:
                if detail['goldRank'] is None:
                    reason='gold-parent-missing-from-top20'
                elif detail['goldRank']>5:
                    reason='gold-parent-ranked6-to20'
                elif not detail['candidateHit']:
                    reason='candidate-budget-dropped-parent'
                elif not detail['evidencePassageHit']:
                    reason='parent-found-but-selected-passage-misses-frozen-evidence'
                else:
                    reason='verifier-or-strict-quote-anchor'
                from parity_index import fuse,unique
                parent=lambda ids:unique(manifest['passages'][pid]['memoryId'] for pid in ids)
                full=fuse(parent(row['retrieval']['vectorPassages']),parent(row['retrieval']['lexicalPassages']))
                assert full[:20]==row['retrieval']['fused']
                ranks=[full.index(mid)+1 for mid in detail['expected'] if mid in full]
                raw_pids=set(row['retrieval']['vectorPassages']+row['retrieval']['lexicalPassages'])
                raw_evidence=any(manifest['passages'][pid]['memoryId']==e['id'] and
                                 all(fragment in manifest['passages'][pid]['text'] for fragment in e['required'])
                                 for pid in raw_pids for e in detail['evidence'])
                failed.append({'id':detail['id'],'reason':reason,'goldRank':detail['goldRank'],'query':detail['query'],
                    'fullAvailableParentRank':min(ranks) if ranks else None,'frozenEvidenceInRawPassagePool':raw_evidence})
            if detail['selectedIds'] or (detail['positive'] and detail['candidateHit']):
                review.append({'id':detail['id'],'positive':detail['positive'],'query':detail['query'],
                               'checked':detail['checked'],'expectedEvidence':detail['evidence'],
                               'candidateExcerpts':row['retrieval']['candidates']})
        negatives=[r for r in value['details'] if not r['positive'] and r['id']!=ambiguous]
        lexical_hits=sum(bool(set(cases[r['id']]['expected'])&set(by[(r['id'],backend)]['retrieval']['lexical'][:5]))
                         for r in value['details'] if r['positive'])
        diagnoses[backend]={'failureCounts':dict(Counter(r['reason'] for r in failed)),'failures':failed,
            'sharedHubLexicalOnlyRecallAt5':lexical_hits/24,'sharedHubLexicalOnlyHitsAt5':lexical_hits,
            'cleanNegativeCount':len(negatives),'cleanNegativeFalseSelections':sum(bool(r['selectedIds']) for r in negatives),
            'cleanNegativeIid95UpperBoundIfZero':1-.05**(1/len(negatives)),
            'ambiguousCase':next(r for r in value['details'] if r['id']==ambiguous)}
        save(f'quote-review-input-{backend}.json',review)
    agreement={'questions':len(cases),'sameFusedTop20':0,'sameCandidatePayload':0,'sameSelectedIds':0,'differentQuestions':[]}
    for qid in cases:
        a,b=[by[(qid,arm)] for arm in arms]
        agreement['sameFusedTop20']+=a['retrieval']['fused']==b['retrieval']['fused']
        same=a['promptSha256']==b['promptSha256']
        agreement['sameCandidatePayload']+=same
        agreement['sameSelectedIds']+=a['checked']['ids']==b['checked']['ids']
        if not same:
            agreement['differentQuestions'].append(qid)
    processes=[]
    for root in [WORK,ROOT/'.local/hbm-00/parity-20261018']:
        for path in [root/'formal-server/exit.json',root/'preflight-server/exit.json',
                     root/'formal-index/bm/process.json',root/'preflight-index/bm/process.json']:
            if path.exists():
                identity=json.loads(path.read_text(encoding='utf-8'))
                identity['receiptPath']=str(path);identity['aliveWithSameIdentity']=alive(identity)
                processes.append(identity)
    assert not any(p['aliveWithSameIdentity'] for p in processes)
    # Scan only known, owned experimental output roots; never 814 production files,
    # the embedding cache, binary build caches, or unrelated previous experiments.
    auth=Path(os.environ.get('CODEX_HOME',str(Path.home()/'.codex')))/'auth.json'
    secret_values=json.loads(auth.read_text(encoding='utf-8')).get('tokens',{})
    needles=[v.encode() for k,v in secret_values.items() if k in ['access_token','refresh_token','id_token'] and isinstance(v,str) and len(v)>30]
    leaks=[]; sizes={}
    for root in [WORK,REPORTS,ROOT/'.local/hbm-00/parity-20261018',ROOT/'artifacts/hbm-00-parity-20261018']:
        size=count=0
        for path in root.rglob('*'):
            if not path.is_file():
                continue
            blob=path.read_bytes();size+=len(blob);count+=1
            if any(n in blob for n in needles):
                leaks.append(str(path))
        sizes[str(root)]={'bytes':size,'files':count}
    del secret_values,needles
    assert not leaks and not(HOME/'auth.json').exists()
    assert sum(s['bytes'] for s in sizes.values())<=300_000_000
    save('delivery-verification.json',{'createdAt':now(),'model':MODEL,'effort':EFFORT,
         'processes':processes,'credentialsPersisted':False,'authFileCopied':False,'ownedRoots':sizes,
         'sharedBuildCache':'Existing Cargo target plus content-addressed byte-identical native harness; compilation cache growth not separately measured, not charged to runtime-root budget.',
         'harness':read('native-harness.json'),'sourceFilesUnchanged':summary['sourceFilesUnchanged'],
         'canonicalBodiesUnchanged':True,'injectedScopeStateViolations':exposure_violations,
         'allActualCallsSolXhighToolFreeFreshHistory':True,'actualCallsIncludingPreflight':len(receipts),
         'frozenScoringChanged':False,'sameFamilyNotIndependentLabels':True,'labelCaveatRecordedBeforeFirstRetrieval':caveat['beforeFirstRetrieval'],
         'diagnoses':diagnoses,'agreement':agreement,'backendUndecided':True,'laterBatchesStarted':False,
         'auditMs':(time.perf_counter()-started)*1000})
    print(json.dumps({'diagnoses':{a:{k:v for k,v in d.items() if k not in ['ambiguousCase','failures']} for a,d in diagnoses.items()},
                      'agreement':agreement,'ownedMiB':sum(s['bytes'] for s in sizes.values())/1024**2,
                      'ownedProcessesStopped':True,'credentialsPersisted':False},ensure_ascii=False))
