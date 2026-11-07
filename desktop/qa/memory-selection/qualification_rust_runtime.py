"""Owned Rust embedding runtime gate; never substitutes the Python fixture.

Build/probe only after the common quality producer has closed. No Hub files,
global Cargo configuration, original model files or production data are changed.
"""
import argparse
import json
import os
import queue
import shutil
import subprocess
import threading
import time
from pathlib import Path

import psutil
from qualification_contract import ROOT, WORK, REPORTS, OLD, digest, read, save, now

AREA = WORK / 'rust-runtime'
SOURCE = ROOT / 'qa/memory-selection/native-runtime'
FLAGS = getattr(subprocess, 'CREATE_NO_WINDOW', 0)


def ensure_quality_closed():
    result = read('evaluation.json')
    assert result.get('finishedAt'), 'Common acceptance has not closed'
    process = json.loads((WORK/'new-quality-server/process.json').read_text(encoding='utf-8'))
    pid = process.get('pid')
    if pid and psutil.pid_exists(pid):
        p = psutil.Process(pid)
        assert abs(p.create_time()-process.get('createTime', -1)) > 1, 'Quality producer still alive'
    for p in psutil.process_iter(['pid', 'cmdline']):
        args = p.info['cmdline'] or []
        assert not (any(str(a).replace('\\', '/').endswith('qualification_run.py') for a in args)
                    and 'evaluate' in args), 'Quality runner still active'


def stop_owned(p):
    if p.poll() is not None:
        return
    children = psutil.Process(p.pid).children(recursive=True)
    for child in reversed(children):
        try: child.terminate()
        except psutil.NoSuchProcess: pass
    p.terminate()
    _, alive = psutil.wait_procs(children, timeout=5)
    for child in alive:
        try: child.kill()
        except psutil.NoSuchProcess: pass
    try: p.wait(timeout=5)
    except subprocess.TimeoutExpired: p.kill(); p.wait(timeout=5)


def build():
    ensure_quality_closed()
    assert shutil.disk_usage(WORK).free >= 10*1024**3
    AREA.mkdir(exist_ok=False)
    for name in ['cargo-home', 'target', 'tmp', 'bundle']:
        (AREA/name).mkdir()
    contract = read('backend-runtime-preparation-contract.json')
    assert all(digest(ROOT/rel)==sha for rel,sha in contract['rustProbeSources'].items())
    env = os.environ.copy()
    env.update(CARGO_HOME=str(AREA/'cargo-home'), CARGO_TARGET_DIR=str(AREA/'target'),
               CARGO_BUILD_JOBS='1', TEMP=str(AREA/'tmp'), TMP=str(AREA/'tmp'))
    cargo = shutil.which('cargo')
    assert cargo
    manifest = str(SOURCE/'Cargo.toml')
    begun = time.perf_counter()
    commands = [[cargo, 'generate-lockfile', '--manifest-path', manifest],
                [cargo, 'build', '--release', '--locked', '--manifest-path', manifest]]
    result = {'at':now(), 'status':'running', 'commands':[], 'sources':contract['rustProbeSources']}
    try:
        for i, command in enumerate(commands, 1):
            with (AREA/f'build-{i}.log').open('xb') as log:
                p = subprocess.Popen(command,cwd=SOURCE,env=env,stdout=log,stderr=subprocess.STDOUT,creationflags=FLAGS)
                try: code = p.wait(timeout=max(1,900-(time.perf_counter()-begun)))
                finally: stop_owned(p)
            result['commands'].append({'command':command, 'exitCode':code})
            assert code==0, f'Rust build stage {i} failed; original log retained'
        executable = AREA/'target/release/hbm00-native-runtime-probe.exe'
        assert executable.is_file()
        inventory = read('backend-dependency-inventory.json')
        sources = [executable]+[Path(d['path']) for d in inventory['onnxDlls']+inventory['embeddingAssets']]
        result['bundle'] = []
        for source in sources:
            target = AREA/'bundle'/source.name
            shutil.copy2(source,target)
            assert digest(target)==digest(source)
            result['bundle'].append({'name':source.name,'bytes':target.stat().st_size,'sha256':digest(target)})
        result.update(status='completed', lockSha256=digest(SOURCE/'Cargo.lock'),
                      logicalBundleBytes=sum(f['bytes'] for f in result['bundle']))
        shutil.copy2(SOURCE/'Cargo.lock',AREA/'Cargo.lock')
    except BaseException as error:
        result.update(status='failed',errorType=type(error).__name__,error=str(error)[:500])
        raise
    finally:
        result['wallMs']=(time.perf_counter()-begun)*1000
        save('rust-runtime-build.json',result)


