"""Freeze operational driver identity before any runtime build/installation."""
from pathlib import Path
from qualification_contract import *

assert not (WORK/'rust-runtime').exists() and not (WORK/'bm-lifecycle').exists()
save('runtime-driver-contract.json',{'at':now(),
    'sources':{name:digest(Path(__file__).with_name(name)) for name in
        ['qualification_rust_runtime.py','qualification_bm_lifecycle.py']},
    'criteria':{name:digest(REPORTS/name) for name in
        ['backend-runtime-preparation-contract.json','bm-lifecycle-contract-v2.json','backend-operational-corpus.json']},
    'runOrder':['common quality producer exits','Rust build and five fresh process/parity probes',
                'Basic Memory managed runtime copy/installation','Basic Memory fresh process and lifecycle checks'],
    'noCompetingBenchmark':True,'frozenQualityMethodsChanged':False,
    'nativeScope':'Actual Rust embedding component; full native Hub memory persistence/reranker pipeline not claimed.',
    'bmScope':'Relocated installed environment and whole-note service operations; includes QA dependencies, not a minimal distributable installer.',
    'remaining':['Crash-boundary recovery','derived Hub-summary erasure','managed upgrade/rollback',
                 'real24h load/resource soak','complete native pipeline and equal-scope distribution comparison'],
    'backendSelected':False,'laterBatchesStarted':False})
print('Operational driver source identities frozen before runtime work.')
