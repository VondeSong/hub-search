"""New soak identity; reuse the frozen workload with the verified repaired binary."""
import native_soak as soak
from native_recovery import *

REPORT=ROOT/'artifacts/hbm-00-native-soak-v2-20261019'
STATE=AREA/'soak-v2'
FIX=ROOT/'artifacts/hbm-00-native-commit-recovery-20261019'

def verify():
    delivery=read(FIX/'delivery.json');result=read(FIX/'result.json')
    assert delivery['testsPassed']==7 and result['passed'] and not result['residual']
    amendment=read(FIX/'method-amendment.json')
    assert all(digest(ROOT/p)==h for p,h in amendment['sources'].items())
    receipt=read(FIX/'native-harness-v2.json')
    assert digest(receipt['executable'])==receipt['binarySha256']==delivery['binarySha256']
    assert digest(receipt['executable']+'.manifest')==receipt['manifestSha256']
    return receipt

def register():
    receipt=verify()
    assert read(OUT/'soak-result.json')['status']=='failed'
    assert not REPORT.exists() and not STATE.exists()
    REPORT.mkdir();STATE.mkdir()
    contract=read(OUT/'soak-contract.json')
    contract.update(at=now(),recoverySha256=digest(FIX/'result.json'),wrapperSha256=digest(__file__),
      priorFailedResultSha256=digest(OUT/'soak-result.json'),priorContractSha256=digest(OUT/'soak-contract.json'),
      binarySha256=receipt['binarySha256'],productionSources=read(FIX/'method-amendment.json')['sources'],
      seedFiles={str(p.relative_to(AREA/'seed')):digest(p) for p in (AREA/'seed').rglob('*') if p.is_file()},
      reason='User continued after verified production commit recovery. New full86400seconds; old60samples not reused.',
      recoveryReporting='A repaired index may recover once per failed generation; report retired generation last_error/recovery attempts separately. Recovery still counts against unchanged5s/10s gates. Do not call successful automatic recovery absence of errors.')
    save(REPORT/'soak-contract.json',contract)
    save(REPORT/'native-harness-v2.json',receipt)
    print('New identity registered; unchanged workload, cadence and gates.')

def run():
    verify();contract=read(REPORT/'soak-contract.json')
    assert digest(__file__)==contract['wrapperSha256']
    assert contract['seedFiles']=={str(p.relative_to(AREA/'seed')):digest(p) for p in (AREA/'seed').rglob('*') if p.is_file()}
    soak.OUT=REPORT;soak.SOAK=STATE;soak.PROGRESS=REPORT/'soak-progress.json'
    native.REPORTS=REPORT
    soak.exercise()

if __name__=='__main__':
    import sys
    register() if sys.argv[1]=='register' else run()
