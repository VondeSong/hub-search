"""Publish observed recovery/soak state; never convert progress into a pass."""
from native_recovery import *

def main():
    r=read(OUT/'result.json')
    rows=r['cases'];passed=sum(bool(x.get('passed')) for x in rows)
    progress=read(OUT/'soak-progress.json') if (OUT/'soak-progress.json').exists() else None
    summary={'at':now(),'recoveryStatus':r['status'],'recoveryPassed':passed,'recoveryTotal':7,
      'recoveryResultSha256':digest(OUT/'result.json'),'soak':progress,'backendSelected':False,
      'qualityRetuned':False,'laterBatchesStarted':False,'newRemoteModelCalls':0}
    save(OUT/'delivery.json',summary)
    table='\n'.join(f"| {x['operation']} / {x['phase']} | {x.get('firstUsableMs',0)/1000:.3f} | {'通过' if x.get('passed') else '未通过'} |" for x in rows)
    timing=[c['queryAfterAckMs'] for x in rows for c in x.get('replay',[])]
    soak_text=(f"24小时任务已启动，目前状态 `{progress['status']}`，已记录 {progress['cycles']} 个采样点；测量起点 `{progress.get('measurementStartedAt','尚未开始')}`。这是启动/进度回执，不是24小时通过结论。" if progress else '24小时任务尚未启动；恢复关口未全部通过时不得启动。')
    detail=f'''\n\n### 9.20 原生崩溃恢复与真实24小时观察（2026-10-19）

**范围与预登记。** 依据继续 HBM-00 的授权，先完成原生恢复，再按关口启动长期观察；不重调质量题、不采用后端、不扩批次。运行前 `contract.json` 冻结7种中断场景、100篇/5,100块、首次可查≤10秒、回执后实际查询≤5秒；保存原Rust模块字节。仅在测试模块增加可控停顿，控制器收到对应阶段事件后强制终止拥有的进程和嵌入子进程，未用正常关闭冒充崩溃。唯一指定测试入口编译收集后，冻结驱动、Rust源、二进制和语料哈希。证据根 `artifacts/hbm-00-native-recovery-20261019`。

**实际恢复结果：{passed}/7。** 原始运行状态 `{r['status']}`。每种场景复制同一完整种子状态，核对所有正文、块、目标实际向量和词法查询、SQLite完整性及重复操作。提交前应完整回滚；提交后即使未收到回执也应恢复新状态；已回执但词法尚未刷新时，重启应消费实际索引任务。替代是两个独立操作，中断后允许前后两条同时存在，再通过重放完成删除，不宣称跨操作原子性。

| 中断点 | 重启至首次实际命中（秒） | 严格结果 |
| --- | --- | --- |
{table}

重放及重复操作共 {len(timing)} 次，回执后完整状态核对加实际查询最大 {max(timing,default=0)/1000:.3f} 秒。强制退出和正常收尾的拥有进程记录逐项保留；原始结果 `result.json`。本测试证明进程终止后的组件恢复，不证明断电、磁盘损坏、并发外部编辑或正式安装版能力。

**长期观察。** {soak_text} 冻结 `soak-contract.json` 后才可运行：真实86,400秒，60秒节拍，1,440个间隔加起点共1,441个采样点；具体采样点数澄清原合同“1,440 cycles”的间隔口径，不缩短时长。每分钟更新并查询、相同内容重试并查询，每10轮删除再创建另一个对象，每轮核对全部状态和项目隔离。原5秒/10秒门槛保持；进程树RSS≤1,536 MiB，末60次中位数相对首15次中位数增长≤10%，采样间隔超过120秒即不能通过连续性。测试目录≤8 GiB、剩余磁盘≥10 GiB。最后关闭重启并复核全量内容。暂停、休眠或进程中断不能折算为通过；不会自动重启掩盖失败。

**未关闭的关口。** BM更新可靠性仍未通过；原生仍是调用现有持久化/检索组件的测试实现，共用分段器仍依赖BM纯解析器。原冻结质量分数、材料预算、本地速度、实际任务收益、干净安装与分发评审、升级回退和派生历史遗忘等缺口保留。没有新的远端模型调用；模型要求仍为GPT-6.1 Sol/xhigh。HBM-00未完成，后端未定。
'''
    target=ROOT/'docs/INSIGHTS_IMPLEMENTATION_PLAN.md'
    old=target.read_text(encoding='utf-8');assert '### 9.20 ' not in old
    target.write_text(old+detail,encoding='utf-8')
    brief=f'''\n\n### HBM-00 原生恢复续批（2026-10-19）

原生7个真实进程中断场景通过 {passed}/7，覆盖更新/删除的提交前、提交后、回执后，以及替代中断后的重放。完整100篇/5,100块条件和原时限不变。{soak_text}

详见[实施方案9.20](INSIGHTS_IMPLEMENTATION_PLAN.md)、[恢复原始结果](../artifacts/hbm-00-native-recovery-20261019/result.json)及[本轮交付状态](../artifacts/hbm-00-native-recovery-20261019/delivery.json)。BM未放行，原生尚非正式后端；质量、预算及速度缺口继续保留，后端待定、后续批次未开始。
'''
    target=ROOT/'docs/AGENTS_ROADMAP.md';target.write_text(target.read_text(encoding='utf-8')+brief,encoding='utf-8')
    target=ROOT/'qa/memory-selection/README.md'
    target.write_text(target.read_text(encoding='utf-8')+f'''\n\n### 原生崩溃恢复与24小时观察

`native_recovery.py` 使用唯一已收集的测试入口，在完整种子副本上注入7个真实进程终止，实际通过 {passed}/7。`native_soak.py register` 只在恢复全部通过后冻结合同；`run` 独占创建 `run.started`，运行真实24小时，进度文件不能代替 `soak-result.json`。`native_recovery_document.py` 只发布已观察的状态。上述身份不可原地重跑覆盖。

运行目录 `.local/hbm-00/lifecycle-20261018/recovery-20261019`；证据 `artifacts/hbm-00-native-recovery-20261019`。后台只使用拥有的PID及创建时间识别，`soak/STOP` 请求停止；不得按进程名称批量终止。详情及证据边界见实施方案9.20。{soak_text}
''',encoding='utf-8')
    print(json.dumps({'recoveryPassed':passed,'soakStatus':progress.get('status') if progress else None}))

if __name__=='__main__':main()
