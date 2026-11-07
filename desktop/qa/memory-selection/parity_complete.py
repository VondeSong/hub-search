"""Aggregate failed preparation and completed comparison without selecting a backend."""
import ast
from datetime import datetime
import json
from pathlib import Path
import psutil
from parity_support import *

def tree(path):
    module=ast.parse(path.read_text(encoding='utf-8-sig'))
    values={}
    for node in ast.walk(module):
        if isinstance(node,(ast.FunctionDef,ast.AsyncFunctionDef)):
            values[node.name]=ast.dump(node,include_attributes=False)
    return values

def stamp(value):return datetime.fromisoformat(value).timestamp()

if __name__=='__main__':
    previous=ROOT/'artifacts/hbm-00-parity-20261018b'
    old=json.loads((previous/'summary.json').read_text(encoding='utf-8'))
    current=read('summary.json');evaluation=read('evaluation.json');verification=read('delivery-verification.json')
    assert evaluation['status']=='completed' and len(evaluation['rows'])==248
    assert all(digest(REPORTS/name)==digest(previous/name) for name in ['corpus.json','validation.json'])
    earlier=tree(previous/'executed-sources/parity_index.py');later=tree(ROOT/'qa/memory-selection/parity_index.py')
    checked=['fuse','terms','split_body','vector_search','retrieve','native_input','native_lexical','prepare_native_vectors']
    unchanged={name:earlier.get(name)==later.get(name) for name in checked if name in earlier or name in later}
    assert all(unchanged.values())
    old_rust=(previous/'executed-sources/memory_selection_tests.rs').read_text(encoding='utf-8-sig')
    new_rust=(ROOT/'src-tauri/src/agent_work/memory_selection_tests.rs').read_text(encoding='utf-8-sig')
    suffix=lambda text:text.split('fn native_sqlite_tantivy_passage_parity()',1)[1].split('    f.index();',1)[1]
    assert suffix(old_rust)==suffix(new_rust)
    old_method=json.loads((previous/'method-contract.json').read_text(encoding='utf-8'))
    assert old_method['sources']['applicability_policy.py']==digest(ROOT/'qa/memory-selection/applicability_policy.py')
    assert digest(previous/'executed-sources/parity_report.py')==digest(ROOT/'qa/memory-selection/parity_report.py')
    state=ROOT/'.local/hbm-00/parity-20261018b/formal-index/bm'
    bm_exit=json.loads((state/'process.json').read_text(encoding='utf-8'))
    identities=[bm_exit,*read('backfill.json')['members']]
    for r in identities:
        try:
            p=psutil.Process(r['pid'])
            assert p.create_time()!=r['createTime'] or not p.is_running()
        except psutil.NoSuchProcess:pass
    assert bm_exit['residual']==[] and verification['canonicalBodiesUnchanged']
    roots={}
    for identity in ['parity-20261018','parity-20261018b','parity-20261018c']:
        for root in [ROOT/'.local/hbm-00'/identity,ROOT/'artifacts'/('hbm-00-'+identity)]:
            paths=[p for p in root.rglob('*') if p.is_file()]
            roots[str(root)]={'files':len(paths),'bytes':sum(p.stat().st_size for p in paths)}
    assert sum(r['bytes'] for r in roots.values())<=300_000_000
    # Primary remote model usage is already complete and contains the ONE reused
    # preflight. The failed B preparation had zero formal remote calls.
    cost={**current['cost'],'failedPreparationCost':old['cost'],'correctedBackfill':read('backfill.json'),
          'duplicateReusedPreflightChargedAgain':False,
          'fullElapsedFromFirstScopeMs':(stamp(now())-stamp(json.loads((ROOT/'artifacts/hbm-00-parity-20261018/scope-contract.json').read_text(encoding='utf-8'))['registeredAt']))*1000,
          'failedNativeControlTiming':'600s safety timeout; B recorded attempt wall upper bound includes subsequent audit. Do not claim687.852s was pure native execution.',
          'coldPreparationInterpretation':'Completed C comparison uses explicitly repaired/shared B derived state. No independent cold-start/latency gain claim; all B failures retained.',
          'localEmbeddingRequestAndTokenCount':'Not completely instrumented; unknown, not zero. Backfill/index wall and exact completed input manifests recorded.',
          'nativeBuilds':'Two targeted cached builds only,3m41s and5m12s compiler durations; wrapper receipts retained separately. No full test suite or release build.'}
    report={'at':now(),'status':'completed-comparison-backend-undecided','quality':current['quality'],
         'retrievalTailCoverage':current['tailCoverage'],'diagnostics':verification['diagnoses'],
         'agreement':verification['agreement'],'cleanNegativeCaveat':read('label-quality-caveat.json'),
         'preparationRepairs':{'oldSummarySha256':digest(previous/'summary.json'),
            'oldFormalModelCalls':0,'oldNativeQueries':0,'frozenDatasetBytesIdentical':True,
            'retrievalFunctionASTUnchanged':unchanged,'nativeIndexAndQuerySuffixUnchanged':True,
            'applicabilityPolicyAndFrozenScorerUnchanged':True,
            'changes':'Native setup transaction; CRLF/LF comparison; explicit missing-vector completion and common inputs independent of vector readiness.'},
         'cost':cost,'allOwnedProcessesStopped':True,'originalVaultUnchanged':current['sourceFilesUnchanged'],
         'allExperimentRoots':roots,'allOwnedLogicalMiB':sum(r['bytes'] for r in roots.values())/1024**2,
         'backendUndecided':True,'laterBatchesStarted':False,'latencyOptimization':False,
         'remainingGates':current['limitations']}
    save('complete-round.json',report)
    print(json.dumps({'status':report['status'],'quality':report['quality'],'agreement':report['agreement'],
                      'tailCoverage':{k:v for k,v in current['tailCoverage'].items() if k!='rows'},
                      'totalRemoteTokensIncludingWarmup':current['cost']['totalTokens'],
                      'oldFailuresIncluded':True,'backendUndecided':True},ensure_ascii=False))
