# 云同步交付验证记录：0.16.237

> 2026-10-08 补充：后续修复、真实 OSS/WebDAV 迁移、手机网络切换、前台补同步和双端安装包见 [补充联调报告](CLOUD_SYNC_FOLLOWUP_0.16.237.md)。本文保留 2026-10-07 的历史结果与当时的验证边界。此前 Windows 隔离冷启动只核验了独立后端数据，未充分核验 WebView 存储隔离；后续已修复并以实际浏览器目录和原生调用重新验证。Android 阅读现采用用户选定的“打开或返回应用时自动补同步”，新正式包已完成保留数据升级与界面复核。真实滴答新任务来源链仍未实机资格化，详见补充报告。

日期：2026-10-07。目标验证、Windows 正式 portable 打包与隔离冷启动、Android APK 打包及真机保留数据升级与启动均已通过。真机视觉检查限于搜索列表、浏览入口、阅读空态和统一云设置；文章详情操作、后台同步、网络切换及个人云迁移全程不在已验证范围内。

## 本轮范围

| 范围 | 实现与边界 |
| --- | --- |
| S1：滴答来源恢复与清理保护 | 来源凭证绑定账号、任务、原始快照、当前正文和全部原附件库存。实际读取云端凭证、正文与原文件后，真实删除前再次读取当前来源并核对范围；旧成功记录不能授权新删除。`childIds`、`child_ids`、`children`、`childTasks`、`child_tasks` 任何存在的字段均须明确为空数组；来源解析结果必须恰好一个且身份一致。原有“稍后读”选择规则不变。 |
| S2：OSS/WebDAV 共享传输与全模块迁移 | 阅读正文、原附件、清单、来源凭证、资料库副本、设备日志和检查点使用当前活动服务。迁移复制与独立读回核验持久化并分批续行，原附件依赖闭包、完整对象范围与 WebDAV 可变闪卡快照均须重新验证，最终事务复核后才切换配置。失败保留原活动配置，旧云对象和历史保留。 |
| S3：设备与历史维护 | 显式设备列表、退休标记、长期离线恢复、已核验检查点和精确历史清理。用独立空数据库经正式合并重建并验证覆盖范围，保留删除事实、标签移除、全部复习事实、本机待同步修改和并发新增对象。历史清理不删除 blob、附件、来源凭证或 WebDAV 当前闪卡快照。维护进度有界、可续行，可明确释放本机暂存。 |

阅读云同步模块启用时，滴答来源清理默认关闭；仅关闭总开关或自动同步不会解除来源保护。关闭阅读云同步模块后，仍沿用原来已验证本地副本的采集与删除流程。手动来源核验本身不删除原项。

手机定位为阅读、状态和标签管理，支持查看设备/检查结果以及从云端恢复阅读记录；不提供资料库保存位置管理、设备退休、云检查点发布、云历史删除或滴答来源清理。记录恢复不等于原附件全部下载或整篇可离线。

明确排除：通用网页剪辑、Hub 独立添加链接/浏览器剪辑入口、可配置的滴答标签与清单组合规则、新端到端加密系统、AWS S3 适配及大文件分块续传。继续兼容已有旧加密快照读取；私有目录与 HTTPS 不等于端到端加密。

## 已完成的验证

### 前端

93 个不同目标用例已通过，前端生产构建已通过。首轮前端记录为 87 项中 85 项通过、2 项失败；后续设置与工作区定向运行分别通过 9 项和 6 项。不同目标用例按正式收集的用例身份去重，不能将重复运行的数量直接相加；工作区结果中的未选用例也不计为通过。

证据：首次 [frontend-results.json](../../.local/cloud-completion-20261007/frontend-results.json)、定向 [settings-results.json](../../.local/cloud-completion-20261007/settings-results.json) 与 [workspace-results.json](../../.local/cloud-completion-20261007/workspace-results.json)，以及 [生产构建记录](../../.local/cloud-completion-20261007/verification/frontend-build-1791382599534407700/result.json)。修正后的前端运行与构建记录摘要为 `db302878edd74d226448eb5753e8afa2a8b55315966e7aafa453486c17e85fd4`，记录中的 `sourcesStable` 为真。

### 正式后端目标收集与首轮

正式测试程序收集到 798 个测试身份，本轮选择其中 111 个目标身份；未运行全部 798 项。名单见 [rust-collected.json](../../.local/cloud-completion-20261007/rust-collected.json)，收集过程见 [正式收集记录](../../.local/cloud-completion-20261007/verification/collect-rust-1791384309106593700/result.json)。

