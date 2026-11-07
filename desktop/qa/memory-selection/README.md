# HBM-00 隔离选型实验

实施范围、阈值和当前结论以 [现有方案第 9 节](../../docs/INSIGHTS_IMPLEMENTATION_PLAN.md#9-hbm-修订实施合同2026-10-18-用户确认) 为准。本目录不是生产记忆接入，也不含用户个人资料库副本。

`corpus.json` 是冻结输入：20 条已接受的方案正文、8 条合成反例、60 个检索问题以及预留的 20 个生成任务。`prepare_corpus.py` 只用于建立新实验输入，不能在已有实验身份下重新生成语料。当前输入身份和全部原始回执在 `artifacts/hbm-00-20261018/`；第一轮未通过召回门槛，生成效果、生命周期和 24 小时关口没有执行。

入口各自的用途：

- `run.py`：实际 stdio MCP 的 `smoke`、`benchmark`、`soak`；显式 `--mode text|hybrid`。创建自己的 `.local/hbm-00/` 配置、文件与索引，不读取默认 Basic Memory 项目。协议初始化之后还检查索引就绪；结束检查登记的进程树。
- `native_vector.py`：同一中文模型的 SQLite/sqlite-vec Python 原型；先读取实际 Hub 原生结果以形成混合排名，不代表 Rust 生产能力。
- `summarize.py`：汇总具备就绪证明的有效结果，保留未验证关口；不根据文件是否存在宣布通过。
- 原生 `agent_work::memory_selection_tests::native_sqlite_tantivy_memory_selection`：调用现有 Hub 数据库、Tantivy 和 EvidenceReader；经 `scripts/test-rust.mjs` 显式选择 `--exact --ignored`，输出位置由 `HUB_MEMORY_SELECTION_NATIVE_REPORT` 指定。

本机实验 Python 为 `.local/hbm-00/runtime/Scripts/python.exe`，固定版本见 `requirements.freeze.txt`。需要 Python 3.12，未纳入应用安装包。中文模型为 `BAAI/bge-small-zh-v1.5`，必须显式设置 512 维；首次使用会产生模型下载。不能对已有 384 维索引静默改维度。配置、阈值、目录和模型变更必须建立新实验身份，保留旧失败，不覆盖原回执。

`soak --seconds 300` 仅是短观察；默认 86400 秒也只有实际运行完才具备 24 小时证据。当前没有持久后台任务。主窗口不阻塞、安装包管理、真实模型注入、遗忘与恢复、个人资料规模和长期稳定性均需单独通过，不能由本检索实验推断。

HBM-01A 的三个真实模型场景另见 `artifacts/hbm-01a-20261018/verification.json`；它们用于基本交付修复，不计作记忆带来的收益。

## 低召回诊断与复测

当前诊断结果和边界见原实施方案 9.8 与 `artifacts/hbm-00-diagnostics-20261018/summary.json`，后端仍待定。保持原语料和期望 ID；新增合同、输入和结果另存，没有覆盖第一轮。

`diagnose.py` 先冻结合同，再运行分词/布尔、同权重排名/阈值、查询前缀和另一嵌入模型的对照。`query_policy.py` 只接收问题，不读取语料或答案；`normalize_queries.py` 的一次工具禁用模型调用同样不接收知识库或期望条目。原生测试可通过 `HUB_MEMORY_SELECTION_QUERIES` 显式选择冻结查询文件；空关键词必须放弃，不能退化为浏览全库。

`diagnose_mcp.py` 新建独立 Basic Memory 配置和项目，等待索引后经过真实 MCP 验证各查询策略。`diagnose_admission.py` 保留词面校准/改写验证的失败。`diagnose_rerank.py` 对真实 MCP 候选做一次本地重排和固定分组校准；`diagnose_rerank5.py` 只缩小候选量，沿用该政策，不重拟合。`diagnose_report.py` 核对输入身份、60 问覆盖、原生回执、退出状态和上一批生产源码身份，再汇总结果。

新模型、索引、词典缓存和中间进度属于 `.local/hbm-00/diagnostics-20261018/` 及既有受管模型缓存。单次结果拒绝覆盖；重跑需新实验身份，不能通过删除失败或改变答案提高成绩。直接向量计时是批均值，重排/MCP 计时分别测量，均不能冒充安装服务端到端 P95。原始前五召回、重排后排名和最终准入成绩分别解释；本轮仍未通过全部检索门槛。

## 适用性与新冻结集

本轮见原方案 9.9 和 `artifacts/hbm-00-applicability-20261018/summary.json`。新集合的 40 个正例与 40 个无答案题通过质量门槛，HBM-00 整体和后端选型仍开放。不要把此成绩覆盖旧失败，也不要把不同题集的召回数字直接相减。

`applicability_policy.py` 是通用对象/属性/条件/时间核验及原文校验；不含题目或答案映射。`applicability_fixture.py` 先冻结政策，再构建带新虚构项目的语料、生成新题、审阅并冻结。`applicability_support.py` 只提供有界、工具关闭的真实模型测试调用；模型响应不授予权限。

`applicability_evaluate.py` 分别执行真实 MCP 取候选、上一轮固定重排对照和新语义判定。按项目分批，最多 8 题，禁止把其它项目、标准答案或出题备注拼入核验输入。`applicability_controls_test.py` 验证机械边界；`applicability_report.py` 在全部执行后对未改标签的集合计分，核验源码/输入身份及退出，不进行阈值拟合。

运行证据只写新的受管目录；结果与冻结合同拒绝覆盖。相同模型家族出题/判断、合成小样本和批处理的限制必须随成绩说明。当前响应使用已有测试适配器，不证明 DeepSeek 已适配或达到相同效果。调用成本与单条交互时延、真实资料、多记忆任务、长期运行和生产接入需另外验证。

## 检索难题、跨模型与单题完整计时

本轮见原方案 9.10 和 `artifacts/hbm-00-independent-20261018/summary.json`。124 条记录、80 道全新冻结题，包含较长工作记录、附近对象/编号干扰与口语问法。前 5 候选覆盖 34/40（85%），前 20 覆盖 39/40（97.5%）；最终选择 39/40，40 个无答案题误选为 0。唯一漏答在检索层，正确依据未进入前 20，不是核验器拒绝了已经找到的依据。本轮没有针对题目调整候选量、模型政策、索引或查询。

Claude 未登录、Gemini 当前客户端不可用，用户明确要求先使用 Codex，因此实际固定 `gpt-6-astra` / medium，区别于上轮 `gpt-6.1-sol` / high；不能据此宣称厂商或训练独立性。新题由主 Agent 编写并审阅，不构成独立真人标注，仍未采用个人资料库。旧失败、旧结果和两个入口的失败均保留。

`independent_fixture.py` 固定方法、构造、审阅并冻结输入；`independent_evaluate.py` 固定执行源码和生产源码身份，再通过新的实际 MCP 索引逐题运行；`independent_support.py` 提供隔离的有界调用；`independent_gemini.py` 仅保留不可用入口的协议探测；`independent_report.py` 核对输入盲化、正文、退出与源码身份，再计分，不调参。顺序为 `policy → build → freeze → execution freeze → run → report`；当前日期身份已使用，脚本拒绝覆盖既有证据，再执行必须另建实验身份。

80 次实际单题完整选择链路中位 11.247 秒、P95 15.998 秒；单独检索中位 0.125 秒、P95 0.582 秒。每题都新建模型 CLI 进程，完整计时包含准备、网络等待及原文核验，不能当作未来持久 API 的性能。新服务和新索引准备另计，不包含最终答案生成或已安装 UI。既有热检索 1 秒门槛与完整选择链路的 1 秒参考是两个指标。

全部题目单次完成，冻结后政策、标签及执行源码未变，124 份正文与 814 个生产文件身份核对通过，登记进程已退出；HBM-00 整体仍未放行，后端待定，后续批次未扩展。更完整的来源、成本、性能和数据偏差随原方案 9.10 一起消费，不能只引用最终 97.5% 与零误选。

## 长文根因、前五召回与极高档位复测

最新结果见原方案 9.11 与 `artifacts/hbm-00-passages-20261018/summary.json`。实际旧索引证实漏检长记录完整进入嵌入窗口、向量正常，但多话题合成一个向量使它排在第 32；保持其它条件不变，只按原文段落表示即可升到第 1。该条并非 token 截断；字符分块与模型 token 限制不一致仍是其它长文的一般风险。

`passage_diagnose.py` 保留实际数据库审计与单条控制实验；`passage_index.py` 提供隔离的 token 分段、真实 Basic Memory MCP 候选、中文 FTS5/jieba 与固定 RRF 融合。它未修改 Basic Memory 包，也不是 Hub 生产 Tantivy 接入。先用已公开的旧集一次比较三种方法，再由 `passage_run.py method` 固定选择；`passage_fixture.py` 随后创建并冻结全新集合，`passage_run.py evaluate` 只运行一次，`passage_report.py` 按预先固定的身份与规则核验计分，不调参。

正式资料共 152 条、80 道新题（40 有答案、40 无答案），最大正例正文 751 tokens，12 个正例依据位于第 512 token 之后。固定分段向量与词法融合，最多 80 个原始分段归并到父记忆，最终仅 5 条；核验读取完整规范正文并检查来源哈希、范围/状态及精确引文。前五覆盖 40/40、最终选对 40/40、无答案误选 0/40，原文/协议错误与范围/状态违规均为 0。没有在正式题上调方法或修改标签。

所有 92 次新模型调用固定 `gpt-6.1-sol` / `xhigh（极高）`，不使用 Astra；`passage_model.py` 仅对单次实验设置精简指令，不改全局配置。同输入开发对照减少约 28% 输入 tokens，但未证明稳定提速；新集逐题完整链路中位 11.586 秒、P95 15.841 秒，热检索 P95 0.154 秒。每题均新建模型 CLI，不能当作未来持久 API 的性能。新服务到 209 个分段就绪共 74.641 秒，已含协议初始化 11.840 秒，另保留首次开发初始化超时；后一次成功不证明启动故障已修复。

`verification-final.json` 核对 152 份正文、80 份盲化输入/原始输出、冻结方法及退出；`passage_delivery.py` 单独核对 814 个生产文件身份并保存文档交付回执。运行与索引归 `.local/hbm-00/passages-20261018/` 所有，旧失败和旧证据不覆盖。新集仍为同模型家族编写/判定的合成小样本，40 个正例仅对应 20 条新记录，不构成独立真人标注或个人资料规模证明。只通过本集合质量和热检索门槛，单题等待、原生后端同条件比较、真实任务收益、生命周期、安装服务及 24 小时观察仍开放；HBM-00 整体未放行，后端待定，未扩展后续批次。

## 单题归因与持久调用

最新见原方案 9.12 与 `artifacts/hbm-00-latency-20261018/summary.json`。所有新题级调用固定 `gpt-6.1-sol / xhigh`。仅在隔离 QA 中比较每题新 CLI、每题新 App Server、常驻 App Server 每题独立临时会话；原生 JSON schema 来自实际安装版本。12 道旧题的 36 次轮换对照中位分别为 8.629、8.621、7.078 秒；常驻方式逐题节省中位 12.8%，10/12 更快，满足事先固定的选择门槛。分类输入文本哈希相同，工具的目录元数据相差约 2–6 tokens，远端缓存命中不受控；不把全部收益归因于纯进程创建或宣称统计稳定性。

`latency_transport.py` 记录进程/初始化/会话/首个可观察推理项/首个答案/完成边界，并提供本机允许字段 OTel 诊断，不导出认证值、用户信息或提示正文。4 次归因探针观察到每题 WebSocket 建连约 0.585–1.253 秒，之后预热与当题请求复用该连接；跨题远端连接仍未复用。请求到接收完成仍混合网络、排队、预填充与隐藏推理，没有服务端计时就不能拆成纯推理占比。`latency_reuse.py` 检查有条件的持久会话方案，因实际落盘路径超出实验根，在模型调用前拒绝继续并归档新建空会话；此模式未获得收益证据。

`latency_evaluate.py method` 在开发比较后固定方法，随后 `latency_new_cases.py` 才编写新事实，`latency_fixture.py` 构建并冻结；`latency_evaluate.py evaluate` 只执行一次，`latency_report.py` 按预先固定身份与规则计分，`latency_deliver.py` 单独核对退出、旧证据、生产文件、调用预算与交付。180 条记录、80 道新冻结题，40 个正例与 40 个无答案题；前五与最终召回均 40/40，误选 0/40，协议/引文与范围/状态错误均为 0。正文最长 577 tokens，18 个正例依据在第 512 token 后；40 个正例只对应 20 条新记录，仍为同模型家族编写/判定的合成小样本。

正式完整单题链路中位 7.488 秒、P95 12.878 秒、最慢 25.883 秒；核验调用中位 7.348 秒，检索 P95 0.135 秒。正式索引准备 101.503 秒已含 MCP 初始化 18.237 秒，Codex 初始化另计 0.222 秒；实验 Codex 元数据首次准备约 37 秒，后续复用同一状态，不反复初始化空状态制造收益。所有失败、初版诊断收集器错误与准备超时保留，没有在正式题上调参、改标签或重试。回执 token 仅为题级用量，不能当作含预热的完整账单。只通过本合成集合质量和此规模热检索关口，长尾、真实资料、原生同条件比较、安装服务、生命周期与 24 小时仍开放；HBM-00 整体未放行，后端待定，生产代码和后续批次未改。

## 跨题远端连接与慢尾

本轮见原方案 9.13 和 `artifacts/hbm-00-connection-20261018/`，运行根为 `.local/hbm-00/connection-20261018/`。仅对实验子进程设置全新的 `CODEX_HOME`、SQLite 与临时目录；核对初始化返回的实际目录后，在内存中经原生外部认证协议使用现有登录，不复制认证文件或修改用户已有会话。所有新题级调用仍为 `gpt-6.1-sol / xhigh`，不定后端、不扩展后续批次。

`connection_preflight.py` 检查清空历史后的语义隔离；`connection_continuity.py` 的两次普通连续回合只用一条远端连接，但保留历史，不能作为独立核验方案。`connection_develop.py` 固定 12 道旧题、两轮 AB/BA，共 48 次同进程同题调用。实际独立会话建连 24 次，清空历史方案建连 25 次；13 次后者建连发生在自身调用边界外且与基线窗口重叠。表面更短的调用等待不能当作连接复用或总成本节省，维持独立临时会话基线。

**开发结论以 `development-audit.json` 为准。** 初版 `development.json` 误读本机 OTel 的 `timeUnixNano=0`，漏计连接；方法冻结检查已拦截，初版保留供追查。`connection_development_audit.py` 使用实际 `event.timestamp` 和会话身份重归属，`connection_mechanism.py` 记录跨边界预热；没有重跑开发题。`connection_direct_probe.py` 的公共 WebSocket 握手返回 401，`connection_public_access.py` 的公共模型列表返回 403，未获得成功推理调用，也未走私有接口或付费密钥替代路线。

`connection_phases.py` 将旧最长题的原生客户端和宿主时钟对齐，约 23.219 秒发生在正式请求构造标记与首个原生输出之间；原生到宿主读到该项只差约 0.15 毫秒，不能归为测试端读日志卡住。没有服务端阶段计时就不能分成纯网络、排队、预填充和推理。`connection_context_audit.py` 同时保留跨轮上下文差异：同一分类输入的新原生输入比旧轮少 2070 tokens，不能用慢题重跑更快证明根因消除。`connection_final_phases.py` 只在整轮完成后补充同题和新慢题的关联，不改计分。

`connection_evaluate.py method` 在有效开发核对后冻结方法，随后 `connection_new_cases.py` 才编写新事实；`connection_fixture.py` 构建、审阅并冻结，`connection_evaluate.py evaluate` 只完整执行一次，`connection_report.py` 按预先冻结的源码和评分规则检查。新集合共 208 条、356 分段、80 题（40 正例、40 无答案），最长正文 718 tokens、8 道正例依据在 512 token 之后；前五和最终召回均 40/40，无答案误选 0/40，引文/协议及范围/状态错误为 0，达到本集合质量要求。仍是同模型家族编写/判定的合成小样本，每题最多五份完整规范正文；本轮复测的是保留的基线，不宣称连接优化成功。

完整单题链路中位 7.961 秒、P95 10.922 秒、最慢 15.044 秒；热检索 P95 0.136 秒。首题会话建立 2.583 秒已包含在该题总时间中，排除首题后的完整链路中位 7.947 秒，不能只报原生初始化 0.172 秒便掩盖首次会话准备。新索引就绪 120.637 秒已含 MCP 初始化 11.182 秒，正式整轮约 13.28 分钟。40 个实际正例引文均含冻结支持事实；208 份规范正文、80 份输入/输出、冻结方法及全部登记的模型父进程/MCP 退出检查通过，814 个生产文件未变，凭据扫描未发现落盘。题级用量不等于包含预热的完整账单，未用新旧集合差值宣称提速。

所有日期身份均已使用；脚本拒绝覆盖，勿删除失败后重跑。生产源码、旧证据和后端决定的最终核对由 `connection_deliver.py` 单独记录，HBM-00 整体继续开放。


## 含预热成本与末轮耗时验收

本轮见原方案 9.14、`artifacts/hbm-00-accounting-20261018/`；源码为 `accounting_*.py`，运行根 `.local/hbm-00/accounting-20261018/`。公共 403/401 明确缺少模型读取/推理写入授权，未发送公共推理或重做 OAuth；原生 HTTP 有效，但无法证明代理后端跨题连接复用。两种节奏各两轮、每批 4 题，所有预热和最后无人使用的预热均计入，含思考间隔的墙钟和扣除间隔的墙钟分别记录。HTTP 处理 token 少约 32%，整批有效耗时只少约 2%–7%，未过预登记门槛。

新冻结 266 条/140 题（40 正例、100 负例；其中 20 道正例取自 10 篇真实笔记），前五 40/40、最终 40/40、无答案误选 0/100。完整单题中位 7.705 秒、P95 11.928 秒、最慢 92.189 秒。全部 194 次正式调用加 176 次预热共 370 响应、2,466,644 处理 token，不是账单金额。来源/核验同模型家族，非独立标注；零/100 的 IID 单侧 95% 上界约 2.95%，构造样本相关性限制外推。40 正例原始检索均为第 1 名，原始检索尾部覆盖不足；15 题被轮换呈现到第 4/5 位只验证核验位置稳健性。

按 `method → 新资料与题目 → review/build/freeze → evaluate（唯一一次）→ report → 成本/分层/原生阶段核对 → document/deliver` 顺序消费证据。已使用的身份禁止重跑模型或覆盖旧文件；离线汇总发生过先于摘要发布的失败，保留记录，未增加模型调用。原始排名与候选轮换位置必须分别报告。当前耗时优化已关闭，后续只补 HBM-00 后端同条件比较、更新删除恢复、20 项任务收益、受管理安装运行时和 24 小时稳定性等关口；后端待定，生产代码及后续批次未变。

## 原生与 Basic Memory 同条件组件对照

本轮真源见实施合同 9.15，完整证据在 `artifacts/hbm-00-parity-20261018c/complete-round.json`。56 篇真实全文、24 正例＋100 负例标签；一条负例歧义在检索前登记，另列 99 分母。前五 20/24、前二十 24/24，来源 ID 16/24、严格锚点 13/24，无答案 1/100（1/99）；两边候选与核验输入逐题相同。真实原始排名 7、8、15、19 的四题补足尾部覆盖。

原生为实际 SQLite/Tantivy/EvidenceReader 加 Python 向量原型，BM 为真实本地 MCP 向量服务；共同语义输入由 BM 解析导出，共同向量逐分量一致，不是独立生产部署/独立解析器比较。共用词法适配将自然语言词项空格相连送入默认 AND 接口，24 个正例词法支路全空；不能把本轮冒充完整混合链准入。另有等义金标过窄、证据片段丢失和来源身份裁剪问题，保留冻结评分，不在本集修参数重跑。

`parity-20261018` 保存首次抽样不足及预检；`parity-20261018b` 保存两次准备超时、原生夹具超时及源版本；修订身份 `parity-20261018c` 只修准备事务、换行校验、显式向量完成，保持 corpus/validation/评分/查询字节或函数身份。先 `parity_corrected.py register → backfill → freeze → evaluate`，模型阶段完成后才 `parity_report.py → parity_deliver.py → parity_semantic_audit.py → parity_complete.py → parity_document.py`。已用身份只读，不得原地重跑或覆盖；这些入口依赖本机已登记 runtime/cache 与先前证据，不是产品安装入口。

所有实际远端调用为 GPT-6.1 Sol/xhigh，含预检和预热全量计费代理口径，旧失败成本也保留；源库一篇 MOC 在运行中改变，冻结副本和正例原件保持一致，变化归因未知。原生批量夹具仍通过同一生产 upsert，查询后半段不变；无业务记忆集成、后端采用或后续批次。

## 共用查询与证据修复的新冻结复测

本轮真源见实施合同 9.16，证据 `artifacts/hbm-00-grounding-20261018c/summary.json`。44 篇完整真实笔记、24 正例＋100 负例；前五 24/24（100.0%），事实核验 22/24（91.7%），无答案误选 0/100，两边结果相同。质量数字达标，但实际检索尾部条件不足（仅3题非首名、无前五外），且仍有来源定位和后续段落遗漏，不可放行选型。标签先于首次检索冻结，只跑一次；不根据验证题调参。

方法与评分从第一次准备起冻结；前两次窄目录抽样不足，保持机制不变后扩大资格资料池，机器先按字节/长度统计，不应把 C 回执笼统的 `newSourcesOrQuestionsRead:false` 解释为程序完全没读过原文。作者在 C 方法冻结后才读取新正文和出题。失败和回执借用见 `inventory-amendment.json`，开发调用只计一次。

执行入口 `grounding_run.py evaluate` 原始状态保留 `failed`：固定248次用量完成的关闭检查超时；实际247次发送已逐项配对247次完成，其中123次预热。先 `grounding_close.py contract → reconcile → report → audit` 在看质量前核账，再调用冻结的评分函数生成结果；没有新模型调用，也未改原始状态。最后 `grounding_diagnose.py → grounding_document.py`，见 `closure-audit.json`。已用身份禁止原地重跑或覆盖。

显式 OR 兼容真实 Hub 默认 AND 查询合同；完整父笔记回读、中文本地交叉编码器及原文段落展开是两边共用层，不是某后端独有收益。保留出处/正文哈希/标题/偏移，断续引文不能拼接，来源文本不等于用户事实。候选上限 6,000 BGE token，尚未验证能在生产决定预算 2,000 模型 token 内达到同样效果，需独立验收成本与生产适配。原生仍为 Python 向量原型、BM 解析仍为共同表示，未选择后端、未变更生产业务或扩展批次。


### 有界验收与后端关口

`qualification_contract.py` 在运行前登记分段性能、正式预算、40＋100 新验收及一次修复上限；旧题全部只作开发材料。后端生命周期、实际 Rust 嵌入、运行时分发与真实 24 小时验收口径见实施方案 9.17。原 grounding 原始失败及评分保持不变。


### 有界验收结果与运行维护取证（2026-10-18）

本轮新集 40 正例＋100 负例已完成，固定 GPT-6.1 Sol/xhigh。前五 39/40、事实核心 37/40、无答案误选 1/100；初始排名 6–20 仅 2 题，未达到 8 题配额，整体未通过。失败中的两项存在标签/等义来源问题，保留冻结分数，不事后改成达标。所有新题转开发材料，本轮不追加质量重跑。正式 280 次发送与 280 份用量闭合；含开发调用的全轮成本仍有 1 次未知，详见实施方案 9.17.2。

运行证据位于 `artifacts/hbm-00-qualification-20261018`：`rust-runtime-probe.json` 是实际 Rust 嵌入组件的 5 次启动及同权重向量验证，不是完整原生后端。BM 已迁移到受管理 Python，100 篇/5,100 块初次索引完成，5 次新进程首次可用均在 10 秒内；第一次更新的索引就绪超出 5 秒，`bm-lifecycle-result.json` 保持失败。关闭后已收敛到新版本，不能据此撤销时限失败。删除、替代、恢复和 24 小时尚未执行。

`qualification_operational_audit.py` 和 `qualification_bm_failure_diagnosis.py` 只读取已有回执、日志和数据库，输出 `operational-audit.json` 与 `bm-lifecycle-failure-diagnosis.json`；本次已运行，不得覆盖已有身份重跑。Rust/BM 部分组件通过不能替代完整双后端对照。生产 Cargo 与冻结质量方法未变，拥有进程均已退出；后端待定，后续批次未开始。


### 生命周期同负载对照与BM更新修复

证据位于 `artifacts/hbm-00-lifecycle-20261018`，方法 `formal-method-v2.json`，结果 `bm-formal-v2-result.json`、`native-formal-v2-result.json`、`summary.json`。BM同步提交批次2→32，其余诊断变量固定；正式140步均未超5秒，但8次更新检索未命中，保留52/60严格评分。两边20删除、20替代、迁移后恢复已验证；真实24小时和崩溃恢复未验证。候选项目过滤次序不同，不能冒充逐项候选等价或后端选型结论。

本机专用入口 `lifecycle_support.py` → `lifecycle_bm.py`（A/B）→ `lifecycle_formal_v2.py freeze|bm|native` → `lifecycle_report.py` → `lifecycle_retrieval_diagnosis.py` → `lifecycle_document.py`。已有身份均已使用，禁止直接原地重跑；另有已保留失败的preflight/canary/v1。实际Rust入口是 `agent_work::memory_lifecycle_tests::native_lifecycle_rpc`，仅测试编译，依赖已验证的本机运行时和嵌入组件，不是安装入口。所有新报告独占创建，原评分不覆盖；只读诊断结果不能回填冻结评分。细节与范围见实施方案9.18.1。


### 更新可靠性有界诊断（2026-10-19）

`update_reliability.py` 和 `update_reliability_minimal.py` 两次观察器运行已结束且保留失败：查询前快照仍有明显延迟，最终分别在011和008丢失全部51个目标块、60秒未收敛。`update_reliability_fix.py` 只试受支持的 `index_changes=false`，去掉查询前捕获，20次首次实际查询通过，重复写入严格即时检查11/20，未修复可靠性。`update_reliability_stage_audit.py` 仅离线核对20份真实快照的物理向量、排名、过滤和检索记录；`update_reliability_deliver.py` 汇总并保留全部旧分数。初拟 `update_reliability_diagnose.py` 未执行，不是验证证据。所有身份已使用，禁止原地重跑覆盖。结论和限制见实施方案9.19与 `artifacts/hbm-00-update-reliability-20261019/conclusion.json`。本轮没有新质量验证、正式后端集成、崩溃注入或24小时任务。


### 原生崩溃恢复与24小时观察

`native_recovery.py` 使用唯一已收集的测试入口，在完整种子副本上注入7个真实进程终止，实际通过 7/7。`native_soak.py register` 只在恢复全部通过后冻结合同；`run` 独占创建 `run.started`，运行真实24小时，进度文件不能代替 `soak-result.json`。`native_recovery_document.py` 只发布已观察的状态。上述身份不可原地重跑覆盖。

运行目录 `.local/hbm-00/lifecycle-20261018/recovery-20261019`；证据 `artifacts/hbm-00-native-recovery-20261019`。后台只使用拥有的PID及创建时间识别，`soak/STOP` 请求停止；不得按进程名称批量终止。详情及证据边界见实施方案9.20。24小时任务已启动，目前状态 `running`，已记录 1 个采样点；测量起点 `2026-10-18T16:34:25.403672+00:00`。这是启动/进度回执，不是24小时通过结论。


### 提交失败后的生产索引恢复验证

`native_commit_recovery_verify.py freeze|run` 本机身份已使用，禁止原地重跑。contract保留初版，method-amendment记录取消错误前缀修正，executed-driver记录实际驱动；最终源码和二进制由delivery核账。7项 `search_index_runtime::tests::` 通过；同一二进制在完整故障副本上自动恢复，再验证10次重复更新、删除/重建及重启。原失败与人工恢复探针不改分，详见实施方案9.24。尚无新24小时结果。


### 修复版第二轮24小时

`native_soak_v2.py register|run` 复用冻结工作负载，只改运行身份与已验证二进制绑定；该身份已使用，不得原地重跑。报告 `artifacts/hbm-00-native-soak-v2-20261019`，工作目录原recovery根下 `soak-v2`。监控以新目录run.started和progress的PID/创建时间为准，STOP只作用于新目录。旧24小时失败保留；通过必须消费最终回执而非启动进度。详情见实施方案9.25。


### 第三轮长期分段记录

`native_soak_v3.py register|preflight|run` 身份已使用，禁止原地重跑。沿用原长测驱动和修复版二进制，仅替换write/delete观察器为显式消费完成响应并持久分段记录；总回执后时限包含记录开销。报告 `artifacts/hbm-00-native-soak-v3-20261019`，工作根recovery目录下 `soak-v3`，phases与cycles按operationId关联。4项预检独立于正式时长；最终以soak-result及合同核账，不能把阶段记录当通过。详见实施方案9.27。


- `native_tail_v3_diagnosis.py`：第三轮尾部一次固定双副本顺序对照，身份已消费；报告 `hbm-00-native-tail-v3-20261019`。不原地重跑。原始chunks字段为笔记分组数，更正见conclusion.json；完整5100向量只读核实。

- `native_stage_diagnosis.py`：一次固定12项索引内部诊断；身份 `hbm-00-native-stage-diag-20261019` 已消费，不原地重跑。依赖保存的测试诊断二进制；临时源码已还原，探针/源文件快照及哈希见报告。嵌套跨度不相加，进程I/O不等于磁盘延迟；不替代原长期失败。


- `native_commit_wait_diagnosis.py` / `native_commit_wait_user_capture.py`：提交prepare/publish拆分的单次12项诊断，身份 `hbm-00-native-commit-wait-20261019` 已消费，不原地重跑。WPR wrapper启动被系统拒绝且未运行负载；随后预登记用户态替代。`native_wait_stack.py`有实际2.483秒原生栈展开停顿，100ms检查不是硬超时，禁止当低干扰采样复用。`native_commit_wait_analyze.py`仅离线分析已有证据。原5秒评分11/12，不扣采样耗时；历史根因未确定。源码恢复/进程退出/证据边界见方案9.31和报告。


- `native_worker_probe_setup.py` / `native_worker_probe_run.py`：身份 `hbm-00-native-worker-20261019` 已消费，不原地重跑。一次离线构建、off/on完整副本各12项，采用隔离Tantivy副本内存事件，全部测量后才输出；源码/Cargo.toml/Cargo.lock已精确恢复，不改全局registry。`native_worker_probe_analyze.py`为离线分析；critical-worker.json按同线程/包含区间过滤，避免后台合并混入。事件结束记录成本不等于完整探针开销，关闭/开启非随机顺序不证明优化。原历史失败和门槛保持，见方案9.32及conclusion.json。


- `native_file_probe_setup.py` / `native_file_probe_run.py`：身份 `hbm-00-native-file-20261019` 已消费，禁止原地重跑。隔离Tantivy副本计时文件创建、managed锁/保存、write/flush/sync和原子替换；同程序off/on各12项，事件仅内存、close输出。`native_file_probe_analyze.py` / `native_file_boundaries.py`只分析既有证据；own-file-sync-analysis通过唯一文件身份关联辅助store同步，跨线程成本不与墙钟相加。源码/配置精确恢复，全局registry未改。原长测失败不改判，详见方案9.33及conclusion.json。
