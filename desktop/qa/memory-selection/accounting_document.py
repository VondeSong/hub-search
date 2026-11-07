"""Update existing implementation plan and QA index after frozen scoring."""
from pathlib import Path
from accounting_support import ROOT,read

if __name__=='__main__':
    summary=read('summary.json');audit=read('stratified-result-audit.json');cost=read('complete-round-cost.json')
    q=summary['quality']; timing=summary['timing']; c=summary['cost']; total=cost['totals'];shape=audit['totals']
    sec=lambda v:f'{v/1000:.3f}'
    result=(f"**正式质量与耗时结果。** 140 题一次完成，前五覆盖 {q['candidateCorrectAt5']}/40（{q['candidateRecallAt5']:.1%}），最终选择 {q['selectedCorrect']}/40（{q['selectedRecall']:.1%}），无答案误选 {q['negativeFalseSelections']}/100；协议无效 {q['invalidDecisions']}，项目/状态违规 0。"
        f"本冻结集质量门槛{'通过' if summary['qualityGatePassedOnFrozenSet'] else '未通过'}；真实笔记正例覆盖 {shape['realPositive']['candidateHit']}/20、最终正确 {shape['realPositive']['selectedCorrect']}/20。"
        f"正确依据原始检索排名分布为 {shape['positiveGoldRetrievalRanks']}，其中原始第 4/5 名 {shape['retrievedAt4Or5']} 题；固定轮换后呈现第 4/5 位 {shape['presentedAt4Or5']} 题。"
        f"依据位于第 512 token 后 {shape['positiveSupportAfter512']} 题，第 1,024 token 后 {shape['positiveSupportAfter1024']} 题。**40 道正例的正确依据实际均在原始检索第 1 名，本轮没有实现原始检索尾部的难题覆盖，不能据此证明尾部召回稳健；候选轮换只验证靠后呈现时的适用性核验。**题目多含笔记名/对象编号，真实来源集中在笔记与任务管理、含早期 AI 建议，仍不能代表零散个人资料或全库规模。\n\n"
        f"完整单题链路中位 {sec(timing['endToEndMs']['medianMs'])} 秒、P95 {sec(timing['endToEndMs']['p95Ms'])} 秒、最慢 {sec(timing['endToEndMs']['maxMs'])} 秒；检索 P95 {sec(timing['retrievalMs']['p95Ms'])} 秒。"
        f"索引准备 {sec(timing['indexPrepareMs'])} 秒（包含 MCP 初始化 {sec(timing['mcpInitializeMs'])} 秒），模型服务初始化另计 {sec(timing['persistentInitializeMs'])} 秒。"
        f"连续 140 题从模型服务启动前到请求结算/服务关闭的墙钟 {sec(c['modelBatchWallMs'])} 秒；包括索引准备和 MCP 关闭的正式实验墙钟 {sec(c['totalRunMs'])} 秒。"
        "第 69 题出现约 92.189 秒慢尾：检索 0.176 秒，会话建立约 0.080 秒；模型调用开始到原生正式发送约 2.940 秒，正式发送到完成约 89.061 秒，完成到宿主返回约 0.012 秒。"
        "该题原生建连约 1.155 秒，预热响应约 0.662 秒，均位于正式发送前的准备区间；不能把这些嵌套时段再次相加。原生首个答案增量边界未被本轮允许字段捕获，不能伪造该边界；宿主首个推理项约在提交后 91.362 秒、首个答案约 91.470 秒。没有证据把剩余等待分成纯网络、排队、预填充和隐藏推理。长尾尚未消除，未重试这道题，也不继续调优。\n\n"
        f"**全部实验成本。** 6 次预检、48 次同题对照、140 次正式题，共 {total['formalTurns']} 次题级调用；再加 {total['prewarmRequests']} 次预热，共 {total['responseRequests']} 个有用量的响应，包括 {total['unusedFinalPrewarmRequests']} 次最终无人使用的预热。"
        f"合计输入 {total['totalInputTokens']:,}、输出 {total['totalOutputTokens']:,}，输入加输出 {total['totalTokens']:,} token；其中缓存输入 {total['cachedInputTokens']:,} 是输入的子集，未重复相加。"
        f"控制 HTTP、WS 握手及 WS 发送按实际请求阶段计 {total['allNetworkRequestCount']} 个，再加公共准入 {total['publicAdmissionRequests']} 个，共 {total['allNetworkRequestsIncludingPublicAdmission']} 个观测到的网络请求；响应完成不是额外请求。"
        f"各拥有的子实验墙钟合计 {sec(total['sumOwnedExperimentWallMs'])} 秒，含实际思考间隔 {sec(total['scheduledThinkTimeMs'])} 秒；公共准入请求等待另计 {sec(total['publicAdmissionWaitMs'])} 秒。"
        "逐请求原生时间、耗时和用量保存在 `complete-round-cost.json`。主 Agent 的出题/编排 token 与服务端内部调用不由子进程回执提供，记为不可见而非零；没有声称这是账户账单。"
        "离线评分、文件核对和文档编写不属于交互核验时段，单列后处理记录。首次评分核对等待后中止了两个拥有的评分进程，再以仅记录行号的包装器执行同一冻结评分源码；一次分层汇总过早读取尚未生成的摘要而退出，后续只重跑离线汇总。没有重新检索、调用模型、改标签或改评分规则。\n\n"
        "补充资源旁观约 20.9 分钟，观测到拥有的模型/记忆进程树合计 RSS 最高约 811.8 MiB、进程数最高 5；开始时索引准备已在进行，不覆盖完整冷启动峰值，不是冻结固定负载的 24 小时证据。"
        "逐题回执、完整正文身份、盲化输入、精确引文、权限/状态与退出核对以 `verification-final.json` 为准；原始引文语义另作同作者人工复核，不冒充独立标注。")
    plan=ROOT/'docs/INSIGHTS_IMPLEMENTATION_PLAN.md';text=plan.read_text(encoding='utf-8')
    marker='<!-- HBM_ACCOUNTING_FINAL_RESULT_PENDING -->';assert text.count(marker)==1
    text=text.replace(marker,result)
    start=text.index('状态：',text.index('### 9.3 '));end=text.index('\n\n',start)
    text=text[:start]+(f"状态：最新末轮见 9.14。401/403 已确定为公共接口缺少所需授权；原生 HTTP 可用，但未观察到合格的跨题远端复用，含预热的整批耗时节省未达 10%，不采用候选。新冻结集 266 条/140 题，前五 {q['candidateCorrectAt5']}/40、最终 {q['selectedCorrect']}/40、无答案误选 {q['negativeFalseSelections']}/100；完整单题中位 {sec(timing['endToEndMs']['medianMs'])} 秒、P95 {sec(timing['endToEndMs']['p95Ms'])} 秒、最慢 {sec(timing['endToEndMs']['maxMs'])} 秒，长尾未消除。新题含真实笔记，仍为同家族出题/核验，非独立标注。全部预热已计成本。本轮后关闭耗时优化，已核对后端剩余关口，依次补齐原生同条件比较、生命周期、真实任务收益、Windows 运行时和 24 小时运行；HBM-00 整体未放行、后端待定，后续批次不扩展。旧失败和 9.7–9.13 证据保留，不用跨集合数字相减宣称收益。")+text[end:]
    text=text.replace('两候选均未通过实际复用关口，继续保留','两候选均未通过实际复用关口，继续保留')
    plan.write_text(text,encoding='utf-8')
    readme=ROOT/'qa/memory-selection/README.md'
    with readme.open('a',encoding='utf-8') as f:
        f.write('\n\n## 含预热成本与末轮耗时验收\n\n')
        f.write('本轮见原方案 9.14、`artifacts/hbm-00-accounting-20261018/`；源码为 `accounting_*.py`，运行根 `.local/hbm-00/accounting-20261018/`。公共 403/401 明确缺少模型读取/推理写入授权，未发送公共推理或重做 OAuth；原生 HTTP 有效，但无法证明代理后端跨题连接复用。两种节奏各两轮、每批 4 题，所有预热和最后无人使用的预热均计入，含思考间隔的墙钟和扣除间隔的墙钟分别记录。HTTP 处理 token 少约 32%，整批有效耗时只少约 2%–7%，未过预登记门槛。\n\n')
        f.write(f"新冻结 266 条/140 题（40 正例、100 负例；其中 20 道正例取自 10 篇真实笔记），前五 {q['candidateCorrectAt5']}/40、最终 {q['selectedCorrect']}/40、无答案误选 {q['negativeFalseSelections']}/100。完整单题中位 {sec(timing['endToEndMs']['medianMs'])} 秒、P95 {sec(timing['endToEndMs']['p95Ms'])} 秒、最慢 {sec(timing['endToEndMs']['maxMs'])} 秒。全部 194 次正式调用加 176 次预热共 370 响应、2,466,644 处理 token，不是账单金额。来源/核验同模型家族，非独立标注；零/100 的 IID 单侧 95% 上界约 2.95%，构造样本相关性限制外推。40 正例原始检索均为第 1 名，原始检索尾部覆盖不足；15 题被轮换呈现到第 4/5 位只验证核验位置稳健性。\n\n")
        f.write('按 `method → 新资料与题目 → review/build/freeze → evaluate（唯一一次）→ report → 成本/分层/原生阶段核对 → document/deliver` 顺序消费证据。已使用的身份禁止重跑模型或覆盖旧文件；离线汇总发生过先于摘要发布的失败，保留记录，未增加模型调用。原始排名与候选轮换位置必须分别报告。当前耗时优化已关闭，后续只补 HBM-00 后端同条件比较、更新删除恢复、20 项任务收益、受管理安装运行时和 24 小时稳定性等关口；后端待定，生产代码及后续批次未变。\n')
    print('Updated existing implementation plan section 9.14, current status and QA index.')
