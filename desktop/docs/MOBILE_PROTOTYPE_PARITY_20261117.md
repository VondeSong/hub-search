# 移动端原型逐页核对（2026-11-17）

## 基线与原因

- 参考：[手机原型 v29](https://hub-mobile-lab-von11.song02211368537057.chatgpt.site)，Sites 源码 `102ce00ea0652f2ea22f94cda6e92f2c3e2ca003`。本仓库 `sites/hub-mobile-lab/.source-snapshot.json` 已记录相同发布，不是原型源码漏同步。
- 按来源快照逐项校验 64 个源码文件的 SHA-256，全部相符。
- 核对期间并行聊天发布 v30（`ee3b7c775c26c6fa6c12c119c62c6e5890c1adfd`），助手命名、顶部连接和语音改动由该聊天交付；本轮已回看线上助手入口，保留它同步进来的源码与客户端修改。
- 客户端：主工作区 `desktop/src/`，Android `emulator-5564`、包名 `com.craftsearch.desktop`、安装版本 0.16.396。实际 WebView 加载 `@vite/client` 和主工作区源码，1422 经 ADB reverse 提供 HMR。`tauri.localhost` 本身不能用来判断是否运行旧 APK。
- 不一致主要来自原型改动未逐项移植，以及通用桌面组件仍渲染旧标题、工具条；另有助手/语音在另一聊天并行开发。日志 v29 的五行折叠、缩略图和范围菜单已经在主线，不需要重复移植。
- 本轮只修改客户端。没有发布 Site、APK、Release，没有向资料库添加测试记录，也没有修改云连接或触发付费识别。

## 本轮补齐

1. 通用标题：移除旧蓝色 H 标志，主页面显示页名；子页标题居中，连接总览显示正确标题。
2. 空间菜单：接入速记、资料库范围、连接总览、外观与阅读、设置。使用现有模态焦点与 Android 返回处理，不新增保存行为。
3. 浏览：轻量目录行、日志/阅读尾注、资料来源在发现与回看之前；保留真实计数和回调。
4. 搜索：范围/类型/筛选恢复轻量横排。
5. 收藏与标签：独立的当前集合搜索，不再输入后跳到全局搜索；收藏过滤保留结果对象身份供预览定位，标签按名称匹配。手机标签采用列表。
6. 任务：去除重复标题，增加待办/已完成/全部切换；来源、清单、视图及 AI 操作收在筛选入口内，排序与筛选可换行，保留现有真实同步功能。
7. 阅读：修复通用输入框背景覆盖搜索框的问题。
8. 洞察：去除重复桌面标题与面包屑，保留搜索、侧栏、发现和回顾能力，调整触控尺寸。

## 逐页对应清单

“代码核对”不等于模拟器已执行该页面所有业务动作。详情依赖当前设备实际样本；下表明确区分。

| 原型路由/页面 | 客户端对应及结论 | 本轮验证边界 |
| --- | --- | --- |
| search / 搜索筛选 / 资料范围 | MobileSearchControls、MobileFilterSheet；已补轻量筛选行和空间菜单 | 模拟器打开搜索和筛选、取消；范围入口沿用真实资料库 |
| browse | MobileBrowse；目录顺序和样式已补齐 | 模拟器逐个进入主要业务入口 |
| favorites | SearchResultsPane + MobileCollectionSearch；修复集合搜索跳全局 | 当前设备收藏为空，结果预览依靠保留对象身份的单元验证；不伪造收藏 |
| recent | 现有浏览历史集合 | 使用真实历史；不复制原型示例访问记录 |
| tags / label | 标签集合、只读标签属性与结果页；补名称搜索与列表 | 当前设备标签为空，标签详情样本不足 |
| libraries / 多选范围 | 原有资料库范围选择器，空间菜单/浏览目录可达 | 实际来源名称和数量不应与原型示例账号相同 |
| connections | MobileConnections；修正子页标题，保持内容与助手独立入口 | 模拟器已打开；不改连接配置 |
| sync | CloudSyncSettingsSection，模块分别控制 | 原型“模拟同步一次”不是正式客户端按钮，不复制模拟成功状态 |
| settings / appearance | 现有设置分类、MobileAppearanceSettings、DisplaySettingsSection | 主题/强调色/字号为真实持久化配置，核对入口，不为视觉验收改用户偏好 |
| logs | MobileJournal；v29 已在主线 | 模拟器读取既有记录、图片缩略图、五行折叠和搜索入口 |
| journal-search / journal-select | 既有搜索、日期标签条件、批量选择 | 模拟器打开搜索并返回；批量变更不对实际记录试写 |
| journal-edit / capture / note | MobileQuickCapture、QuickJournalEditor、JournalRecordEditor | 保留现有草稿与编辑链路；不保存合成内容 |
| journal-record / 音频附件 / 补录 | JournalVoice、JournalAudio | 由并行助手/语音聊天负责本次草稿和多段补录修改及录音验收，本轮不覆盖 |
| doc / article | 原有文档预览与阅读详情 | 当前设备无对应检索/阅读样本；未将原型演示正文注入客户端 |
| reading / 筛选 / 状态 | MobileReadingControls、CollectionsWorkspace | 模拟器打开空态、筛选面板；取消/应用暂存行为有现有测试；修复搜索底色 |
| tasks / task | TaskWorkspace、真实来源任务预览 | 模拟器验证主页面与高级入口；当前设备无任务，未改任务状态；原型本地任务编辑不等于 #34 的来源任务写回 |
| review / 今日 | MobileFlashcardIntro / MobileFlashcardDecks | 模拟器显示 0 张待复习，查看牌库入口可达 |
| review / 牌库 / deck | 原有牌库与牌组管理 | 模拟器已切换牌库；当前设备无牌组，牌组详情缺少真实样本 |
| review / 收件箱 / card | 原有 FlashcardInbox 和 MobileFlashcardPreview | 模拟器已切换收件箱；为空，未采用或删除卡片 |
| study | 原有翻面、评分和本轮进度 | 无当前真实卡片，未执行评分；不得以原型示例代验 |
| insights / finding | InsightsWorkspace / InsightDetail | 模拟器打开真实空态，发现重复标题并修复；无发现样本，不生成假结论 |
| recap | StageReview，洞察侧栏内已有入口 | 保留正式业务能力，不触发新分析运行 |
| agents / agent / agent-chat / agent-connection | CloudAgents 及设置/对话 | 并行聊天正在做“助手”命名和顶部连接入口；保留其 App/MobileHeader/MobileNavigation 改动，不混入本轮提交 |
| saved | 原型本地笔记索引；正式客户端由日志和检索承接 | 不另造重复本地数据库 |
| works / work / request / requests / collab-sync | 原型“后续功能”中的历史桌面协作与回执演示 | 不是这轮界面漏移植；不把模拟请求、桌面在线或回执写成真实服务能力 |
| widgets | 原型小组件预览 | #53 明确先不开发；本轮不扩大到 Android 原生小组件 |
| future / guide | 原型范围说明与历史演示入口 | 不把原型说明页面当作需要原样移入正式客户端的业务页面 |

## 并发保护

- 同工作区已有 AgentImages、AgentAnalysis、Rust agent_work、知识规则及 Sites 工作台修改，均保留。
- 助手/语音聊天 `01a1baad-3f8f-7c42-a78d-acadcafc1a90` 在本轮期间修改共享的 App、MobileHeader、MobileNavigation；本轮在其新内容上继续修改，提交时仅保存本轮差异，不回滚工作区。
- 模拟器为共享资源；另一聊天进行真实录音和草稿验收时暂停本轮界面操作。

## 检查

- `npm run build`：TypeScript 与 Vite 构建通过；仍有既有大于 500 kB 的分包提醒。
- 针对空间菜单、集合搜索、搜索导航、阅读筛选、闪卡首页、标签结果和任务回归：8 个测试文件、33 项通过。
- 中途一次测试 worker 启动超时，重跑通过；任务新增切换测试补齐 jsdom 的 scrollTo 模拟后通过。
- 助手并发更名曾导致旧断言仍期待 Agents，按已生效的助手名称同步断言后回归通过。
- Rust/原生配置未由本轮修改，不重编译原生包；安装包日期不能代表当前 HMR 前端版本。
- 真机、后台同步、真实非空任务/阅读/标签/牌组数据以及本轮未执行的写回仍不能标记为验收通过。#55 保持打开，完整业务验收另按各事项范围执行。
