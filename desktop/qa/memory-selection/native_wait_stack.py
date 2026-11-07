"""Bounded user-mode stack snapshot of an owned x64 thread; always resume it."""
import ctypes as C
from ctypes import wintypes as W
import struct
import time

K = C.WinDLL('kernel32', use_last_error=True)
D = C.WinDLL('dbghelp', use_last_error=True)
H = W.HANDLE
U64 = C.c_ulonglong
for name, args, result in [
    ('OpenProcess', [W.DWORD,W.BOOL,W.DWORD],H),
    ('OpenThread',[W.DWORD,W.BOOL,W.DWORD],H),
    ('SuspendThread',[H],W.DWORD),('ResumeThread',[H],W.DWORD),
    ('GetThreadContext',[H,C.c_void_p],W.BOOL),('CloseHandle',[H],W.BOOL)]:
    f=getattr(K,name);f.argtypes=args;f.restype=result
for name,args,result in [
    ('SymInitialize',[H,C.c_char_p,W.BOOL],W.BOOL),
    ('SymCleanup',[H],W.BOOL),('SymSetOptions',[W.DWORD],W.DWORD),
    ('SymFromAddr',[H,U64,C.POINTER(U64),C.c_void_p],W.BOOL),
    ('StackWalk64',[W.DWORD,H,H,C.c_void_p,C.c_void_p,C.c_void_p,C.c_void_p,C.c_void_p,C.c_void_p],W.BOOL)]:
    f=getattr(D,name);f.argtypes=args;f.restype=result

class Address(C.Structure):
    _fields_=[('Offset',U64),('Segment',W.WORD),('Mode',W.DWORD)]
class Frame(C.Structure):
    _fields_=[('pc',Address),('ret',Address),('frame',Address),('stack',Address),('store',Address),('rest',C.c_byte*512)]

class Reader:
    def __init__(self,pid,symbol_path):
        self.pid=pid;self.handle=K.OpenProcess(0x410,False,pid)
        if not self.handle:raise C.WinError(C.get_last_error())
        D.SymSetOptions(0x80000|0x200|0x4|0x2)
        if not D.SymInitialize(self.handle,str(symbol_path).encode(),True):
            K.CloseHandle(self.handle);raise C.WinError(C.get_last_error())
    def close(self):
        D.SymCleanup(self.handle);K.CloseHandle(self.handle)
    def sample(self,tid):
        row={'pid':self.pid,'tid':tid,'unixMs':time.time()*1000,'frames':[]}
        thread=K.OpenThread(0x0002|0x0008|0x0040,False,tid)
        if not thread:return dict(row,error=str(C.WinError(C.get_last_error())))
        raw=C.create_string_buffer(1232+16);address=(C.addressof(raw)+15)&~15
        C.c_uint32.from_address(address+48).value=0x100003
        suspended=False;addresses=[];began=time.perf_counter()
        try:
            if K.SuspendThread(thread)==0xffffffff:raise C.WinError(C.get_last_error())
            suspended=True
            if not K.GetThreadContext(thread,address):raise C.WinError(C.get_last_error())
            frame=Frame()
            for field,offset in [(frame.pc,248),(frame.frame,160),(frame.stack,152)]:
                field.Offset=U64.from_address(address+offset).value;field.Mode=3
            addresses.append(frame.pc.Offset)
            for _ in range(47):
                if not D.StackWalk64(0x8664,self.handle,thread,C.byref(frame),address,None,
                    C.cast(D.SymFunctionTableAccess64,C.c_void_p),C.cast(D.SymGetModuleBase64,C.c_void_p),None):break
                if not frame.pc.Offset or (len(addresses)>1 and frame.pc.Offset==addresses[-1]):break
                addresses.append(frame.pc.Offset)
                if time.perf_counter()-began>.1:break
        except BaseException as exc:row['error']=str(exc)
        finally:
            if suspended:row['resumeResult']=K.ResumeThread(thread)
            row['pauseMs']=(time.perf_counter()-began)*1000
            K.CloseHandle(thread)
        for pc in addresses:
            symbol=C.create_string_buffer(2048);struct.pack_into('<I',symbol,0,88);struct.pack_into('<I',symbol,80,1024)
            displacement=U64();found=D.SymFromAddr(self.handle,pc,C.byref(displacement),symbol)
            row['frames'].append({'address':hex(pc),'symbol':symbol.raw[84:].split(b'\0',1)[0].decode(errors='replace') if found else None,'offset':displacement.value if found else None})
        return row