| 首轮目标 | 已发生结果 |
| --- | --- |
| 阅读同步及附件相关 | 38 通过、4 失败、1 忽略；被忽略的真实 OSS 用例随后单独执行并通过。 |
| 云策略 | 7 通过，按正式身份分别执行。 |
| 阅读网络策略 | 5 通过。 |
| S3 维护 | 5 通过、1 失败。 |
| 闪卡 OSS 同步 | 14 通过。 |
| S2 迁移 | 2 通过、4 失败。 |
| 滴答阅读 | 19 通过。 |
| S1 来源恢复 | 6 通过。 |
| 隔离运行环境 | 2 通过。 |
| WebDAV 及损坏快照 | 2＋1 通过。 |

首轮失败没有被记作通过，归因与集中修复范围如下；修复后的实际复测结果见“最终目标验证”，首轮失败记录与非零退出码继续保留。

| 失败范围 | 归因与最小修正 |
| --- | --- |
| 离线阅读 4 项 | 旧测试 fixture 缺少活动 OSS 测试配置，新的共享云服务选择入口因此拒绝下载。补齐测试配置，不以取消生产配置检查修复。 |
| S3 有界恢复 1 项 | 测试取数 helper 只读取正式查询的第一页（60 项），却断言完整 106 项；报告错误读取顶层 `downloadedChanges`；普通同步每轮最多上传 100 项，一轮不足以将本机新增项传给另一端。保留旧 helper，新增仅 `cfg(test)` 的正式查询逐页 helper，仅本用例使用；读取 `cloudReport.downloadedChanges`，B 完成两轮后 A 读取。继续核对完整 106 个 IDs、本机新增正文、零 DELETE，以及只读恢复期间仅设备确认 PUT、无域检查点 PUT。 |
| S2 迁移 4 项 | 暂存令牌由 24 个随机字节编码为 32 个 URL-safe 字符，原校验将字节数误作编码后长度。修正为 32 字符校验，保持字符与路径约束；这是生产校验缺陷，不归为测试假设。 |

对应首次失败记录：[离线阅读](../../.local/cloud-completion-20261007/verification/rust-reading_sync-1791384310772453800/result.json)、[S3 维护](../../.local/cloud-completion-20261007/verification/rust-cloud_maintenance--tests-0-1791384446485654200/result.json)、[S2 迁移](../../.local/cloud-completion-20261007/verification/rust-flashcard_cloud_sync--migration--tests-0-1791384527649677000/result.json)。

### 真实 OSS 联调

真实 OSS 用例已单独通过。使用本轮独立测试目录、隔离生产端与接收端数据库，从正式内容产生入口经过云端传输，到接收端正式查询和实际文件字节验证。涉及 3 个对象，上传载荷 1705 字节、下载载荷 7639 字节；远端测试对象保留，没有清理个人对象。载荷字节不是含请求头、列表或重试在内的完整账单流量上限。

证据：[正式结果记录](../../.local/cloud-completion-20261007/verification/rust-real-oss-1791384683764329500/result.json) 与 [用例回执日志](../../.local/cloud-completion-20261007/verification/rust-real-oss-1791384683764329500/stdout.log)。结果为 `producerAndQueryVerified=true`、`consumerFileVerified=true`、`remoteObjectsRetained=true`。该 OSS 用例不证明真实 WebDAV 服务器、Android 真机网络/后台行为或个人云迁移全程；安装与启动证据另见最终交付结果。

### Windows 测试运行库资格

首次测试程序解析到系统默认 `comctl32.dll` 时缺少 `TaskDialogIndirect` 导出。资格修复在测试可执行文件嵌入 Microsoft.Windows.Common-Controls V6 manifest，通过现有 Windows SDK 工具使依赖解析到系统 WinSxS 的 V6 组件，并核对 AMD64 架构及所需导出。

没有修改 System32、注册 KnownDLL 或更改系统设置；没有修改产品源码或 release 可执行文件。资格检查本身没有执行测试正文；之后的正式收集与用例运行记录才证明测试程序实际执行。测试程序重新编译后需重新确认 manifest 与可执行文件身份。

