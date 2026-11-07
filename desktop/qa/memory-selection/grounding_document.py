"""Offline delivery only; never consumed by a retrieval or judging call."""
import json
import hashlib
import statistics
from pathlib import Path
from grounding_support import *

def pct(x):return f'{100*x:.1f}%'
def main():
    s=read('summary.json');v=read('delivery-verification.json');e=read('evaluation.json');method=read('method-contract.json')
    assert method['sources']==sources()
    pre=read('pre-document-audit.json');assert not pre['credentialMatches'] and not pre['modelPidsAlive'] and pre['snapshotsUnchanged']
    closure=read('closure-audit.json');assert e['status']=='failed' and closure['actualUsageClosed'] and closure['scoringAllowedByObservedClosure']
    a=s['quality']['hub-native-hybrid'];b=s['quality']['basic-memory-hybrid'];cost=s['cost'];tail=s['tailCoverage']
    resource=read('resource-observation.json') if (REPORTS/'resource-observation.json').exists() else None
    rows=e['rows'];cold=[r['retrieval']['observedResolutionMs'] for r in rows if not r['retrieval']['sharedIdenticalEvidenceResolution']]
    from grounding_score import stats
    measurement={'at':now(),'coldCommonResolverMs':stats(cold),'backendVectorMs':{name:stats([r['retrieval']['vectorMs'] for r in rows if r['backend']==name]) for name in s['quality']},
        'fusedInputsSame':v['sameWholePromptQuestions'],'observedCacheHits':sum(r['retrieval']['sharedIdenticalEvidenceResolution'] for r in rows),
        'cadence':'Sequential question loop includes local reranking gaps; no artificial wait or new transport optimization; shared common resolution counted once in wall time.',
        'wallMeaning':'modelBatchWallMs includes per-question retrieval and CPU cross-encoder, model calls, drain and close; not pure inference time',
        'samplingFailures':{'A':{'sampleWallMs':1614.5812,'snapshots':12},'B':{'sampleWallMs':903.3492,'snapshots':12}},
        'rawExecutionStatus':'failed','closure':'Fixed-count drain timed out;247 actual WS sends matched247 native usage completions; no missing observed request usage; raw failure remains unchanged',
        'freezeFieldCaveat':'newSourcesOrQuestionsRead:false in the C method receipt is too broad: source bytes were machine-read for eligibility/length/hash before C sampling freeze, and earlier failed sampling copied12 notes. No new questions/quality retrieval existed; query/resolver/policy/scorer mechanisms were already frozen in A and identity-proven unchanged. Author first saw new source bodies after C method freeze.',
        'excludedCost':'Primary authoring/orchestration usage, helper execution total time and local embedding complete token counts unknown, not zero',
        'productionBudget':'This component trial allows6000 BGE tokens vs original production decision-memory2000; never treated as production budget acceptance',
        'resource':{'peakMiB':resource['peak']['rssMiB'],'meaning':resource['meaning']} if resource else None}
    save('measurement-context.json',measurement)
    numeric=a['numericGatePassed'] and b['numericGatePassed']
    status=f'前五 {a["candidateHitAt5"]}/24（{pct(a["candidateRecallAt5"])}），事实核验 {a["selectedCorrect"]}/24（{pct(a["selectedRecall"])}），无答案误选 {a["negativeFalseSelections"]}/100'
    conclusion='本新集达到质量数字门槛' if numeric else '本新集仍未达到质量数字门槛'
    equivalent='相同' if a==b else '见分组数据，不能合并'
    table='\n'.join(f'| {label} | {left} | {right} |' for label,left,right in [
        ('前五来源覆盖',f'{a["candidateHitAt5"]}/24（{pct(a["candidateRecallAt5"])}）',f'{b["candidateHitAt5"]}/24（{pct(b["candidateRecallAt5"])}）'),
        ('前二十来源覆盖',f'{a["candidateHitAt20"]}/24',f'{b["candidateHitAt20"]}/24'),
        ('冻结事实依据进入候选',f'{a["evidenceDelivered"]}/24',f'{b["evidenceDelivered"]}/24'),
        ('最终来源 ID 正确',f'{a["selectedSourceCorrect"]}/24',f'{b["selectedSourceCorrect"]}/24'),
        ('最终引文命中冻结事实核心',f'{a["selectedCorrect"]}/24（{pct(a["selectedRecall"])}）',f'{b["selectedCorrect"]}/24（{pct(b["selectedRecall"])}）'),
        ('选择相关比例',pct(a['selectedPrecision']),pct(b['selectedPrecision'])),
        ('无答案误选',f'{a["negativeFalseSelections"]}/100',f'{b["negativeFalseSelections"]}/100'),
        ('无效协议／范围状态违规',f'{a["invalidDecisions"]}／{a["scopeStateViolations"]}',f'{b["invalidDecisions"]}／{b["scopeStateViolations"]}')])
    bound=f'零误选的单侧 95% 上界按独立同分布假设计为 {pct(a["zeroEvent95UpperBound"])}；这些构造反例存在相关性，不能把它当成真实用户总体错误率保证。' if a['negativeFalseSelections']==0 else '出现误选，不能引用零事件上界；逐题结果保留，不用事后改标签消去失败。'
    preparation='；'.join(f'{x["stage"]} {x.get("project", "")}：{x["wallMs"]/1000:.3f} 秒，{x.get("status", "exit="+str(x.get("exitCode")))}' for x in e.get('preparationRepairs',[])) or '无准备修复'
    changed_sources=[x['id'] for x in s['sourceAudit'] if not x['originalUnchanged']]
    section=f'''### 9.16 HBM-00 共用查询、证据回读与来源识别修复后新集复测（2026-10-18）

**结论与边界。** {conclusion}：{status}；两边质量结果{equivalent}。本轮只修改 `qa/memory-selection/grounding_*.py` 隔离共用层并更新文档，没有修改生产 Agents、生产数据库、用户笔记、模型运行层或后续批次。**后端仍待定，HBM-00 整体未放行**；本节的质量结果不能替代生产预算、性能、生命周期和运行时准入。

**数字达标不代表本轮关口全部通过。** 新集未满足预登记的实际检索尾部覆盖条件，且仍有两处证据组装缺口。保留新集成绩，不补题、不改参数、不重跑，不用 100% 的候选召回率替代这两项缺口。

**共用层改动。** 修正调用器与 Hub 默认 AND 的契约：通用分词以逐项引号和显式 OR 传入现有生产 Tantivy/EvidenceReader，不改变用户搜索的默认逻辑。两个后端仍各取原始 50 条、RRF60 合并父笔记前二十；共同证据层回读这些父笔记的完整原文，取原始命中两段及全文词法补充两段，使用已缓存的 BGE m3 int8 交叉编码器重排，最多取五个来源。不是为新题增加同义词表或题目分支。

证据窗口按原始段落展开；超长连续段落保留开头限定及命中邻域，带原始偏移、正文哈希、标题层级、出处和来源开头。非连续处明确标记，宿主拒绝跨省略处拼接引文；Windows 隔离副本不转换原始换行。来源字段只说明文本出处，不授予用户事实、已执行事件或规则确认状态。核验区分作者、用户、引用人物、示例、假设、局部群体和真实完成状态。没有声称自动推断的文体分类是可信事实。

**开发与冻结。** 旧集仅用于开发回归：25 条查询均有词法结果，旧 24 个正例来源进前五；旧主体误选题拒选，另一个旧正例保留，开发模型共 2 次。对 2,181 个旧真实片段检查命中保留、精确偏移、断续引文和权限拒绝，并另用实际笔记 CRLF 副本核对写入身份。旧集数字不算新验证收益。

方法、政策、评分及模型权重身份先冻结，再选择资料、出题和冻结标签。前两次窄目录抽样不足均在新问题和验证检索之前停止；没有把空目录当成质量失败后调题。资格盘点后使用互不重叠的结构学、Resources 和排除结构学的 Areas 三个资料池，旧开发回执只计费一次。失败 A/B 的 12 份准备副本、两次失败和未改变检索/核验机制的证明均保留。

冻结回执的 `newSourcesOrQuestionsRead:false` 字段过于笼统：最终 C 抽样冻结前，机器已经为资格统计读取原文字节、长度和哈希，失败准备也复制过 12 篇；不能把该字段解释为任何程序都没读过新资料。查询、裁剪、核验与评分机制从 A 起已冻结且保持身份，作者在 C 方法冻结后才阅读新正文和出题；此前没有新题、质量检索或验证模型调用。

**新集与标注。** 44 篇完整真实笔记：36 篇可用、8 篇范围或状态控制；1,472 个片段。24 道正例来自 12 篇新笔记，均有依据位于来源第 1,024 token 后；包括长文后段、单个连续长段落、原作者与引用对象、数值口径及建议与实际执行。同一文章的两个副本在检索前登记为均有效；无答案 100 题包含缺细节、未发生、主体错配、条件当事件、范围扩大、未读引用、指代、指令及权限/状态反例。出题者完整阅读 12 篇目标正文，读取其他来源的开头/标题并扫描全部 44 篇的核心与控制锚点，未独立穷尽所有可能等义改写。所有模型判断固定 GPT-6.1 Sol/xhigh，出题和判定同家族，**不是独立标注**。

初始 RRF 排名非首名 {tail['initialNonfirst']} 题、前五外 {tail['initialBeyond5']} 题；最终重排非首名 {tail['finalNonfirst']} 题、前五外 {tail['finalBeyond5']} 题。预登记的初始实际尾部条件（至少 6 非首名且至少 2 前五外）{'满足' if tail['retrievalTailDemonstrated'] else '未满足，本集检索尾部挑战覆盖不足，不能仅凭正例位于文末补称通过'}。没有通过轮换位置制造尾部，也没有为补足此条件再出题或重跑。

| 项目 | Hub 原生混合原型 | Basic Memory＋相同共同层 |
| --- | --- | --- |
{table}

冻结评分接受预先审阅的最小事实核心及其多处原文，不再要求复现整条长引文；另外保留来源 ID 与实际依据是否送达。它仍不是独立语义评分，未覆盖的等义引文可能被低估，未在结果后扩展金标。{bound}

**两条正例失败保留。** 一题送达了“把陌生复杂事物简化为熟悉模型”的总结结论，却没送达题目用于定位原文的错画地图比喻，模型保守拒选；来源定位上下文不足可能影响判断，不能直接归因为推理模型弱。另一题中两份有效副本都只送达“学历普通、第一份工作平凡”的场景前句，答案在紧接的下一段；当前窗口保留当前与前文，未保留后续承接，属于仍存在的通用证据边界问题。未把这两题移除或事后改成通过，见 `failure-input.json` / `semantic-review.json`。

**关闭异常与离线核账。** 原始 `evaluation.json` 的状态保持 `failed`：关闭检查固定期待 124×2=248 个用量完成事件，但正式实际只有 247 次发送、247 次带用量完成（124 次题目核验＋123 次预热）。第 6 题有两次连接事件、一次发送，未观察到预热发送；固定计数条件因此超时。原生事件逐请求配对后，无未对应的已发送请求、无 HTTP 推理请求遗漏，全部 124 次核验用量与回执一致，拥有的进程已退出。先登记 `closure-contract.json`，再核对 `closure-audit.json`，**在查看质量成绩前**确定按实际发送/完成闭合后可以消费完整结果；离线报告调用原来冻结的 `grounding_score.score`，未改政策、评分函数、标签或门槛，没有再次调用模型，也没有把原始失败状态改成完成。服务端内部不可见工作仍记未知。这修正的是报告关闭假设，不能宣称原执行器已无此缺陷；下一次运行入口须消费实际请求闭合条件。

**比较层级及预算限制。** 原生仍是实际 Hub SQLite/Tantivy/EvidenceReader 加隔离 Python FastEmbed/sqlite-vec 向量原型；Basic Memory 为 0.23.2 本地 MCP 向量服务，两边独立计算相同 BM 解析导出的语义子块。向量输入 {s['indexes']['embeddingParity']['inputs']} 个，最大分量差 {s['indexes']['embeddingParity']['maxAbsoluteComponentDelta']}，未复制已存向量。共享解析器、词法与证据重排层，因此不是两种完整产品能力或不依赖 BM 的生产部署比较。{v['sameWholePromptQuestions']}/124 题完整提示相同，相同提示共用一次实际判断，不能把两组逻辑行当独立模型观察。

候选 JSON 上限由上一轮 2,000 扩至 6,000 BGE token，实测中位 {s['evidenceTokens']['median']:.0f}、最大 {s['evidenceTokens']['max']:.0f}。这只是组件实验扩大上下文保留的代价，**尚未证明在原生产决定记忆 2,000 模型 token 预算内有同样效果**，BGE 也不是 Sol 精确 token 计数，两个口径不能直接等同。没有声称省 token 或变快。共同证据重排首次实际执行中位 {measurement['coldCommonResolverMs']['median']/1000:.3f} 秒、P95 {measurement['coldCommonResolverMs']['p95']/1000:.3f} 秒；同题共同输入完全相同时复用这次本地处理，实际墙钟只计一次。两边观测检索时间混有首次与共用结果，不能拿中位数直接比较后端快慢；原生/BM 向量单段耗时另见 `measurement-context.json`。完整检索尚不能宣称满足热 P95≤1 秒关口。

**完整可见成本。** 开发判断 {cost['developmentModelTurns']} 次、正式判断 {cost['formalModelTurns']} 次，合计 {cost['modelTurns']} 个生成判断；预热 {cost['prewarmRequests']} 次、有用量响应 {cost['responseRequests']} 个、最终无人使用预热 {cost['unusedFinalPrewarmRequests']} 次。输入 {cost['totalInputTokens']:,}、输出 {cost['totalOutputTokens']:,}、合计 {cost['totalTokens']:,} token，缓存输入 {cost['cachedInputTokens']:,} 是输入子集；原生网络请求阶段 {cost['allNetworkRequestCount']} 次。使用原生事件时间戳对齐，完成通知不另作请求。正式连续问题循环（含各题检索、CPU 重排、模型、排空和退出）墙钟 {cost['formalModelBatchWallMs']/1000:.3f} 秒；含索引准备及退出 {cost['formalFullWallMs']/1000:.3f} 秒。模型单题调用中位 {s['modelCallMs']['median']/1000:.3f} 秒、P95 {s['modelCallMs']['p95']/1000:.3f} 秒、最大 {s['modelCallMs']['max']/1000:.3f} 秒。未增加人工间隔、远端连接或预热实验，不能与旧集作提速对照。开发回归、本轮准备修复和两次抽样失败单列，主 Agent 编排/出题 token、辅助程序总时长、服务端内部请求及本地嵌入完整 token 数不可见，记未知而非零；处理量不是账单。

本轮索引准备回执：{preparation}。最终 BM 就绪检查 {s['indexes']['bmPrepareMs']/1000:.3f} 秒、原生独立向量构建 {s['indexes']['nativeVectorMs']/1000:.3f} 秒、共同 Hub 词法建索引及整批查询 {s['indexes']['lexicalMs']/1000:.3f} 秒。若发生超时后显式补建，最后就绪检查不能冒充独立冷启动。实验把每个片段作为一个 BM 笔记，会放大实体同步工作，不能将此准备开销直接外推为原始 44 篇整笔记接入的固有成本。

**一致性与退出。** 已核对 {v['injectedCandidatesAudited']} 个注入候选的原文偏移/哈希与权限状态、{v['selectedQuotesAudited']} 个选择引文和 {v['actualModelCallsAudited']} 个实际模型调用的 Sol/极高、空历史、无工具和无显式题目重试；一次连接重建按原生事件计入。冻结副本保持身份；原件变化 {len(changed_sources)} 篇，均为非正例（笔记管理 MOC 与 Markdown 规范），正例原件均保持哈希，见 `source-concurrency-audit.json`，改变归因未知，本轮未写原库。拥有的模型、MCP、原生夹具进程已关闭，三身份目录凭据扫描未发现明文登录值，原生生产代码身份未变。观察到的整条隔离运行树峰值 RSS {resource['peak']['rssMiB']:.1f} MiB（若有共享页可能按进程重复计算；观察从索引准备中途开始），含本地重排器和 Codex 宿主，不是单个后端或 24 小时内存验收；无残留 {len(resource['residual'])==0}。

**后端关口与停止位置。** 本轮不根据新集修改方法再测，也不按这个小集合强行选择后端。还需在生产注入预算与固定规模下证明完整链质量/延迟，完成更新、替代、彻底删除与派生遗忘、重启/重建/备份恢复、20 项真实任务开关对照、受管理 Windows 运行时与分发条款、24 小时稳定性；质量通过只关闭相应组件观察。保持 HBM-01A 原有正式桌面验收状态，不扩展 HBM-01B 及后续批次，不重开耗时优化。

证据根 `artifacts/hbm-00-grounding-20261018c/`：`summary.json`、`scored-results.json`、`validation-contract.json`、`label-review.json`、`delivery-verification.json`、`measurement-context.json`、`resource-observation.json`、`closure-contract.json`、`closure-audit.json`、`semantic-review.json`；失败抽样 A/B、原始输入/输出与隔离索引均保留，详见 `inventory-amendment.json`。本轮入口 `grounding_run.py` / `grounding_data.py`，关闭异常后实际离线顺序是 `grounding_close.py contract → reconcile → report → audit`，再 `grounding_diagnose.py → grounding_document.py`；冻结评分函数仍为 `grounding_score.score`，偏移核对复用 `grounding_checks.verify_candidate`。这些依赖本机登记的隔离环境和缓存，不是产品安装入口，已用身份不得重跑。
'''
    plan=ROOT/'docs/INSIGHTS_IMPLEMENTATION_PLAN.md';roadmap=ROOT/'docs/AGENTS_ROADMAP.md';readme=ROOT/'qa/memory-selection/README.md'
    before=REPORTS/'document-before';before.mkdir(exist_ok=False);changes=[]
    for p in [plan,roadmap,readme]:
        raw=p.read_bytes();(before/p.name).write_bytes(raw);text=raw.decode('utf-8')
        if p==plan:
            assert '### 9.16 HBM-00 共用查询' not in text
            start=text.index('### 9.3 HBM-00 选型实测');a0=text.index('状态：',start);b0=text.index('\n\n',a0)
            current=f'状态：共用查询、证据回读和来源身份修复后新集见 9.16：44 篇真实笔记、24 正例＋100 负例，{status}。{conclusion}；初始检索尾部覆盖{ "满足" if tail["retrievalTailDemonstrated"] else "不足" }。本轮使用较大组件证据预算和本地重排，不能代替生产预算/性能验收。后端待定，HBM-00 整体未放行，剩余生命周期、真实任务、Windows 与 24 小时关口仍开放；不扩展后续批次。9.15 保留旧集失败，9.14 是已关闭的耗时分支历史。'
            text=text[:a0]+current+text[b0:];text=text.rstrip()+'\n\n'+section
        elif p==roadmap:
            old='本轮已恢复 HBM-00 受控组件实测；最新成绩、准备失败和未通过事项见实施方案 9.15，后续实施范围仍按原合同管理。'
            assert old in text,'Roadmap changed concurrently; reread before any replacement'
            text=text.replace(old,'HBM-00 已修复隔离共用查询与证据层并完成新集复测；最新成绩、成本及仍未通过的关口见实施方案 9.16，后端仍待定，后续实施范围按原合同管理。',1)
        else:
            text=text.rstrip()+f'\n\n## 共用查询与证据修复的新冻结复测\n\n本轮真源见实施合同 9.16，证据 `artifacts/hbm-00-grounding-20261018c/summary.json`。44 篇完整真实笔记、24 正例＋100 负例；{status}，两边结果{equivalent}。质量数字达标，但实际检索尾部条件不足（仅3题非首名、无前五外），且仍有来源定位和后续段落遗漏，不可放行选型。标签先于首次检索冻结，只跑一次；不根据验证题调参。\n\n方法与评分从第一次准备起冻结；前两次窄目录抽样不足，保持机制不变后扩大资格资料池，机器先按字节/长度统计，不应把 C 回执笼统的 `newSourcesOrQuestionsRead:false` 解释为程序完全没读过原文。作者在 C 方法冻结后才读取新正文和出题。失败和回执借用见 `inventory-amendment.json`，开发调用只计一次。\n\n执行入口 `grounding_run.py evaluate` 原始状态保留 `failed`：固定248次用量完成的关闭检查超时；实际247次发送已逐项配对247次完成，其中123次预热。先 `grounding_close.py contract → reconcile → report → audit` 在看质量前核账，再调用冻结的评分函数生成结果；没有新模型调用，也未改原始状态。最后 `grounding_diagnose.py → grounding_document.py`，见 `closure-audit.json`。已用身份禁止原地重跑或覆盖。\n\n显式 OR 兼容真实 Hub 默认 AND 查询合同；完整父笔记回读、中文本地交叉编码器及原文段落展开是两边共用层，不是某后端独有收益。保留出处/正文哈希/标题/偏移，断续引文不能拼接，来源文本不等于用户事实。候选上限 6,000 BGE token，尚未验证能在生产决定预算 2,000 模型 token 内达到同样效果，需独立验收成本与生产适配。原生仍为 Python 向量原型、BM 解析仍为共同表示，未选择后端、未变更生产业务或扩展批次。\n'
        assert p.read_bytes()==raw,'Concurrent document edit; stop before write'
        p.write_bytes(text.encode('utf-8'));assert p.read_bytes()==text.encode('utf-8')
        changes.append({'path':str(p),'beforeSha256':hashlib.sha256(raw).hexdigest(),'afterSha256':digest(p)})
    save('document-update.json',{'at':now(),'changes':changes,'offlineSourceSha256':digest(Path(__file__))})
    print(json.dumps({'documents':len(changes),'status':status,'conclusion':conclusion},ensure_ascii=False))

if __name__=='__main__':main()
