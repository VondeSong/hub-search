"""Trace only source line numbers of the unchanged postprocessor, no model calls."""
import runpy
import sys
import time
from pathlib import Path

root=Path(__file__).resolve().parent
log=(root.parents[1]/'.local/hbm-00/accounting-20261018/report-source-lines.log').open('x',encoding='utf-8')
def trace(frame,event,arg):
    path=Path(frame.f_code.co_filename)
    if event=='line' and path.parent==root:
        log.write(f'{time.time_ns()} {path.name}:{frame.f_lineno}\n');log.flush()
    return trace
sys.settrace(trace)
try: runpy.run_path(str(root/'accounting_report.py'),run_name='__main__')
finally:
    sys.settrace(None);log.close()
