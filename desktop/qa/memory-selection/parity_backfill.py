"""Bounded derived-index repair; no query, source, model-policy or score changes."""
import json
import os
import subprocess
import sys
import time
from parity_support import *
import run as bm

if __name__=='__main__':
    state=WORK/'formal-index/bm'
    save('embedding-backfill-contract.json',{'at':now(),'repair':'Installed BM reindex --embeddings --project notes',
        'cause':'Checkpointed source entities survive cancellation; unchanged files do not reschedule lost embedding jobs. Missing1600 entities were created before interruption;438 new entities plus143 other-project entities have vectors.',
        'beforeAnyValidationQuery':not(WORK/'formal-index/formal-native-input.json').exists(),
        'sourceOrQueryOrScoreChanged':False,'modelCalls':0,'timeoutSeconds':240,'executionsMax':1,
        'sameModelWeightsAndConfig':True,'newStartupRetry':False,'purpose':'Repair missing derived records, not latency optimization.',
        'driverSha256':digest(Path(__file__))})
    env=bm.environment(state,'hybrid');env.update({'TEMP':str(WORK/'tmp'),'TMP':str(WORK/'tmp')})
    began=time.perf_counter()
    with (WORK/'embedding-backfill.log').open('xb') as log:
        p=subprocess.Popen([sys.executable,'-m','basic_memory.cli.main','reindex','--embeddings','--project','notes'],
            cwd=ROOT,env=env,stdout=log,stderr=subprocess.STDOUT,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
        try:
            code=p.wait(timeout=240)
        except BaseException:
            p.terminate();p.wait(timeout=10)
            raise
        finally:
            save('embedding-backfill.json',{'finishedAt':now(),'pid':p.pid,'exitCode':p.returncode,
                'wallMs':(time.perf_counter()-began)*1000,'logSha256':digest(WORK/'embedding-backfill.log'),'modelCalls':0})
    assert code==0
    print('Missing-vector backfill completed without holdout queries.')
