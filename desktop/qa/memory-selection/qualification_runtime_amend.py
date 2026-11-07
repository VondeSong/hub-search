"""Record a pre-model Windows launcher correction; do not alter any gate."""
from pathlib import Path
from qualification_contract import *

original=read('runtime-driver-contract.json')
assert digest(REPORTS/'rust-runtime-driver-v1-source.py')==original['sources']['qualification_rust_runtime.py']
assert not (REPORTS/'rust-runtime-probe.json').exists()
assert not list((WORK/'rust-runtime').glob('probe-*.stderr'))
save('rust-runtime-probe-preflight-failure.json',{'at':now(),
    'errorType':'KeyError','error':'SystemRoot','stage':'Copied Python environment dictionary lookup before probe process launch',
    'rustProcessLaunches':0,'modelCalls':0,'fix':'Use the Windows SYSTEMROOT environment key through os.environ instead of case-sensitive copied dict lookup.',
    'sourceBefore':original['sources']['qualification_rust_runtime.py'],
    'sourceAfter':digest(Path(__file__).with_name('qualification_rust_runtime.py')),
    'rustBinaryAndModelChanged':False,'gatesChanged':False})
save('runtime-driver-contract-v2.json',{**original,'at':now(),'supersedesSha256':digest(REPORTS/'runtime-driver-contract.json'),
    'sources':{**original['sources'],'qualification_rust_runtime.py':digest(Path(__file__).with_name('qualification_rust_runtime.py'))},
    'reason':'Preflight environment lookup only, before any Rust model run; original failure and driver retained.'})
print('Pre-model launcher correction recorded; gates and built binary unchanged.')
