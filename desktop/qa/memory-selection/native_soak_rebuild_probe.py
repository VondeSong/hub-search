"""One controlled derived-index recovery on a second copy; keep failed index."""
from native_soak_failure_probe import *

def main():
    source=AREA/'soak/state';target=AREA/'failure-rebuild-20261019'
    save(REPORT/'rebuild-contract.json',{'at':now(),'sourceSha256':digest(__file__),'scope':'Second closed copy only; archive active derived index directory, let existing runtime rebuild from SQLite; no production repair or original changes',
      'reason':'Unmodified restart reproduced FileAlreadyExists delete-file failure','replays':10,'startupMs':10000,'postAckMs':5000,'budgetSeconds':180})
    before=read(REPORT/'source-manifest.json')
    shutil.copytree(source,target)
    with sqlite3.connect((target/'craft-search.sqlite3').resolve().as_uri()+'?mode=ro',uri=True) as db:
        relative=db.execute("SELECT relative_path FROM search_index_generations WHERE status='active'").fetchone()[0]
    active=(target/'tantivy-generations-v1'/relative).resolve();archive=(target/'preserved-failed-index').resolve()
    assert active.is_relative_to(target.resolve()) and archive.is_relative_to(target.resolve()) and active.is_dir() and not archive.exists()
    active.rename(archive)
    expected={r['id']:r['content'] for r in corpus()}
    for cycle in range(61):expected[f'hbm-op-{cycle%20:03}']=body(cycle%20,cycle+1)
    result={'at':now(),'checks':[],'manualDerivedIndexArchive':True};client=None;began=time.perf_counter()
    try:
        client=start(target);result['firstQueryFound']=lookup(client,'hbm-op-000',expected['hbm-op-000'],revision=61)
        result['restartMs']=(time.perf_counter()-began)*1000
        result['wholeStateMatches']=matches(client.snapshot(),expected)
        for n in range(10):
            assert time.perf_counter()-began<180
            row=write_checked(client,'hbm-op-000',expected['hbm-op-000'],expected,61);result['checks'].append(row)
            print(json.dumps({'replay':n,'passed':row['passed'],'postAckMs':row['queryAfterAckMs']}),flush=True)
            if not row['passed']:break
        result.update(status='completed',passed=result['firstQueryFound'] and result['wholeStateMatches'] and result['restartMs']<=10000 and len(result['checks'])==10 and all(x['passed'] for x in result['checks']))
    except BaseException as e:result.update(status='failed',passed=False,error=str(e))
    finally:
        result['residual']=client.close() if client else []
        result['originalUnchanged']=before=={str(p.relative_to(source)):digest(p) for p in source.rglob('*') if p.is_file()}
        result['wallMs']=(time.perf_counter()-began)*1000
        if result['residual'] or not result['originalUnchanged']:result['passed']=False
        save(REPORT/'rebuild-result.json',result)
    print(json.dumps({k:result.get(k) for k in ['status','passed','restartMs','wholeStateMatches','originalUnchanged','residual']}))

if __name__=='__main__':main()