def stream_lines(stream, out):
    try:
        for line in stream:
            out.put(line)
    finally: out.put(None)


def probe():
    ensure_quality_closed()
    assert read('rust-runtime-build.json')['status']=='completed'
    cases={q['id']:q for q in read('validation.json',OLD)['cases']}
    texts=[cases[qid]['query'] for qid in read('scope-contract.json')['profile']['sameInputIds']]
    bundle=AREA/'bundle';env=os.environ.copy()
    env.update(PATH=str(bundle)+os.pathsep+os.path.join(os.environ['SYSTEMROOT'],'System32'),
               ORT_DYLIB_PATH=str(bundle/'onnxruntime.dll'), TEMP=str(AREA/'tmp'),TMP=str(AREA/'tmp'))
    # No Python runtime is on the probe's PATH. The driver remains Python.
    runs=[];vectors=None
    result={'at':now(),'status':'running','runs':runs,'inputSource':'20 retired profile questions',
            'inputSha256':digest(REPORTS/'scope-contract.json'),'scope':'Rust embedding runtime only',
            'exactShippingBackend':False,'operatingSystemCacheFlushed':False}
    try:
        for number in range(1,6):
            start=time.perf_counter();q=queue.Queue()
            with (AREA/f'probe-{number}.stderr').open('xb') as err:
                p=subprocess.Popen([str(bundle/'hbm00-native-runtime-probe.exe'),str(bundle)],cwd=bundle,env=env,
                    stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=err,text=True,encoding='utf-8',creationflags=FLAGS)
                t=threading.Thread(target=stream_lines,args=(p.stdout,q),daemon=True);t.start()
                try:
                    ready=json.loads(q.get(timeout=30) or 'null')
                    assert ready and ready.get('event')=='ready', 'No actual Rust ready event'
                    p.stdin.write(json.dumps({'id':'first','texts':[texts[0]]},ensure_ascii=False)+'\n');p.stdin.flush()
                    first=json.loads(q.get(timeout=30) or 'null')
                    assert first and first.get('id')=='first'
                    first_ms=(time.perf_counter()-start)*1000
                    native=psutil.Process(p.pid)
                    modules=[m.path for m in native.memory_maps() if m.path.lower().endswith('.dll')]
                    assert any(Path(m).resolve()==(bundle/'onnxruntime.dll').resolve() for m in modules)
                    assert not any('python3' in Path(m).name.lower() for m in modules)
                    item={'number':number,'pid':p.pid,'createTime':native.create_time(), 'ready':ready,
                          'firstUsableMs':first_ms,'rssBytes':native.memory_info().rss,'loadedDlls':modules}
                    if number==1:
                        p.stdin.write(json.dumps({'id':'parity','texts':texts},ensure_ascii=False)+'\n');p.stdin.flush()
                        output=json.loads(q.get(timeout=60) or 'null')
                        assert output and output['id']=='parity'
                        vectors=output['vectors']
                        (AREA/'rust-vectors.json').write_text(json.dumps(output),encoding='utf-8')
                    p.stdin.close();exit_code=p.wait(timeout=15);t.join(timeout=2)
                    item.update(exitCode=exit_code,closed=exit_code==0)
                    runs.append(item)
                    assert exit_code==0
                finally:
                    stop_owned(p);p.stdout.close()
            print(json.dumps({'rustFreshProcess':number,'firstUsableMs':first_ms}),flush=True)
        from fastembed import TextEmbedding
        import numpy as np
        model=TextEmbedding(model_name='BAAI/bge-small-zh-v1.5',threads=2,
            cache_dir=str(ROOT/'.local/hbm-00/cache/models'),local_files_only=True,enable_cpu_mem_arena=False)
        expected=np.array(list(model.embed(texts,batch_size=64)),dtype=np.float32)
        actual=np.array(vectors,dtype=np.float32)
        assert actual.shape==expected.shape==(20,512) and np.isfinite(actual).all()
        delta=float(np.max(np.abs(actual-expected)))
        result.update(status='completed',maxAbsoluteComponentDelta=delta,parityPassed=delta<=1e-5,
                      startupPassed=all(r['firstUsableMs']<=10000 for r in runs),runtimePythonSubstituted=False)
    except BaseException as error:
        result.update(status='failed',errorType=type(error).__name__,error=str(error)[:500]);raise
    finally: save('rust-runtime-probe.json',result)


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('phase',choices=['build','probe'])
    {'build':build,'probe':probe}[parser.parse_args().phase]()
