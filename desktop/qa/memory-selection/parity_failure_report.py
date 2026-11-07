"""Close a bounded initialization failure without inventing quality measurements."""
from datetime import datetime
import json
import os
import sqlite3
import statistics
import time
from pathlib import Path
import psutil
from parity_support import *
from parity_evaluate import source_hashes

def running(identity):
    try:
        p=psutil.Process(identity['pid'])
        return p.is_running() and abs(p.create_time()-identity['createTime'])<.001
    except psutil.NoSuchProcess:
        return False

def stamp(value):
    return datetime.fromisoformat(value).timestamp()

if __name__=='__main__':
    first,second=read('evaluation.json'),read('evaluation-resumed.json')
    assert all(e['status']=='failed' and not e['rows'] and not e['modelCalls'] for e in [first,second])
    assert read('method-contract.json')['sources']==source_hashes()
    frozen=read('validation-contract.json')
    assert frozen['corpusSha256']==digest(REPORTS/'corpus.json')
    assert frozen['validationSha256']==digest(REPORTS/'validation.json')
    if (REPORTS/'native-lexical-control.json').exists():
        control=read('native-lexical-control.json')
    else:
        failure=read('native-preparation-failure.json')
        control={'status':'setup-timeout','at':failure['at'],'recallAt5':None,'hitAt5':None,'recallAt20':None,'hitAt20':None,'rows':[],
                 'fullNativeReceipt':{'wallMs':(stamp(failure['at'])-stamp(failure['nativeControlStart']))*1000,
                                     'timingMeaning':'Attempt wall upper bound including subsequent failure audit; actual harness safety timeout600s.',
                                     'preservedFixtures':failure['fixtures']},'queryPhaseNotReached':failure['queryPhaseNotReached']}
    pref=read('preflight.json');backfill=read('embedding-backfill.json')
    manifest=json.loads((WORK/'formal-index/passages.json').read_text(encoding='utf-8'))
    assert all(digest(f['path'])==f['sha256'] for f in manifest['files'].values())
    con=sqlite3.connect((WORK/'formal-index/bm/config/memory.db').resolve().as_uri()+'?mode=ro',uri=True)
    ready={r[0] for r in con.execute("SELECT e.permalink FROM entity e JOIN search_vector_chunks c ON c.entity_id=e.id GROUP BY e.id HAVING min(c.embedding_status='ready')=1")}
    snippet_rows=con.execute("SELECT e.permalink,s.content_snippet FROM entity e JOIN search_index s ON s.entity_id=e.id AND s.type='entity'").fetchall()
    mismatches=[pid for pid,text in snippet_rows if pid not in manifest['passages'] or text.strip()!=manifest['passages'][pid]['text'].strip()]
    cohorts=con.execute("SELECT CASE WHEN created_at<'2026-10-18 17:56:45.221374' THEN 'before-resume' ELSE 'after-resume' END,count(*),sum(not exists(SELECT 1 FROM search_vector_chunks v WHERE v.entity_id=e.id AND v.embedding_status='ready')) FROM entity e WHERE project_id=1 GROUP BY 1").fetchall()
    pending=con.execute("SELECT count(*) FROM search_vector_chunks WHERE embedding_status!='ready'").fetchone()[0]
    con.close()
    missing=set(manifest['passages'])-ready
    identities=[]
    for root in [WORK,ROOT/'.local/hbm-00/parity-20261018']:
        for relative in ['formal-index/bm/process.json','preflight-index/bm/process.json','preflight-server/exit.json']:
            path=root/relative
            if path.exists():
                identities.append(json.loads(path.read_text(encoding='utf-8')))
    identities.append(read('preparation-resume-contract.json')['priorBmExitReceipt'])
    identities+=read('backfill-owned-processes.json')['members']
    live=[r for r in identities if running(r)]
    assert not live, 'Owned process still alive; close before delivery'
    source_unchanged=all(digest(s['path'])==s['sha256'] and digest(s['snapshot'])==s['sha256'] for s in read('real-notes.json')['sources'])
    secrets=json.loads((Path(os.environ.get('CODEX_HOME',str(Path.home()/'.codex')))/'auth.json').read_text(encoding='utf-8')).get('tokens',{})
    needles=[v.encode() for k,v in secrets.items() if k in ['access_token','refresh_token','id_token'] and isinstance(v,str) and len(v)>30]
    sizes={};leaks=[]
    for root in [WORK,REPORTS,ROOT/'.local/hbm-00/parity-20261018',ROOT/'artifacts/hbm-00-parity-20261018']:
        total=count=0
        for path in root.rglob('*'):
            if path.is_file():
                blob=path.read_bytes();total+=len(blob);count+=1
                if any(n in blob for n in needles):leaks.append(str(path))
        sizes[str(root)]={'bytes':total,'files':count}
    del secrets,needles
    assert not leaks and not (HOME/'auth.json').exists()
    assert sum(v['bytes'] for v in sizes.values())<=300_000_000
    if control['status']=='completed':
        assert not Path(control['fullNativeReceipt']['fixtureRoot']).exists()
    ledger=pref['ledger']
    intervals=[(stamp(e['startedAt']),stamp(e['finishedAt'])) for e in [first,second]]
    intervals.append((stamp(pref['startedAt']),stamp(pref['startedAt'])+pref['wallMs']/1000))
    intervals.append((stamp(read('embedding-backfill-contract.json')['at']),stamp(backfill['finishedAt'])))
    intervals.append((stamp(read('native-control-start.json')['at']),stamp(control['at'])))
    merged=[]
    for start,end in sorted(intervals):
        if merged and start<=merged[-1][1]:merged[-1][1]=max(merged[-1][1],end)
        else:merged.append([start,end])
    cost={k:ledger[k] for k in ['responseRequests','prewarmRequests','unusedFinalPrewarmRequests','totalInputTokens','totalOutputTokens','totalTokens','cachedInputTokens','allNetworkRequestCount']}
    cost.update({'preflightModelTurns':2,'formalModelTurns':0,'firstFailedPrepareWallMs':first['totalMs'],
        'resumedFailedPrepareWallMs':second['totalMs'],'backfillWallMs':backfill['wallMs'],
        'nativeControlWallMs':control['fullNativeReceipt']['wallMs'],
        'jobWallMsSum':sum((end-start)*1000 for start,end in intervals),
        'jobWallMsUnion':sum((end-start)*1000 for start,end in merged),
        'overlapNotDoubleCounted':True,'fullElapsedFromFirstScopeMs':(time.time()-stamp(json.loads((ROOT/'artifacts/hbm-00-parity-20261018/scope-contract.json').read_text(encoding='utf-8'))['registeredAt']))*1000,
        'primaryAuthoringAndOrchestrationTokens':'Unobservable, not zero; processed tokens are not an invoice.',
        'nativeEventClock':'Inherited complete preflight native-event ledger; no formal remote inference took place.'})
    ranks=[r['bestGoldRank'] for r in control['rows'] if r['positive']]
    runtime_sources=[ROOT/'.local/hbm-00/runtime/Lib/site-packages/basic_memory/indexing/models.py',
                     ROOT/'.local/hbm-00/runtime/Lib/site-packages/basic_memory/cli/commands/db.py']
    summary={'createdAt':now(),'status':'primary-comparison-not-completed','backendUndecided':True,'laterBatchesStarted':False,
        'latencyOptimization':False,'formalModelCalls':0,'formalPrimaryQueries':0,'qualityGates':'NOT EVALUATED, not zero errors or0% recall.',
        'dataset':{'realNotes':56,'eligibleNotes':48,'authorityControls':8,'passages':2181,'positive':24,'negativeFrozen':100,
            'cleanNegative':99,'labelAmbiguity':read('label-quality-caveat.json'),'supportAfter1024':frozen['supportAfter1024'],
            'newQuestionTuning':False,'sameFamilyNotIndependentAnnotation':True},
        'nativeLexicalControl':{'recallAt5':control['recallAt5'],'hitAt5':control['hitAt5'],'recallAt20':control['recallAt20'],
            'hitAt20':control['hitAt20'],'positive':24,'goldRanks':ranks,
            'goldRankBeyond1OrMissing':sum(r is None or r>1 for r in ranks),
            'goldRankBeyond5OrMissing':sum(r is None or r>5 for r in ranks),
            'status':control['status'],'scope':'Production Hub SQLite/Tantivy/EvidenceReader lexical ONLY; no hybrid or applicability/no-answer result.'},
        'indexState':{'expectedPassageEntities':2181,'entityRows':len(snippet_rows),'readyPassageEntities':len(set(manifest['passages'])&ready),
            'missingPassageEntities':len(missing),'pendingChunkRows':pending,'sourceSnippetMismatches':mismatches,
            'cohortsAfterBoundedBackfill':cohorts},
        'findings':['First900s preparation ended before all vector jobs completed. A single900s checkpoint restart indexed438 new entities but did not recreate missing vectors for1600 unchanged old entities.',
            'Installed official reindex --embeddings --project notes began filling old missing vectors; bounded240s repair also expired, with no repeated holdout queries or generative calls.',
            'The experimental driver gates native vector preparation on BM readiness. Thus native primary availability is NOT established by this failure; this coupling must be removed before the next full comparison.',
            'The per-passage-as-note adapter multiplies entities; these setup costs do NOT establish standalone BM full-note indexing cost or its overall suitability.'],
        'evidenceSourceHashes':{str(p.relative_to(ROOT)):digest(p) for p in runtime_sources},
        'cost':cost,'sourceFilesUnchanged':source_unchanged,'canonicalBodiesUnchanged':True,
        'ownedProcessesStopped':True,'credentialsPersisted':False,'ownedRoots':sizes,
        'stop':'No further startup/backfill retries this round. Frozen dataset and raw failures preserved. Full hybrid/application comparison remains open; no backend choice or later batch.',
        'remaining':'Prepare complete common inputs independently of either competitor; use supported explicit vector completion/recovery. Keep frozen question bytes/policy/scorer unchanged, consume existing native lexical receipt, then run each primary arm once. Backend selection still also requires lifecycle/task effects/Windows/24h/license gates.'}
    save('summary.json',summary)
    save('delivery-verification.json',{'at':now(),'status':summary['status'],'originalAndCanonicalSourcesUnchanged':source_unchanged,
        'methodAndValidationHashesUnchanged':True,'observedProcesses':identities,'residual':live,'credentialsPersisted':False,
        'noFormalQualityClaim':True,'nativeControlCompleted':control['status']=='completed','sourceSnippetMismatches':mismatches,'ownedRoots':sizes})
    print(json.dumps({k:summary[k] for k in ['status','nativeLexicalControl','indexState','cost','ownedProcessesStopped']},ensure_ascii=False))
