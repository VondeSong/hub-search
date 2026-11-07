"""Bounded Windows IP Helper observer: owned PID only, no DNS or payload capture."""
import ctypes as C
import hashlib
import ipaddress
import json
import os
import socket
import struct
import threading
import time
from accounting_support import WORK,save

class Row4(C.Structure):
    _fields_=[(n,C.c_uint32) for n in ['state','localAddr','localPort','remoteAddr','remotePort','pid']]
class Row6(C.Structure):
    _fields_=[('localAddr',C.c_ubyte*16),('localScope',C.c_uint32),('localPort',C.c_uint32),
              ('remoteAddr',C.c_ubyte*16),('remoteScope',C.c_uint32),('remotePort',C.c_uint32),
              ('state',C.c_uint32),('pid',C.c_uint32)]

api=C.WinDLL('iphlpapi.dll').GetExtendedTcpTable
api.argtypes=[C.c_void_p,C.POINTER(C.c_uint32),C.c_int,C.c_uint32,C.c_int,C.c_uint32]
api.restype=C.c_uint32

def snapshot(pid):
    found=[]
    for family,row_type in [(socket.AF_INET,Row4),(socket.AF_INET6,Row6)]:
        size=C.c_uint32(0)
        status=api(None,C.byref(size),False,family,5,0)
        if status not in [0,122]:
            raise OSError(status,'TCP table sizing failed')
        blob=C.create_string_buffer(size.value)
        status=api(blob,C.byref(size),False,family,5,0)
        if status:
            raise OSError(status,'TCP table query failed')
        count=C.c_uint32.from_buffer(blob).value
        for i in range(count):
            row=row_type.from_buffer(blob,4+i*C.sizeof(row_type))
            if row.pid!=pid or row.state not in [3,4,5,8]:
                continue
            packed=struct.pack('<I',row.remoteAddr) if family==socket.AF_INET else bytes(row.remoteAddr)
            remote=socket.inet_ntop(family,packed)
            port=socket.ntohs(row.remotePort&0xffff)
            local_port=socket.ntohs(row.localPort&0xffff)
            found.append({'family':int(family),'state':row.state,'localPort':local_port,'remotePort':port,
                'remoteHash':hashlib.sha256((remote+':'+str(port)).encode()).hexdigest()[:16],
                'remoteLoopback':ipaddress.ip_address(remote).is_loopback,
                'socketIdentity':hashlib.sha256(f'{pid}/{family}/{local_port}/{remote}/{port}'.encode()).hexdigest()[:16]})
    return sorted(found,key=lambda r:r['socketIdentity'])

class Sampler:
    def __init__(self,pid):
        self.pid=pid; self.stop=threading.Event(); self.rows=[]; self.error=None
        def sample():
            while not self.stop.is_set():
                start=time.perf_counter()
                try:
                    rows=snapshot(pid)
                except Exception as error:
                    self.error=type(error).__name__; return
                self.rows.append({'unixNs':time.time_ns(),'durationMs':(time.perf_counter()-start)*1000,'sockets':rows})
                self.stop.wait(.2)
        self.thread=threading.Thread(target=sample,daemon=True); self.thread.start()
    def close(self):
        self.stop.set(); self.thread.join(timeout=2)
        return {'samples':self.rows,'error':self.error,'observerExited':not self.thread.is_alive(),
                'maxSampleMs':max((r['durationMs'] for r in self.rows),default=None),
                'privacy':'Only owned PID entries; no remote addresses, TLS contents or other process connections stored.'}

if __name__=='__main__':
    began=time.perf_counter(); counts=[]; times=[]
    for _ in range(5):
        tick=time.perf_counter(); counts.append(len(snapshot(os.getpid()))); times.append((time.perf_counter()-tick)*1000)
    save('tcp-observer-preflight.json',{'queries':5,'maxSampleMs':max(times),'totalMs':(time.perf_counter()-began)*1000,
         'source':'Windows GetExtendedTcpTable for IPv4/IPv6 owner PID; no psutil connection enumeration.',
         'sourceUrl':'https://learn.microsoft.com/en-us/windows/win32/api/iphlpapi/nf-iphlpapi-getextendedtcptable'})
    assert max(times)<100
    print(json.dumps({'queries':5,'maxMs':max(times)}))
