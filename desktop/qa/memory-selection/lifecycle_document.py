"""Publish completed immutable operational evidence without changing scores."""
from lifecycle_support import *

def seconds(ms):return f'{ms/1000:.3f}'

def main():
    s=read(REPORTS/'summary.json')
    assert not s['residualOwnedProcesses']
    assert s['sameFinalContent']
    assert all(a['status']=='completed' and a['backupRestorePassed'] and a['operations']['delete']['passed']==20 and a['operations']['replace']['passed']==20 for a in s['arms'].values())
    diagnostics={k:read(REPORTS/f'{k}-retrieval-diagnosis.json') for k in ['bm','native']}
    assert all(not d['residual'] for d in diagnostics.values())
    baseline=read(REPORTS/'scope.json')['baseline']
    unchanged={p:digest(ROOT/p)==h for p,h in baseline.items()}
    assert all(unchanged.values()),unchanged
    table=[]
    for k,label in [('bm','Basic Memory'),('native','Hub 原生测试入口')]:
        a=s['arms'][k];o=a['operations'];u=o['update']['primaryPostAck']
        table.append(f"| {label} | {seconds(a['cold']['medianMs'])} / {seconds(a['cold']['maxMs'])} | {o['update']['passed']}/20 | {o['delete']['passed']}/20 | {o['replace']['passed']}/20 | {seconds(u['medianMs'])} / {seconds(u['maxMs'])} | {'通过' if a['backupRestorePassed'] else '未通过'} |")
    diag=[]
    for k,label in [('bm','BM'),('native','原生')]:
        rows=diagnostics[k]['rows']
        miss=lambda field:[r['id'] for r in rows if not r[field]]
        diag.append(f"{label}最终恢复状态复核{len(rows)}篇：原查询向量未命中{miss('originalVectorFound')}；完整首个正文块控制查询未命中{miss('exactChunkVectorFound')}；原词法查询未命中{miss('originalLexicalFound')}。")
    text='''

#### 9.18.1 完成结果与保留的失败

首次正式方法在启动查询阶段发现合成标记处于连续的 Unicode61 词元中，单独截出的子串不匹配。原方法、失败回执和索引成本全部保留；`formal-v2-amendment.json` 先登记两边均使用原文完整词元的机械修复，再冻结 `formal-method-v2.json`，在新目录完整运行。没有改变正文、向量查询、模型、样本数或时间限制，也没有使用质量题调参。最终原始结果为 `bm-formal-v2-result.json` 和 `native-formal-v2-result.json`；`summary.json` 是独立核账，不覆盖原始状态。

| 后端 | 五次新进程首次可用中位 / 最大（秒） | 更新严格通过 | 删除严格通过 | 替代严格通过 | 首次更新回执后就绪中位 / 最大（秒） | 备份恢复 |
| --- | --- | --- | --- | --- | --- | --- |
'''+ '\n'.join(table)+f'''

两边都完成60个逻辑操作和140个含重试的变更步骤；恢复后均为80篇、4,080块，全部正文哈希相同。BM的8个更新失败项均为新版本检索未命中，原文读回、旧文本不再命中及5秒就绪检查通过，严格评分仍为52/60，不改为整体通过。原生完整结果按表保留；这不是生产记忆功能验收。

**可比性审计。** 相同全文、操作顺序、查询、作用域、权重、CPU线程和候选上限下，两边内部检索实现仍有差异：BM先取全局前500块再过滤项目，原生测试入口先过滤项目再取500块；原生代码注释称“global”不准确。本轮是相同负载的生命周期对照，不是候选生成逐项等价试验，不能以命中数证明原生质量更好。另有回执边界差异：原生在嵌入及SQLite提交后回执，BM在异步向量完成前回执；不得仅比较回执后时间。摘要同时保存回执、回执后、含重复请求及核验的逻辑操作总耗时。主更新与包括幂等重试的分布分列，不能用快速重试稀释更新耗时。

两组完整墙钟（含首次索引、启动、操作、备份恢复及关闭）分别为BM {seconds(s['arms']['bm']['wallMs'])}秒、原生 {seconds(s['arms']['native']['wallMs'])}秒。首次索引分别为{seconds(s['arms']['bm']['initialIndexMs'])}秒、{seconds(s['arms']['native']['initialIndexMs'])}秒。末次进程树RSS采样分别为{s['arms']['bm']['finalSampledRssMiB']:.1f}MiB、{s['arms']['native']['finalSampledRssMiB']:.1f}MiB；不含共同QA控制器，不是峰值、24小时统计或整个应用占用。旧失败和准备运行成本仍保留，不包含在这两组成功执行的墙钟里。

**失败后的只读复核，不改分。** `retrieval-diagnosis-method.json` 在复核前登记相同原查询与已存首个完整正文块控制查询；复核不变更索引参数、模型或评分。{''.join(diag)}最终资料池经过删除/替代，已从100篇变成80篇；重启后命中不能证明原失败是瞬时竞态，也不能回填原失败时未保存的分支结果。8次失败保持未解决的检索缺口，不再针对这些记录调参。

**交付边界。** 本轮修复BM默认小提交批次导致的更新就绪超时，并验证两边删除、替代、重复请求、关闭后备份迁移及重启恢复；拥有进程已退出，冻结方法/语料、生产Cargo文件和上一轮质量入口哈希核对未变。构建共做3次定向收集，超出初始单次构建估算，均只收集指定入口；前置接口修复、失败回执及成本保留。没有新远端模型请求。原生新增实现仅在测试编译下存在，未集成生产记忆后端；突然崩溃恢复、历史备份与派生摘要遗忘、干净Windows安装、分发许可、运行时升级回滚和真实24小时仍待验证。HBM-00未放行，未决定后端，未启动后续批次。
'''
    plan=ROOT/'docs/INSIGHTS_IMPLEMENTATION_PLAN.md'
    assert '#### 9.18.1 完成结果与保留的失败' not in plan.read_text(encoding='utf-8')
    with plan.open('ab') as f:f.write(text.replace('\n','\r\n').encode())
    roadmap=ROOT/'docs/AGENTS_ROADMAP.md'
    addition='''

### HBM-00 生命周期续批（2026-10-18）

已完成原生与BM各100篇/5,100块、5次启动、20次更新/删除/替代及关闭后备份恢复。BM通过受支持同步批次配置修复更新就绪超时，140个变更步骤均在原5秒内；20次删除、20次替代和恢复通过，但8次新版本检索未命中，严格评分52/60，整体未通过。原生的完整数值及两边候选过滤次序、回执边界差异见实施方案9.18.1；不能将此次生命周期对照当成质量胜负。无新质量调参或远端模型调用，后端待定、后续批次未开始。

- [生命周期摘要](../artifacts/hbm-00-lifecycle-20261018/summary.json)：两组原始评分、时限、恢复、成本及限制。
- [实施方案9.18](INSIGHTS_IMPLEMENTATION_PLAN.md)：更新超时根因、前置修复、失败保留和后续未验证项。
'''
    with roadmap.open('ab') as f:f.write(addition.replace('\n','\r\n').encode())
    readme='''

### 生命周期同负载对照与BM更新修复

证据位于 `artifacts/hbm-00-lifecycle-20261018`，方法 `formal-method-v2.json`，结果 `bm-formal-v2-result.json`、`native-formal-v2-result.json`、`summary.json`。BM同步提交批次2→32，其余诊断变量固定；正式140步均未超5秒，但8次更新检索未命中，保留52/60严格评分。两边20删除、20替代、迁移后恢复已验证；真实24小时和崩溃恢复未验证。候选项目过滤次序不同，不能冒充逐项候选等价或后端选型结论。

本机专用入口 `lifecycle_support.py` → `lifecycle_bm.py`（A/B）→ `lifecycle_formal_v2.py freeze|bm|native` → `lifecycle_report.py` → `lifecycle_retrieval_diagnosis.py` → `lifecycle_document.py`。已有身份均已使用，禁止直接原地重跑；另有已保留失败的preflight/canary/v1。实际Rust入口是 `agent_work::memory_lifecycle_tests::native_lifecycle_rpc`，仅测试编译，依赖已验证的本机运行时和嵌入组件，不是安装入口。所有新报告独占创建，原评分不覆盖；只读诊断结果不能回填冻结评分。细节与范围见实施方案9.18.1。
'''
    with (ROOT/'qa/memory-selection/README.md').open('ab') as f:f.write(readme.replace('\n','\r\n').encode())
    save(REPORTS/'delivery-audit.json',{'at':now(),'baselineUnchanged':unchanged,'summarySha256':digest(REPORTS/'summary.json'),
        'documents':{str(p.relative_to(ROOT)):digest(p) for p in [plan,roadmap,ROOT/'qa/memory-selection/README.md']},
        'newRemoteModelCalls':0,'backendSelected':False,'hbm00Complete':False})
    print('Completed lifecycle evidence documented; strict failed scores retained.')

if __name__=='__main__':main()