证据：[运行库资格记录](../../.local/cloud-completion-20261007/verification/test-runtime-qualification.json)、[嵌入 manifest 记录](../../.local/cloud-completion-20261007/verification/test-runtime-embedded-manifest.json)。首轮正式收集消费的已资格化测试程序 SHA256 为 `09674fd7145fc3175585fa3a57bf6c0a99f22eab1df2cf7dbdbe017b8a736020`。

## 候选身份、证据复用与资源约束

证据根为仓库内 `.local/cloud-completion-20261007/`。初始文件基线见 [baseline.json](../../.local/cloud-completion-20261007/baseline.json)，接受范围与边界见 [status.json](../../.local/cloud-completion-20261007/status.json)；每次正式运行在 `verification/<运行身份>/result.json` 中记录输入文件摘要、`sourceDigest`、`sourcesStable`、进程退出码、日志和测试可执行文件身份。

首轮后端收集与运行候选摘要为 `18fb31b10a5b286ee1fae6bfb863305df5b5cc788904aff58ea5014e84d3656d`。集中修复及迁移重启测试修正后已形成最终候选；该摘要仅标识首轮，不能冒充最终候选。最终候选摘要、合格测试程序 SHA256 和实际复测结果见下节及 [verification-ledger.json](../../.local/cloud-completion-20261007/verification-ledger.json)。

复用已通过检查的依据是逐文件输入摘要及实际依赖范围没有受到后续修复影响，不仅是旧记录曾经通过。此次集中修复限于离线测试配置、S3 测试 helper/fixture 和迁移令牌校验；已确认前端输入未变，复用其通过结果。后端已对离线目标 5 项、迁移 6 项及 S3 失败单项定向复测，其余已通过目标按输入变化与跨模块影响范围复用；最后一次迁移重启测试修正只影响已重新执行的单项。台账保留每个节点的实际运行来源与复用依据，不能把复用节点写为本候选重新执行通过。

本轮没有 Git 候选提交或远端 CI 记录，使用本地冻结文件摘要与正式 runner 身份审计。release 编译保持单任务且双端顺序构建；前端最多 2 个 worker，后端测试单线程。没有重复运行完整仓库套件。已有构建体积及未使用代码警告保留，运行库准备和定向修复使实际耗时超过最初估计。

## 最终目标验证

正式收集的 111 个后端目标身份已全部具有实际通过证据，包括单独执行的真实 OSS 用例；前端 93 个不同目标身份也已通过。机器可读去重台账见 [verification-ledger.json](../../.local/cloud-completion-20261007/verification-ledger.json)，保留原失败进程退出码及每个成功节点来自哪次运行，不把忽略项或重复运行相加。

最终源文件摘要为 `2358aadfeb3c94031400ee45e7645b527f2da6f13f6f0cd29ca35b4f082154c0`，最终合格测试程序 SHA256 为 `983bc6ee0f4e164babc401d0ef2b8289d66a83344f81d67a4cfee3ddd020c53e`。格式检查、正式编译、运行库准备与正式重新收集均通过，运行期间输入未变。

离线 5 项定向复测全部通过；迁移修复后 5 项通过，剩余重启用例的末尾旧断言误要求修改正文后单轮完成超过 100 对象的重新核验。仅修正该测试，严格检查持久游标、新核验标识和有界续跑，单项复测通过并确认新回执绑定当前正文。S3 恢复单项通过，验证完整 106 个条目、本机未上传正文保留、恢复阶段零 DELETE 且仅一个设备确认 PUT。后续最后一次修改只影响迁移重启测试，生产实现及另外 5 个迁移测试输入未变；其它已通过节点按上述依赖范围复用，没有重新执行整个套件。

## 最终交付结果

