"""Bounded observation of an explicitly identified Windows process. Never controls it.

Requires the already-installed psutil. Private output omits lock names and window text.
WCT workers have a timeout; denial/unsupported waits are evidence gaps, not deadlocks.
"""
import argparse
import ctypes as ct
from ctypes import wintypes as wt
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import time


def wait_chain(tid):
    class Lock(ct.Structure):
        _fields_ = [("name", wt.WCHAR * 128), ("timeout", ct.c_int64), ("alertable", wt.BOOL)]

    class Thread(ct.Structure):
        _fields_ = [("pid", wt.DWORD), ("tid", wt.DWORD), ("waitMs", wt.DWORD), ("switches", wt.DWORD)]

    class Detail(ct.Union):
        _fields_ = [("lock", Lock), ("thread", Thread)]

    class Node(ct.Structure):
        _fields_ = [("kind", wt.DWORD), ("status", wt.DWORD), ("detail", Detail)]

    assert ct.sizeof(Node) == 280, "64-bit Windows SDK layout required"
    api = ct.WinDLL("advapi32", use_last_error=True)
    api.OpenThreadWaitChainSession.argtypes = [wt.DWORD, ct.c_void_p]
    api.OpenThreadWaitChainSession.restype = ct.c_void_p
    api.CloseThreadWaitChainSession.argtypes = [ct.c_void_p]
    api.GetThreadWaitChain.argtypes = [ct.c_void_p, ct.c_size_t, wt.DWORD, wt.DWORD,
                                     ct.POINTER(wt.DWORD), ct.POINTER(Node), ct.POINTER(wt.BOOL)]
    api.GetThreadWaitChain.restype = wt.BOOL
    handle = api.OpenThreadWaitChainSession(0, None)
    if not handle:
        return {"tid": tid, "error": ct.get_last_error(), "stage": "open"}
    try:
        count, cycle = wt.DWORD(16), wt.BOOL()
        nodes = (Node * 16)()
        ok = api.GetThreadWaitChain(handle, 0, 1, tid, ct.byref(count), nodes, ct.byref(cycle))
        if not ok:
            return {"tid": tid, "error": ct.get_last_error(), "stage": "query"}
        result = []
        for node in nodes[:min(count.value, 16)]:
            entry = {"kind": node.kind, "status": node.status}
            if node.kind == 8:
                entry.update({"pid": node.detail.thread.pid, "tid": node.detail.thread.tid,
                              "waitMs": node.detail.thread.waitMs, "switches": node.detail.thread.switches})
            result.append(entry)
        return {"tid": tid, "cycle": bool(cycle.value), "nodes": result}
    finally:
        api.CloseThreadWaitChainSession(handle)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pid", type=int)
    parser.add_argument("--exe", type=Path)
    parser.add_argument("--created", help="Expected process start in ISO 8601 including timezone")
    parser.add_argument("--sha256")
    parser.add_argument("--hwnd", type=int)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--wct-tid", type=int, help=argparse.SUPPRESS)
    args = parser.parse_args()
    if sys.platform != "win32":
        parser.error("Windows only")
    if args.wct_tid:
        print(json.dumps(wait_chain(args.wct_tid)))
        return
    if not all([args.pid, args.exe, args.created, args.sha256, args.hwnd, args.output]):
        parser.error("Explicit process, binary, start time, window and output identities are required")
    if args.output.exists():
        parser.error("Evidence already exists; choose a new output")
    import psutil
    expected_start = datetime.fromisoformat(args.created).timestamp()
    expected_exe = args.exe.resolve()

    def verify():
        # psutil caches create_time/exe on a Process object; use a fresh identity each time.
        p = psutil.Process(args.pid)
        assert abs(p.create_time() - expected_start) < 0.01, "PID identity changed"
        assert Path(p.exe()).resolve() == expected_exe, "Executable changed"
        assert hashlib.sha256(expected_exe.read_bytes()).hexdigest() == args.sha256, "Binary changed"
        return p

    verify()
    user = ct.WinDLL("user32", use_last_error=True)
    user.GetWindowThreadProcessId.argtypes = [wt.HWND, ct.POINTER(wt.DWORD)]
    user.GetWindowThreadProcessId.restype = wt.DWORD
    user.IsHungAppWindow.argtypes = [wt.HWND]
    user.IsHungAppWindow.restype = wt.BOOL
    owner = wt.DWORD()
    ui_tid = user.GetWindowThreadProcessId(wt.HWND(args.hwnd), ct.byref(owner))
    assert owner.value == args.pid and ui_tid, "Window no longer belongs to the selected process"
    result = {"format": "hub-windows-readonly-health-v1", "pid": args.pid,
              "created": args.created, "exeSha256": args.sha256, "uiThread": ui_tid,
              "startedAt": datetime.now(timezone.utc).isoformat(), "samples": [], "waitChains": []}
    for _ in range(3):
        p = verify()
        threads = p.threads()
        cpu = p.cpu_times()
        memory = p.memory_info()
        result["samples"].append({"monotonic": time.monotonic(), "cpuSeconds": cpu.user + cpu.system,
                                  "rss": memory.rss, "privateBytes": memory.private,
                                  "handles": p.num_handles(), "threads": len(threads),
                                  "hungWindow": bool(user.IsHungAppWindow(wt.HWND(args.hwnd))),
                                  "systemCpuPercent": psutil.cpu_percent(interval=1)})
        time.sleep(1)
    selected = [ui_tid] + [t.id for t in sorted(threads, key=lambda t: t.user_time + t.system_time, reverse=True) if t.id != ui_tid][:4]
    for tid in selected:
        verify()
        try:
            child = subprocess.run([sys.executable, str(Path(__file__).resolve()), "--wct-tid", str(tid)],
                                   capture_output=True, text=True, timeout=4,
                                   creationflags=subprocess.CREATE_NO_WINDOW)
            entry = json.loads(child.stdout) if child.returncode == 0 else {"tid": tid, "workerExit": child.returncode}
        except subprocess.TimeoutExpired:
            entry = {"tid": tid, "workerTimeoutSeconds": 4}
        result["waitChains"].append(entry)
    verify()
    first, last = result["samples"][0], result["samples"][-1]
    result["cpuCoresUsed"] = (last["cpuSeconds"] - first["cpuSeconds"]) / (last["monotonic"] - first["monotonic"])
    result["limits"] = "Read-only snapshot, no debug privileges; no-cycle/single-node chains do not rule out unsupported waits or deadlocks. No source-level cause established."
    with args.output.open("x", encoding="utf-8") as file:
        json.dump(result, file, ensure_ascii=False, indent=2)
    print(json.dumps({"samples": 3, "waitChains": len(selected), "hungWindow": last["hungWindow"],
                      "cpuCoresUsed": result["cpuCoresUsed"], "wctErrors": [r for r in result["waitChains"] if "nodes" not in r]}))


if __name__ == "__main__":
    main()
