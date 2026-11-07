"""Diagnostic-only startup trace around the unchanged Basic Memory CLI module."""
import json
import os
import queue
import subprocess
import sys
import threading
import time

import psutil
import run as bm
from passage_support import WORK,save


class TracedMcp(bm.Mcp):
    def __init__(self,state):
        self.state=state
        self.sequence=0
        self.lines=queue.Queue()
        self.stderr=(state/'mcp.stderr.log').open('wb')
        code="import faulthandler,runpy,sys; faulthandler.dump_traceback_later(30,repeat=True); sys.argv=['basic_memory','mcp','--transport','stdio']; runpy.run_module('basic_memory.cli.main',run_name='__main__')"
        began=time.perf_counter()
        self.process=subprocess.Popen([sys.executable,'-c',code],cwd=bm.ROOT,
            env=bm.environment(state,'hybrid'),stdin=subprocess.PIPE,stdout=subprocess.PIPE,
            stderr=self.stderr,creationflags=subprocess.CREATE_NO_WINDOW if os.name=='nt' else 0)
        self.started_at=psutil.Process(self.process.pid).create_time()
        bm.save(state/'process.json',{'pid':self.process.pid,'createTime':self.started_at,'status':'starting'})
        threading.Thread(target=self._read,daemon=True).start()
        try:
            self.rpc('initialize',{'protocolVersion':'2025-06-18','capabilities':{},
                'clientInfo':{'name':'hub-hbm-startup-trace','version':'1'}},timeout=45)
            self.notify('notifications/initialized',{})
            self.catalog=self.rpc('tools/list',{},timeout=45)['tools']
        except BaseException:
            self.close()
            raise
        self.initialize_ms=(time.perf_counter()-began)*1000


if __name__=='__main__':
    state=WORK/'startup-trace'
    state.mkdir(parents=True,exist_ok=False)
    old=WORK/'development-index/bm'
    settings=json.loads((old/'config/config.json').read_text(encoding='utf-8'))
    bm.save(state/'config/config.json',settings)
    old_receipt=json.loads((old/'process.json').read_text(encoding='utf-8'))
    save('startup-failure.json',{'status':'initialize_timeout','timeoutSeconds':180,
                                 'developmentQuestionsExecuted':0,'validationQuestionsExecuted':0,
                                 'oldProcess':old_receipt})
    client=None
    began=time.perf_counter()
    receipt={'status':'starting','diagnosticOnly':True,'timeoutSeconds':45}
    try:
        client=TracedMcp(state)
        receipt.update({'status':'completed','initializeMs':client.initialize_ms})
    except BaseException as error:
        receipt.update({'status':'failed','errorType':type(error).__name__})
    finally:
        if client:
            client.close()
        receipt['elapsedMs']=(time.perf_counter()-began)*1000
        save('startup-trace.json',receipt)
    print(json.dumps(receipt))
