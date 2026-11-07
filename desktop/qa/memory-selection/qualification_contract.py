"""HBM-00 bounded qualification contract. Old experiments remain immutable."""
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
WORK = ROOT / '.local/hbm-00/qualification-20261018'
REPORTS = ROOT / 'artifacts/hbm-00-qualification-20261018'
OLD = ROOT / 'artifacts/hbm-00-grounding-20261018c'
MODEL, EFFORT = 'gpt-6.1-sol', 'xhigh'

def now():
    return datetime.now(timezone.utc).isoformat()

def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()

def save(name, value):
    with (REPORTS / name).open('x', encoding='utf-8') as f:
        json.dump(value, f, ensure_ascii=False, indent=2)
        f.write('\n')

def read(name, root=REPORTS):
    return json.loads((root / name).read_text(encoding='utf-8'))

def register():
    WORK.mkdir(parents=True, exist_ok=False)
    REPORTS.mkdir(parents=True, exist_ok=False)
    for p in ['tmp', 'codex-home', 'shared-cwd', 'document-before']:
        (WORK / p).mkdir()
    paths = ['docs/INSIGHTS_IMPLEMENTATION_PLAN.md', 'docs/AGENTS_ROADMAP.md',
             'qa/memory-selection/README.md', 'qa/memory-selection/grounding_index.py',
             'qa/memory-selection/grounding_run.py', 'qa/memory-selection/accounting_transport.py',
             'src-tauri/Cargo.toml', 'src-tauri/Cargo.lock']
    baseline = {}
    for rel in paths:
        path = ROOT / rel
        if path.exists():
            baseline[rel] = digest(path)
            (WORK / 'document-before' / path.name).write_bytes(path.read_bytes())
    cases = read('validation.json', OLD)['cases']
    profile_ids = [q['id'] for q in sorted(cases, key=lambda q: hashlib.sha256(q['id'].encode()).hexdigest())[:20]]
    save('scope-contract.json', {
        'registeredAt': now(), 'model': MODEL, 'effort': EFFORT,
        'root': str(ROOT), 'work': str(WORK), 'reports': str(REPORTS), 'baseline': baseline,
        'scope': 'HBM-00 only; isolated QA and canonical docs; no production/vault/config writes, backend adoption or later batches',
        'oldMaterial': 'ALL previously inspected questions and both prior failures are development only, including grounding C',
        'profile': {'sameInputIds': profile_ids, 'n': 20, 'order': 'sha256(question ID), fixed before profile',
            'stages': ['source_read_hash', 'query_terms_pair_selection', 'model_initialization', 'cross_encoder', 'evidence_pack', 'provenance_budget_check'],
            'separateQueryStages': ['lexical_query', 'vector_embedding_search', 'host_verification'],
            'target': 'Complete hot local retrieval P95<=1000ms; common resolver P95<=500ms; first model load separate, no remote-transport changes',
            'comparison': 'Same 20 inputs, no result-cache hits; before/after same processes/models/threads, cold initialization separately. Approximation changes are quality tradeoffs, never labelled equivalent optimization.'},
        'materialBudget': {'maxSources': 5, 'decisionTokensIncludingSources': 2000, 'ruleTokens': 2000, 'totalSharedTokens': 4000,
            'tokenizerGate': 'Use actual model counter if available. Otherwise report tokenizer identity, reserve>=25%, call it estimated; exact-budget gate stays open. Never call BGE tokens Sol tokens.',
            'integrity': 'Whole answer-bearing paragraph plus adjacent context; preserve subject, negation, heading and locator where budget allows; explicit omitted/incomplete flags; exact source offsets/hashes; no topic/ID-specific rules'},
        'acceptance': {'positive': 40, 'negative': 100, 'maxFormalRuns': 2,
            'initialRank6to20Minimum': 8, 'longFactsAfter1024BgeMinimum': 12,
            'negativeCategories': {'no_answer':20, 'subject_confusion':20, 'same_name_project':20, 'old_version':20, 'deleted':20},
            'rules': 'Method/scorer/sample protocol frozen before new question authoring; labels and all accepted source spans frozen before retrieval. No ranking-based replacement of questions. Coverage failure invalidates coverage claim; keep results.',
            'gates': {'candidateRecallAt5':0.90, 'finalFactRecall':0.90, 'selectedPrecision':0.80, 'negativeFalseSelections':0, 'scopeStateViolations':0},
            'statistics': 'Two-sided exact Clopper-Pearson95% for positive rates. Report point estimate AND interval; gate90% is point estimate unless lower bound>=90% explicitly achieved. Correlated authored questions are not independent population evidence. Negative0/100 one-sided95% upper=2.9513% under iid only.',
            'annotation': 'Primary Codex author and GPT-6.1 Sol/xhigh judge, same family, NOT independent human/vendor annotation',
            'failureClasses': ['retrieval_miss20', 'ranking_outside5', 'evidence_crop_or_budget', 'model_judgement', 'label_or_source_ambiguity', 'protocol_or_accounting'],
            'stopLoss': 'After first new acceptance, at most ONE general repair round and ONE fully new frozen retest. Thereafter proceed to operational backend comparison regardless; record unresolved quality gaps, never adopt a failing candidate.'},
        'backendContract': {'frozenBeforeTesting':True,
            'scale': {'wholeNotes':100, 'utf8BytesPerNoteMax':60000, 'targetSemanticChunks':5000, 'scope':'isolated representative gate, not full personal vault capacity proof'},
            'query': 'HotP95<=1s, same notes/queries/model/permissions/budget and independent processes. First index separate; no shared-resolution cache in arm timing.',
            'startup': '5 fresh processes per arm after resources installed; all first usable<=10s; first resource download/install separate; actual main-window responsiveness remains product acceptance.',
            'mutations': '20 updates,20 deletes,20 replacements: readback<=5s after acknowledgement; no stale/deleted/derived fact after restart/reindex. Retried mutations idempotent.',
            'recovery': 'Restart, interrupted-write/crash boundaries and backup/restore: source IDs/state/hash/count agree; no missing acknowledged write, no resurrected deletion, no project leakage.',
            'soak': 'REAL elapsed24h; 15min warmup then fixed1query/30s and1mutation/5min, RSSsample5s; total owned backend treeRSS<=1536MiB, end15min median<=1.10*first postwarm15min median, no process accumulation; owned tree closed with0residual.',
            'disk': 'Managed runtime+model+indices<=8GiB; free disk>=10GiB before running; every component reported without double counting shared files.',
            'runtime': 'Basic Memory exact AGPL license obligations, Python3.12+ managed installation/update/recovery, every prerelease dependency. Native route MUST execute same embedding weights in actual Rust runtime and measure DLL/model/binary bytes and fresh-process startup; Python fixture does not satisfy.',
            'selection': 'All mandatory gates verified before adopting. If quality close and both pass, prefer simpler installation/maintenance. Missing24h or Rust-runtime evidence=unverified, never default to native.'},
        'closureDefect': {'oldRawStatus':'failed', 'type':'TimeoutError in report drain only',
            'wrongExpected':248, 'actualSends':247, 'actualCompletions':247, 'questionCalls':124, 'logicalRows':248, 'prewarm':123,
            'cause':'One thread had two connection attempts and one real question send, no prewarm send. Fixed2*questionCount expected one nonexistent response.',
            'qualityUnaffected':'All question receipts/rows complete; each actual send reconciled to usage by native event timestamps before unchanged frozen scorer ran. Raw failure and offline closure audit preserved.',
            'newRule':'Finish after producer quiescence plus actual sent/completed reconciliation, not assumed warmups. Missing/duplicate response, missing question or late unmatched warmup must fail; include unused final warmup cost.'},
        'limits': {'profileSeconds':900, 'devModelCallsMax':6, 'ownedProcessTimeoutSeconds':120,
            'newDataRead':False, 'noRemoteLatencyOptimization':True, 'noSubagents':True},
        'evidenceRetention': 'Exclusive owned paths; preserve all failed runs and raw receipts; no recursive cleanup of user paths',
        'ci':'No Git repository/remote; scoped offline checks and exact native test, no broad suites'
    })
    section = '''

### 9.17 HBM-00 有界验收与后端关口修订（2026-10-18，运行前登记）

**当前状态。** 本节替代 9.16 的“下一步”安排，历史分数和失败不改。先修共同证据与核账，再按正式预算检验；质量验收设轮次上限，随后进入后端运行维护对照。后端待定，不扩 HBM-01B、02 或其他批次。模型固定 GPT-6.1 Sol、xhigh（极高）。工作与证据分别在 `.local/hbm-00/qualification-20261018/`、`artifacts/hbm-00-qualification-20261018/`，具体运行前合同为 `scope-contract.json`。

**开发与验收分开。** 9.16 两道失败题及此前所有看过的题，一律转为开发材料。通用修复保留命中完整段落及前后语境，识别跨段延续，同时保留主体、否定、标题与定位线索；不写题目、答案、笔记 ID 或专属词表分支。范围、状态和逐字来源核对继续生效。旧题只能证明缺口修复，不能证明新效果达标。

**先测后改。** 在旧集预先按题目 ID 哈希确定 20 个输入，比较前后保持输入、线程、模型和冷暖状态一致，禁止用命中结果缓存充当提速。分开记录证据回读及哈希、查询与候选组织、模型装载、重排推理、分段裁剪、出处和预算核对；词法查询、向量查询及远端判断另计。热本地完整检索 P95≤1 秒、共同证据处理 P95≤500 毫秒为预定目标；冷启动单列。改变候选数、重排器或上下文完整性属于质量取舍，不能冒充等价提速。本轮不重开远端连接优化。

**正式材料预算。** 相关决定最多 5 条，连来源共 2,000 模型 tokens；适用确认规则全量加载最多 2,000 tokens，共享部分合计最多 4,000，并计入产品原有总预算。不得再用 6,000 BGE tokens 代替。若 Sol 的准确计数不可用，明示实际估算器与至少 25% 余量，准确预算关口保持未验证，不宣称正式通过；不得静默裁掉答案或限定语来凑上限。

**新验收冻结。** 方法、裁剪、预算、评分和取样流程先冻结，再看新材料出题；全部标签、可接受来源及逐字证据在检索前冻结。固定 40 正例、100 负例；至少 8 正例（20%）的原始融合排名在 6–20，至少 12 正例（30%）的事实在原文 1,024 BGE tokens 之后。负例按无答案、主体混淆、同名项目、旧版本、已删除各 20 题；必须审查整个测试语料的替代答案。题目不得因排名不够难而事后替换。覆盖不足即不证明难题效果，结果仍保留。出题者为当前 Codex，判定为 Sol 极高，同模型家族，明确不是独立标注。

判定：Recall@5≥90%、事实核验召回≥90%、选择精度≥80%，无答案误选、越界和无效输出为 0。正例同时报告点估计与双侧精确 95% Clopper–Pearson 区间；40 题不是置信下界达到 90% 的保证，下界不足时只能称点估计达标。0/100 负例仅在独立同分布假设下对应单侧 95% 上界约 2.95%，构造题相关性需披露。失败逐项分为：前 20 漏检、前五排序、裁剪/预算遗漏、模型判断、标签/来源歧义、协议/核账，禁止事后改标签抹平失败。

**止损。** 首次新验收失败后最多再做一次通用修复，并用另一个全新冻结集作最后一次复测；此后无论通过与否，都结束共同质量调参，进入下列后端关口。质量缺口如实保留；进入比较不等于允许采用不达标后端，也不继续无限换题调参。

**后端比较方法提前冻结。** 同一隔离资料规模为 100 篇完整笔记、每篇≤60KB、语义块目标 5,000；固定题目、嵌入权重、权限与预算，独立进程，不把共用结果缓存计入后端收益。资源安装后各 5 次新鲜进程首次可用均≤10 秒；安装、下载、首次索引及窗口响应另列。各做 20 次更新、删除、替代，确认后≤5 秒回读正确；重启、重建后不得返回旧版、删除项或其派生摘要。故障中断、幂等重试、备份恢复要核对已确认写入、身份、状态、哈希与数量，不允许删除复活或串项目。

24 小时必须真实运行完：预热 15 分钟后，每 30 秒查询一次、每 5 分钟变更一次、每 5 秒采样；各后端自有进程树 RSS≤1,536MiB，最后 15 分钟中位数不超过最初预热后 15 分钟的 110%，进程不累积，退出遗留为 0。受管理运行时、模型和索引共≤8GiB，运行前可用磁盘≥10GiB。分别核验 Basic Memory 固定版本的 AGPL 分发要求、Python 3.12+ 携带及安装/更新/恢复、预发行依赖；原生组必须在真实 Rust 运行时执行同权重嵌入，并测二进制/DLL/模型体积和冷启动，不能拿现有 Python 原型替代。20 项真实任务记忆开关对照、至少 18 项有帮助且无记忆导致的关键事实错误等旧强制项继续保留。任一强制项未验证则不放行；两边均达标、效果接近时优先安装维护更简单者。

**上一轮结束核账异常的准确说明。** 原始 `evaluation.json` 的 `status=failed`、`drainErrorType=TimeoutError` 保留。报告收尾错误地等待 `2×124=248` 个带用量完成事件；实际为 124 次问题请求＋123 次预热＝247 次发送和 247 次完成。题 6 的原生时间线上出现两次连接尝试、一次问题发送，没有预热发送；不能虚构第 248 次推理或把缺失用量记作 0。124 个问题回执和两后端 248 行结果齐全，所有实际发送均按原生事件时间匹配用量，离线核账合同在评分前登记，随后调用未修改的冻结评分函数，故已出的 24/24、22/24、0/100 评分不受影响。它是收尾计数错误，不是回答丢失。下一轮改按生产者静止与实际发送/完成逐一闭合，并回归缺少完成、重复完成、延迟预热和最后无人使用的预热，不能仅套用旧离线补报工具。
'''
    plan = ROOT / 'docs/INSIGHTS_IMPLEMENTATION_PLAN.md'
    raw = plan.read_bytes()
    assert b'### 9.17 ' not in raw
    status = '状态：按 9.17 新合同推进证据完整性、正式预算和分段性能验证；新验收最多一轮修复后转后端关口。9.16 及此前全部题目转开发材料；历史分数保留但不再证明新效果。后端待定，HBM-00 整体未放行，不扩展后续批次。'
    text = raw.decode('utf-8')
    begin = text.index('状态：', text.index('### 9.3 '))
    end = text.index('\n', begin)
    changed = (text[:begin] + status + text[end:]).encode('utf-8') + section.encode('utf-8')
    plan.write_bytes(changed)
    assert plan.read_bytes() == changed
    roadmap = ROOT / 'docs/AGENTS_ROADMAP.md'
    old = roadmap.read_bytes()
    sentence = 'HBM-00 已修复隔离共用查询与证据层并完成新集复测；最新成绩、成本及仍未通过的关口见实施方案 9.16，后端仍待定，后续实施范围按原合同管理。'.encode('utf-8')
    assert old.count(sentence) == 1
    roadmap.write_bytes(old.replace(sentence, 'HBM-00 按实施方案 9.17 推进有界验收：旧题转开发材料，先验证证据、预算与性能，最多一轮修复后进入后端运行维护比较；后端待定，不扩后续批次。'.encode('utf-8')))
    readme = ROOT / 'qa/memory-selection/README.md'
    before = readme.read_bytes()
    readme.write_bytes(before + '\n\n### 有界验收与后端关口\n\n`qualification_contract.py` 在运行前登记分段性能、正式预算、40＋100 新验收及一次修复上限；旧题全部只作开发材料。后端生命周期、实际 Rust 嵌入、运行时分发与真实 24 小时验收口径见实施方案 9.17。原 grounding 原始失败及评分保持不变。\n'.encode('utf-8'))
    assert readme.read_bytes().startswith(before)
    save('plan-update.json', {'at':now(), 'files':{p:digest(ROOT/p) for p in paths[:3]}, 'oldRawEvaluationSha256':digest(OLD/'evaluation.json'), 'newDataRead':False})
    print('Registered contract and updated canonical plan9.17; no new material inspected.')

if __name__ == '__main__':
    register()
