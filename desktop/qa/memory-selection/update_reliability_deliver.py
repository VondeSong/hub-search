"""Close the bounded diagnosis; preserve old scores and failed attempts."""
import statistics,psutil
from update_reliability import *
from qualification_bm_lifecycle import inspect

def main():
    names=['update-reliability-20261019','update-reliability-minimal-20261019','update-reliability-fix-20261019']
    arms={};residual=[]
    for name in names:
        out=ROOT/'artifacts'/('hbm-00-'+name)
        state=ROOT/'.local/hbm-00'/name/'replay'
        r=read(out/'replay.json');assert r['status'] in ['failed','completed'] and not r['residual']
        d=inspect(state);last=r['updates'][-1]['id']
        p=read(state/'process.json')
        for m in p.get('owned',[]):
            try:
                process=psutil.Process(m['pid'])
                if abs(process.create_time()-m['createTime'])<.01:residual.append(m['pid'])
            except psutil.NoSuchProcess:pass
        contract=read(out/'contract.json')
        source={'update-reliability-20261019':'update_reliability.py','update-reliability-minimal-20261019':'update_reliability_minimal.py','update-reliability-fix-20261019':'update_reliability_fix.py'}[name]
        assert digest(Path(__file__).with_name(source))==contract['sourceSha256']
        assert all(digest(Path(__file__).with_name(n))==h for n,h in contract['dependencies'].items())
        arms[name]={'status':r['status'],'attempted':len(r['updates']),'completed':sum('passed' in x for x in r['updates']),
          'strictPassed':sum(x.get('passed',False) for x in r['updates']),'wallMs':r['wallMs'],
          'terminalEntities':len(d['entities']),'terminalVectors':d['vectors'],'lastTarget':last,
          'lastTargetChunks':sum(c[0]==last for c in d['chunks']),'resultSha256':digest(out/'replay.json'),
          'sourceUnchanged':True,'legacyDependenciesUnchanged':True}
    assert not residual
    fixed_out=ROOT/'artifacts/hbm-00-update-reliability-fix-20261019'
    fixed=read(fixed_out/'replay.json');audit=read(fixed_out/'stage-audit.json')
    primary=[r['primaryQuery']['postAckQueryCompleteMs'] for r in fixed['updates']]
    rows=audit['rows']
    vendor=PYTHON.parent.parent/'Lib/site-packages/basic_memory'
    source_paths=['index/note_content_materialization.py','services/search_service.py','repository/search_repository_base.py','mcp/container.py','repository/sqlite_vec_index.py']
    summary={'at':now(),'arms':arms,'prior8FailureIds':[r['id'] for r in read(REPORTS/'bm-formal-v2-result.json')['operations'] if not r['passed']],
      'priorReportUnchanged':digest(REPORTS/'bm-formal-v2-result.json')==read(OUT/'contract.json')['priorResultSha256'],
      'diagnosis':{
       'confirmed':'MCP accepted-write/readback and manifest readiness do not establish a monotonic searchable generation. Deferred materialization reindexes; search deletion commits separately before replacement insertion. During that window new ready physical vectors can exist with no search_index row to hydrate. Concurrent writers also produced persistent loss of51vector chunks in two default-watch runs.',
       'directSnapshotEvidence':[r['id'] for r in rows if r['targetSearchRows']==0],
       'physicalTargetVectorsPerSnapshot':sorted(set(r['targetPhysicalCount'] for r in rows)),
       'bestGlobalRankRange':[min(r['targetBestGlobalRank'] for r in rows),max(r['targetBestGlobalRank'] for r in rows)],
       'projectRejections':sum(r['targetProjectRejections'] for r in rows),'hashMismatches':sum(r['targetHashMismatches'] for r in rows),
       'bounds':'Snapshots begin after live response, not atomic tracing inside query. Old8 raw candidate branches were not saved; this reproduces/explains the failure class, not a proved one-to-one cause for every old item. Five post-query snapshots lack target search rows, including two whose just-completed query hit; a single hit is not stable readiness.'},
      'repair':{'change':'Supported index_changes=false only; no vendor modification, no model/query/K change.',
       'primaryActualQueryPass':sum(r['primaryHit'] for r in rows),'primaryActualQueryMedianMs':statistics.median(primary),'primaryActualQueryMaxMs':max(primary),
       'retryStrictPass':sum(r['passed'] for r in fixed['updates']),'retryMissIds':[r['id'] for r in fixed['updates'] if not r['passed']],
       'restartPass':sum(mid in h['vectorIds'] and mid in h['lexicalIds'] for mid,h in fixed['restartQueries'].items()),
       'effective':False,'limitation':'Primary20/20<=5s; retry11/20 immediate strict checks. Early misses0.3-0.5s are not proof of sustained5s failure. No terminal-generation API barrier or repeated polling-to5s was validated; do not claim this restricted configuration always violates the5s deadline. It did not repair false-ready/non-monotonic visibility.'},
      'selection':{'basicMemoryCandidateGate':'not passed','native':'prioritize remaining verification, still test implementation','backendSelected':False,
       'stop':'Bounded diagnosis closed. No extra quality tuning/config trials. Next validate native crash recovery, then separately register real24h. Quality, materials budget and local speed gaps retained.'},
      'observerLimitations':'Disk snapshot added400-730ms; in-memory full virtual-table join added800-970ms, also intrusive. Their passing lookup rows cannot establish repaired reliability. Both runs preserved failed on60s convergence with5049/5100vectors. Fix run removes all snapshot/capture work before primary and retry queries.',
      'vendorSourceIdentities':{p:digest(vendor/p) for p in source_paths},'newRemoteModelCalls':0,'residualOwnedProcesses':residual,
      'newQualityQuestions':0,'laterBatchesStarted':False}
    assert summary['priorReportUnchanged']
    save(OUT/'conclusion.json',summary)
    plan='''

### 9.19 更新后的检索可靠性：有界诊断结论（2026-10-19）

本轮只诊断上一轮8次“新版本未命中”：保留100篇、5,100块、0–19更新及重复写入顺序，模型、原查询、候选上限和5秒门槛不变。没有质量题调参或远端模型请求。三组证据分别在 `artifacts/hbm-00-update-reliability-20261019`、`hbm-00-update-reliability-minimal-20261019`、`hbm-00-update-reliability-fix-20261019`；汇总结论为首目录的 `conclusion.json`。上一轮52/60不改分。

**结论一：已定位同类漏查的索引发布窗口，不是这组快照中的排名或项目过滤问题。** 接口202与正文读回只表示写入被接受；`LocalNoteContentMaterializationProvider.materialize_write_change` 仍会在后台落盘和索引。`SearchService.index_entity_data` 先调用删除，再单独插入替代记录；`delete_by_entity_id` 在自身会话提交删除。向量查询还须通过 `search_index` 还原笔记，故向量已ready、正文一致，并不能证明整条查询链就绪。相同内容重试尤其会让旧就绪检查立即成功，而随后后台重建再次移走检索记录。

关闭监听后的20份查询后快照中，目标均有51个真实向量，版本哈希均匹配，最佳全局排名3–9、前500内有50个正文块、项目过滤拒绝0。5份快照却没有目标检索记录（000、007、010、017、019），包括两份刚刚查询成功的记录：单次命中也不能保证后续稳定。这是版本已写入但查询链中间记录短暂消失的直接证据。快照始于响应后，不与查询原子同步；原8条没有保存分支候选，不能声称逐条确定其丢失时刻。已确认的是同类机制，旧8条的逐项归因仍有证据边界。

另有更严重的同链路故障：默认监听两次复现分别停在011、008，正文仍为新版本，100个实体仍在，但目标51块全部丢失，总向量降至5,049，观察60秒也未收敛。第一组服务日志明确记录索引重叠、零块同步以及 `Vector manifest rows disappeared before write`。这是实际超出5秒的失败，不能用后来恢复或查询重试撤销。

**观察器修正也保留失败成本。** 第一组磁盘快照在查询前引入约0.4–0.73秒；第二组虽改成内存投影，但完整虚拟表连接仍需约0.8–0.97秒，仍可能掩盖瞬时漏查。它们的成功查询不能作为修复证据，两组分别完成11、8次后在下一次更新遇到上述持久缺块并结束。唯一规避方案复验删除了查询前的所有快照操作，快照只在实际查询返回后保存；未继续迭代观察参数或追加同题调参。

**结论二：受支持的单一规避方案没有修复可靠性。** 只将 `index_changes=false`，保留MCP写入和API异步处理，不修改第三方包。20次首次写入的实际词法与向量查询均在5秒内命中；重复相同写入后的严格即时检查仅11/20通过，9次出现向量或词法缺失；重启后20/20命中。关闭文件监听仍存在缺口，因此监听不是唯一根因。关闭监听还会失去外部文件编辑自动入索引的能力，不采用该配置作为正式产品修复。

必须区分“即时漏查”与“5秒持续未就绪”：这9次即时漏查发生在重复回执后约0.3–0.5秒，未验证其在完整5秒窗口持续失败；不能把它们写成9次超时。默认监听下两次60秒缺块则是明确时限失败。旧就绪检查缺少已接受版本的后台完成依据，正式接入需要按代次验证完整发布，不能再以正文/向量数量相同代替完成，也不能增加固定睡眠来掩盖窗口。本轮到此止损，不再试下一组配置或修改第三方内部实现。

**结论三：BM候选保持未通过，后续验证优先原生。** 这不是选定或交付原生后端。原生仍是测试实现，下一步先登记并验证崩溃恢复，之后才开始真实24小时稳定性；不要直接沿用BM通过一次查询即就绪的弱条件。之前的质量反例、尾部覆盖、正式材料预算及本地速度缺口全部保留。HBM-00未完成，后续批次未扩展。
'''
    primary_text=f"\n首次写入实际查询就绪中位{statistics.median(primary)/1000:.3f}秒，最大{max(primary)/1000:.3f}秒；这是受限规避配置下的20例，不是原版整体放行。三组执行墙钟（含失败等待、启动与关闭）分别为"+', '.join(f"{a['wallMs']/1000:.3f}秒" for a in arms.values())+'。原始失败、源码身份及本机状态保留，拥有进程已退出。\n'
    docs=ROOT/'docs/INSIGHTS_IMPLEMENTATION_PLAN.md'
    assert '### 9.19 更新后的检索可靠性' not in docs.read_text(encoding='utf-8')
    with docs.open('ab') as f:f.write((plan+primary_text).replace('\n','\r\n').encode())
    note='''

### HBM-00 更新可靠性诊断（2026-10-19）

已复现并定位异步索引的可见性窗口：新正文/向量存在，后台重建仍可能先删检索记录再插回，导致已判就绪后漏查。默认监听两组还出现目标51块丢失、60秒未收敛。仅关闭监听的受支持规避方案未修复可靠性：首次写入20/20在5秒内实际命中，重复写入即时检查11/20；这9次即时漏查不等于9次持续5秒超时。旧8条缺少当时的候选，保留逐项归因限制与原评分。

本轮有界诊断结束，BM候选未通过，验证重点转向原生的崩溃恢复，随后再登记真实24小时测试；仍未选定后端。质量、材料预算、本地速度和原生测试实现边界不变。详情见[实施方案9.19](INSIGHTS_IMPLEMENTATION_PLAN.md)及[诊断结论](../artifacts/hbm-00-update-reliability-20261019/conclusion.json)。
'''
    with (ROOT/'docs/AGENTS_ROADMAP.md').open('ab') as f:f.write(note.replace('\n','\r\n').encode())
    readme='''

### 更新可靠性有界诊断（2026-10-19）

`update_reliability.py` 和 `update_reliability_minimal.py` 两次观察器运行已结束且保留失败：查询前快照仍有明显延迟，最终分别在011和008丢失全部51个目标块、60秒未收敛。`update_reliability_fix.py` 只试受支持的 `index_changes=false`，去掉查询前捕获，20次首次实际查询通过，重复写入严格即时检查11/20，未修复可靠性。`update_reliability_stage_audit.py` 仅离线核对20份真实快照的物理向量、排名、过滤和检索记录；`update_reliability_deliver.py` 汇总并保留全部旧分数。初拟 `update_reliability_diagnose.py` 未执行，不是验证证据。所有身份已使用，禁止原地重跑覆盖。结论和限制见实施方案9.19与 `artifacts/hbm-00-update-reliability-20261019/conclusion.json`。本轮没有新质量验证、正式后端集成、崩溃注入或24小时任务。
'''
    with (ROOT/'qa/memory-selection/README.md').open('ab') as f:f.write(readme.replace('\n','\r\n').encode())
    save(OUT/'delivery.json',{'at':now(),'conclusionSha256':digest(OUT/'conclusion.json'),
      'documents':{str(p.relative_to(ROOT)):digest(p) for p in [docs,ROOT/'docs/AGENTS_ROADMAP.md',ROOT/'qa/memory-selection/README.md']},
      'residualOwnedProcesses':residual,'backendSelected':False,'newRemoteModelCalls':0})
    print(json.dumps({'defaultArms':[a['status'] for a in arms.values()],'primary20Pass':summary['repair']['primaryActualQueryPass'],'retryStrictPass':summary['repair']['retryStrictPass'],'candidate':'not passed','residual':residual}))

if __name__=='__main__':main()