| 项目 | 当前状态 | 最终结果及证据 |
| --- | --- | --- |
| 集中修复后的正式编译与测试程序资格 | 通过 | 最终源摘要与测试程序 SHA256 见上节；正式编译/资格/收集退出码均为 0，源输入稳定。 |
| 正式重新收集及受影响后端定向复测 | 通过 | 离线 5 项、迁移 6 项和 S3 单项定向修复后通过，按实际节点去重并复用未受影响检查，累计 111 项；详见台账。 |
| Windows 0.16.237 portable 打包 | 通过 | [正式生产记录](../../.local/cloud-completion-20261007/verification/windows-portable-1791385727523323200/result.json) exit 0，源输入稳定；成品 54273024 字节，产品版本 0.16.237，SHA256 `3b2fa1749a08504318d9d36508e46bd72eab9aa6192d05bb11f85c96d8aebb77`。 |
| Windows 隔离冷启动与真实 invoke | 通过 | [启动回执](../../.local/cloud-completion-20261007/packaging/windows-cold-start.json) 证明当前版本、嵌入前端与两个真实 invoke，以及四个后台 getter 调用；没有访问个人凭据、启动自动工作或注册全局功能。不替代视觉或其它 getter 的逐项 invoke 测试。 |
| Android 0.16.237 ARM64 打包 | 通过 | [产物回执](../../.local/cloud-completion-20261007/packaging/android-artifact.json) `status=success`，版本 0.16.237 / code 16237，APK 57407201 字节，SHA256 `da863ee29a161a218360c73ef8039d7c7b0b16b3a8e0a1070065f9d8e0990bd6`；本轮 native 到 APK 消费链、现有签名及 16 KiB 检查通过。实际构建恢复路径见下文。 |
| Windows/Android 安装与设备联调 | Android 升级与启动通过；Windows 未安装 | [Android 安装回执](../../.local/cloud-completion-20261007/android-install/20261007-234658-b9303a0273/result.json) 证明 `install -r` 从 0.16.192 / code 16192 保留数据升级至 0.16.237 / 16237，既有证书匹配，正式 Activity 启动成功；10 秒观察期间 PID 存活且无 fatal。未卸载或清空数据，未逐条校验个人数据库。Windows 仅完成隔离冷启动，没有替换个人运行中的应用。 |

最终封存见 [delivery-result.json](../../.local/cloud-completion-20261007/delivery-result.json)，状态为 `complete`；验证台账为 `delivery_complete`、`packagingComplete=true`，480 个核心输入复核仍对应上述最终摘要。封存表示本轮接受范围完成，不扩大下述真机观察和联调结论。

本轮包执行方式与边界见 [packaging/README.md](../../.local/cloud-completion-20261007/packaging/README.md)。上表完成结果引用实际构建、产物与启动回执，不以准备脚本或语法核对代替成功。既有阶段验证保留在 [CLOUD_SYNC.md 的历史阶段验证记录](CLOUD_SYNC.md#历史阶段验证记录)，其“当时未联调/未打包”的事实不因本轮新增验证被删除。

Windows 隔离测试完成后向本轮自身进程发送关闭消息；在有界等待后仅终止自己持有的进程句柄。随后检查没有残留使用该隔离目录的 WebView2 进程。未安装或替换个人正在运行的 Windows 应用。正式构建保留已有前端体积和 12 项未使用代码警告，未把警告记作编译失败。

Android 正式 native 编译用时 14 分 39 秒完成，随后触发既有 Windows 符号链接限制；首次 Java 25 Gradle 组装失败。改用 Java 21.0.11 消费固定的本轮 native checkpoint，恢复时没有重新编译 native，offline Gradle 约 64 秒完成，并通过现有签名与 16 KiB 对齐检查。480 个核心输入与构建前验证台账一致；Android 生成工程的完整快照在恢复时才捕获，不冒充首次 native 编译前的历史快照。产物回执中的 `installed=false`、`deviceStarted=false` 只表示打包脚本不执行安装或启动，后续独立真机安装结果由上表安装回执证明。

主任务实际查看 [启动屏](../../.local/cloud-completion-20261007/packaging/android-launch-screen.png)，确认真实搜索列表和既有内容正常显示；经浏览入口进入阅读并打开云图标，分别查看 [浏览页](../../.local/cloud-completion-20261007/packaging/android-browse-screen.png)、[阅读页](../../.local/cloud-completion-20261007/packaging/android-reading-screen.png) 和 [统一云设置](../../.local/cloud-completion-20261007/packaging/android-reading-cloud-screen.png)。阅读页正常显示空态，统一总开关、阅读独立开关与正文/附件限额说明正常显示。手机既有配置中总开关、自动同步和闪卡开启，阅读模块关闭；本轮只读导航，没有修改状态、标签或同步设置，没有开启或操作个人云阅读数据。

安装原始回执的 `visualReadingVerified=false` 保留，后续视觉检查与该原始启动观察分开记录，见 [独立视觉回执](../../.local/cloud-completion-20261007/packaging/android-visual-check.json)。此视觉范围不包含文章详情、状态/标签操作的端到端链路；10 秒前台观察也不证明后台同步、网络切换或长期稳定性。未逐条计算个人数据库校验和，不能据此宣称所有个人记录字节完全不变；本轮没有执行个人云迁移全程。
