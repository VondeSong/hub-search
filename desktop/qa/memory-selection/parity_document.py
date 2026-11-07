"""Write the canonical plan only after frozen scoring and ownership checks finish."""
import hashlib
import json
from pathlib import Path
from parity_support import *

def replace_section_status(raw,heading,new):
    marker=heading.encode('utf-8');pos=raw.index(marker)
    start=raw.index('状态：'.encode('utf-8'),pos)
    newline=b'\r\n' if b'\r\n' in raw else b'\n'
    end=raw.index(newline+newline,start)
    return raw[:start]+('状态：'+new).encode('utf-8')+raw[end:]

def append(raw,text):
    newline=b'\r\n' if b'\r\n' in raw else b'\n'
    return raw.rstrip(b'\r\n')+newline+newline+text.strip().replace('\n',newline.decode()).encode('utf-8')+newline

if __name__=='__main__':
    complete=read('complete-round.json');summary=read('summary.json');check=read('delivery-verification.json')
    audit=read('semantic-review.json');sources=read('source-concurrency-audit.json');query=read('query-adapter-audit.json')
    assert complete['allOwnedProcessesStopped'] and not check['injectedScopeStateViolations']
    q=summary['quality']['hub-native-hybrid'];cost=complete['cost'];old=cost['failedPreparationCost']
    e=read('evaluation.json');index=e['indexes'];diag=check['diagnoses']['hub-native-hybrid']
    caveat=read('label-quality-caveat.json')
    pct=lambda v:f'{v*100:.1f}%'
    header='### 9.15 HBM-00 同条件组件对照、真实资料尾部与适用性失败（2026-10-18）'
    status=('本轮同条件组件对照见 9.15：新冻结真实资料 56 篇、124 题，两个向量后端结果相同；'
            '前五 20/24（83.3%）、前二十 24/24，来源 ID 选择 16/24，严格引文评分 13/24，无答案误选 1/100（预先标明的无歧义组为 1/99），未达放行门槛。'
            '实际尾部覆盖已出现：10 题原始排名不在第 1，4 题排名为 7–19。共用词法适配器未兼容生产搜索默认 AND 契约，正例词法支路均为空，不能将结果冒充完整混合检索选型。'
            '本轮没有改验证题、检索参数或评分，没有继续耗时优化。原失败、准备链修正及全部远端模型预热成本保留。后端待定，HBM-00 整体未放行，后续批次不扩展；9.14 是已关闭的耗时分支历史。')
    section=f'''{header}

**结论与范围。** 两边在本冻结集合上的候选、注入文本和最终选择完全相同，均未达到前五召回至少 90%、无答案误选为 0 的门槛。结果指向共用查询适配、排序/证据组装与适用性边界，不能据此选择 Basic Memory 或原生后端。当前只完成受控组件实测，没有接入生产记忆、改变 Agent 业务逻辑、迁移模型运行层或开工后续批次。

**比较的实际层级。** “原生混合原型”使用真实 Hub SQLite/Tantivy/EvidenceReader，加隔离 Python FastEmbed/sqlite-vec 向量原型；不是已经完成 Rust 嵌入与安装分发的生产记忆后端。另一组使用 Basic Memory 0.23.2 的真实本地 MCP 向量服务，复用相同 Hub 词法结果。两者共享正文、256-token 段落窗口/32 overlap、语义子块输入、512 维中文 BGE small 权重、归一化、权限/状态过滤、原始限额、RRF60、parent20/final5、每父笔记一个证据片段与最多 2,000 BGE-token 的候选 JSON。没有启用重排器或改变适用性政策。两套向量均独立计算，共 {index['embeddingParity']['inputs']:,} 个语义输入，最大分量误差 {index['embeddingParity']['maxAbsoluteComponentDelta']}，未复制 Basic Memory 已存向量。

共同语义表示来自 Basic Memory 的解析/分块导出，实验驱动仍先检查其索引就绪再准备原生向量；因此本轮不证明无 Basic Memory 依赖的原生生产部署或独立冷启动，也不比较 Basic Memory 独立词法、图关系等完整能力。2,000 BGE-token 只是共同预算代理，尚未验证生产 Sol 精确 token 预算或规则全量加载能力。

**冻结资料和真实尾部。** 48 篇可用全文来自三个真实目录，加 8 篇真实来源作跨范围及状态控制，共 56 篇、2,181 个片段实体；没有重新截取长文开头、制造填充事实或修改原库。24 道正例来自 12 篇笔记，每篇 2 题，22 道依据位于第 1,024 个来源 token 后；另有 100 道无答案标签，包含未知实际结果、未知细节、主体混淆、条件与事件、指代、未读附件和范围/状态反例。正例不含完整来源文件名。原始排名分布为第 1 名 14 题、第 2 名 4 题、第 3 名 2 题，第 7、8、15、19 名各 1 题。10 题非首名、4 题在前五之外，通过预先登记的“至少 6 题非首名且至少 2 题在前五之外”尾部覆盖条件，没有用呈现顺序轮换替代检索难度。

方法先于新资料/问题登记；题目、标签和评分先于首次验证检索冻结。第一次抽样目录不足的失败、后续准备失败均留存。修订仅发生在验证前的准备链：Windows 换行一致性、夹具导入事务和派生向量补建。失败原生夹具在 1,900/2,181 文档时超时，尚未进入索引查询；此前没有正式验证题或正式模型调用。修订后沿用字节完全相同的 corpus/validation、相同政策、查询/融合函数及冻结评分，检索函数 AST 和原生建索引/查询后半段身份另有核对。没有根据验证成绩调题、调阈值或再次运行本集。

**正式冻结成绩。** 共 248 条后端评估行。124 题的前二十候选及完整核验输入逐题相同，按预登记规则每题只调用一次模型并共用判断；124 次正式判断不能算成 248 次独立模型试验。全部实际模型调用固定 `gpt-6.1-sol / xhigh（极高）`，每次独立临时会话、空历史、无工具、无显式重试。出题与判定同模型家族，不是独立真人或独立厂商标注。

| 项目 | Hub 原生混合原型 | Basic Memory 向量服务＋相同共同层 |
| --- | --- | --- |
| 前五来源覆盖 | {q['candidateHitAt5']}/24（{pct(q['candidateRecallAt5'])}） | 相同 |
| 前二十来源覆盖 | {q['candidateHitAt20']}/24（{pct(q['candidateRecallAt20'])}） | 相同 |
| 冻结目标证据片段进入候选 | {q['evidencePassageHit']}/24 | 相同 |
| 最终来源 ID 正确 | {q['sourceIdSelected']}/24（{pct(q['sourceIdSelected']/24)}） | 相同 |
| 严格冻结引文评分正确 | {q['strictSelectedCorrect']}/24（{pct(q['selectedRecall'])}） | 相同 |
| 严格选择相关比例 | {pct(q['selectedPrecision'])} | 相同 |
| 原始无答案标签误选 | {q['negativeFalseSelections']}/100 | 相同 |
| 预先登记的无歧义组误选 | {diag['cleanNegativeFalseSelections']}/99 | 相同 |
| 无效协议／候选越权及状态违规 | 0／0 | 相同 |

一条图书状态反例在首次检索前已发现授权版本也具有相同 bookId，可能存在标签歧义；没有改题或改标签，同时报告原始 100 与预登记 99 分母。本轮两者均有 1 次误选，不能引用零事件的 2.95%/2.98% 上界证明结果。构造反例存在相关性，不能外推总体错误率为 1%。

**重要限制：共用词法适配器失效。** 调用器将通用 jieba 分词以空格拼接交给生产搜索，而 `src-tauri/src/search_index.rs:828` 明确采用默认 AND。多个查询词需同时出现，只有 1/124 题得到非空词法结果，24 道正例词法结果全为空。因此本次正例的“混合”实际上依赖共同表示下的向量排序，不能代表正确适配后的完整 Hub 混合检索，更不能据此认定 Tantivy 或中文分词本身无效。这是本轮实验适配器的契约错误。这里只核对代码与冻结回执，没有在本集上改成 OR 后重测。

**失败应分层看。** 冻结评分记 4 题目标父笔记排在 6–20、6 题父笔记已进前五但所选片段不含冻结证据、1 题引文未命中指定锚点。原始池中已有证据却未被组装的情况可在 `delivery-verification.json` 查到。离线语义复核还发现：其中 3 条实际选到了同一来源的等义引文，固定文字锚点过窄；另 1 条命中相关笔记中的等义建议，金标 ID 是否应扩展没有独立裁定。严格 13/24 不能直接解释为模型只有 54.2% 的语义判断正确率。原来源 ID 成绩、严格评分和标签全部保留，未用复核后的乐观数字替代放行条件。

实际负例误选涉及把漫画角色、某姓氏中的“第一个”当成所问首例患者的依据：原文前部明确是漫画，注入窗口只保留姓名和“第一个”局部表达。既暴露上下文裁剪丢失来源身份，也暴露核验没有守住主体/限定范围；题意范围的标注局限同样记录，不改原误选分数。下一轮需先处理通用查询契约、候选排序/证据回读与来源身份保留，再用新的冻结集检验；本轮不继续调参或调用模型。

**准备问题及完整成本。** 初版 Basic Memory 索引准备和一次原样恢复分别耗时 {old['firstFailedPrepareWallMs']/1000:.3f}、{old['resumedFailedPrepareWallMs']/1000:.3f} 秒后失败；首次取消前写入的 1,600 个实体在恢复时因正文未变化没有重新安排向量任务，438 个新实体及另一范围 143 个实体完成。仅等待和重启不足以补齐。安装版已有 `reindex --embeddings --project notes`；首次有界补建 {old['backfillWallMs']/1000:.3f} 秒未完成，修订准备后显式补齐到 2,181/2,181、待处理为 0。该经历证明本实验协调器需要显式派生索引修复，不证明 Basic Memory 永久无法恢复，也不构成生产生命周期验收。每片段单独作笔记会放大实体数量，不能把这些时间外推成原始全文笔记模式的固有成本。

初版原生夹具每片段两次打开/检查数据库，在 600 秒安全上限时尚未完成资料写入；该时间不能当成生产批量导入性能。修订只将相同生产 upsert 和行值放入一次事务，建索引与查询代码保持不变。两次定向缓存编译分别约 3 分 41 秒、5 分 12 秒，只收集并执行 opt-in 目标，不是完整回归或发布构建。初版失败源码和回执归 `artifacts/hbm-00-parity-20261018b/`；旧部分派生状态明确登记为修订实验借用，未冒充全新冷启动。

含预检的远端生成调用 {cost['modelTurns']} 次（正式 {len(e['modelCalls'])}、预检 2），加预热 {cost['prewarmRequests']} 次，共 {cost['responseRequests']} 个有用量响应；最终无人使用的预热 {cost['unusedFinalPrewarmRequests']} 次。输入 {cost['totalInputTokens']:,}、输出 {cost['totalOutputTokens']:,}、合计 {cost['totalTokens']:,} token，缓存输入 {cost['cachedInputTokens']:,} 是输入子集，未重复相加。原生网络请求阶段共 {cost['allNetworkRequests']} 个，完成通知不另算请求。修订后的连续整批模型阶段墙钟 {cost['formalModelBatchWallMs']/1000:.3f} 秒，含索引准备及退出的正式阶段墙钟 {cost['formalFullWallMs']/1000:.3f} 秒；失败准备、补建、编译与并行重叠另列于 `complete-round.json`，没有删除。模型调用中位 {summary['modelCallMs']['median']/1000:.3f} 秒、P95 {summary['modelCallMs']['p95']/1000:.3f} 秒、最大 {summary['modelCallMs']['max']/1000:.3f} 秒，仅描述本轮，不作跨集耗时收益结论。事件按原生时间戳对齐，全部实际调用已核对模型/极高档位、空历史及无工具。主 Agent 编排/出题 token、服务端内部请求和本地嵌入完整次数不可见，记未知而非零；处理 token 不是账单。

**数据与退出核对。** 56 个冻结原始副本及候选正文身份均保持一致，所有正例来源原件哈希一致。结束时发现 1 篇非正例 MOC 原件新增导航、哈希变化，变化来源未归因；本轮未执行原库写操作，不能因此声称“原库所有文件未变化”。实验使用冻结副本，未以变化后的原件重新计算成绩。所有拥有的模型、MCP、补建及原生测试进程均已退出，凭据未复制入隔离目录，未发现明文凭据落盘。失败的原生临时数据库作为有明确归属的证据保留，不能把“进程已退出”表述为“全部临时文件已删除”。

**剩余关口。** 先修通用实验/查询适配合同并改善证据范围保留，重新登记且使用新的冻结集验证完整混合链；不得在本集上调到通过。再按 9.3 完成更新、替代、删除与派生遗忘、重启/重建/备份恢复、20 项真实任务开关对照、受管理 Windows 运行时、固定目标规模与 24 小时稳定性、分发条款。当前不选择后端，不把组件对照或手工补建当成完整准入；不扩展 HBM-01B 及后续批次，也没有启动新的耗时优化或无人值守长测。

证据根：`artifacts/hbm-00-parity-20261018c/`，主汇总 `complete-round.json`，冻结评分 `summary.json` / `scored-results.json`，另有 `query-adapter-audit.json`、`semantic-review.json`、`source-concurrency-audit.json` 和 `delivery-verification.json`。入口为 `qa/memory-selection/parity_*.py`；原生对照位于 cfg(test) 的 `memory_selection_tests.rs`，原 60 题测试保持原样。
'''
    plan=ROOT/'docs/INSIGHTS_IMPLEMENTATION_PLAN.md';raw=plan.read_bytes();before=digest(plan)
    already_written=header.encode('utf-8') in raw
    if not already_written:
        updated=replace_section_status(raw,'### 9.3 HBM-00 选型实测',status)
        plan.write_bytes(append(updated,section))
    else:
        assert section.strip().replace('\r\n','\n') in raw.decode('utf-8-sig').replace('\r\n','\n')
    roadmap=ROOT/'docs/AGENTS_ROADMAP.md';raw=roadmap.read_bytes();rbefore=digest(roadmap)
    marker='本轮只重写规划文档，后续实施范围仍按原合同管理。'.encode('utf-8')
    assert raw.count(marker)==1
    replacement='本轮已恢复 HBM-00 受控组件实测；最新成绩、准备失败和未通过事项见实施方案 9.15，后续实施范围仍按原合同管理。'.encode('utf-8')
    roadmap.write_bytes(raw.replace(marker,replacement,1))
    readme=ROOT/'qa/memory-selection/README.md';raw=readme.read_bytes();qbefore=digest(readme)
    entry='''## 原生与 Basic Memory 同条件组件对照

本轮真源见实施合同 9.15，完整证据在 `artifacts/hbm-00-parity-20261018c/complete-round.json`。56 篇真实全文、24 正例＋100 负例标签；一条负例歧义在检索前登记，另列 99 分母。前五 20/24、前二十 24/24，来源 ID 16/24、严格锚点 13/24，无答案 1/100（1/99）；两边候选与核验输入逐题相同。真实原始排名 7、8、15、19 的四题补足尾部覆盖。

原生为实际 SQLite/Tantivy/EvidenceReader 加 Python 向量原型，BM 为真实本地 MCP 向量服务；共同语义输入由 BM 解析导出，共同向量逐分量一致，不是独立生产部署/独立解析器比较。共用词法适配将自然语言词项空格相连送入默认 AND 接口，24 个正例词法支路全空；不能把本轮冒充完整混合链准入。另有等义金标过窄、证据片段丢失和来源身份裁剪问题，保留冻结评分，不在本集修参数重跑。

`parity-20261018` 保存首次抽样不足及预检；`parity-20261018b` 保存两次准备超时、原生夹具超时及源版本；修订身份 `parity-20261018c` 只修准备事务、换行校验、显式向量完成，保持 corpus/validation/评分/查询字节或函数身份。先 `parity_corrected.py register → backfill → freeze → evaluate`，模型阶段完成后才 `parity_report.py → parity_deliver.py → parity_semantic_audit.py → parity_complete.py → parity_document.py`。已用身份只读，不得原地重跑或覆盖；这些入口依赖本机已登记 runtime/cache 与先前证据，不是产品安装入口。

所有实际远端调用为 GPT-6.1 Sol/xhigh，含预检和预热全量计费代理口径，旧失败成本也保留；源库一篇 MOC 在运行中改变，冻结副本和正例原件保持一致，变化归因未知。原生批量夹具仍通过同一生产 upsert，查询后半段不变；无业务记忆集成、后端采用或后续批次。
'''
    assert '## 原生与 Basic Memory 同条件组件对照'.encode('utf-8') not in raw
    readme.write_bytes(append(raw,entry))
    save('document-update.json',{'at':now(),'files':[{'path':str(plan),'before':before,'after':digest(plan)},
        {'path':str(roadmap),'before':rbefore,'after':digest(roadmap)},{'path':str(readme),'before':qbefore,'after':digest(readme)}],
        'formalScoresChanged':False,'backendUndecided':True,'laterBatchesStarted':False,
        'partialWriteIncident':{'planAlreadyWrittenInFirstAttempt':already_written,
            'reason':'Roadmap text had been rewritten since initial inspection; first pass stopped on missing old anchor before changing roadmap or README.',
            'resolution':'Read current roadmap and replace only its one obsolete implementation-status sentence; preserve all current structure and prose.',
            'planBeforeHashTiming':'Captured after first successful plan write; original pre-write hash not retained.' if already_written else 'Before initial write'}})
    print(json.dumps({'updated':[str(plan),str(roadmap),str(readme)],'qualityGatePassed':False},ensure_ascii=False))
