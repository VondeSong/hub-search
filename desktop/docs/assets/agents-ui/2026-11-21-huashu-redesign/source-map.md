# Agents 源码与设计对应表

本次从桌面入口沿到会话状态、请求组装和写入回执。三套原型共用同一组示例资料。表中的源码说明对应现有实现，设计稿的动作用于评审。

| 模块 | 源码中的职责与边界 | 原型中的入口或状态 |
| --- | --- | --- |
| 启动与载体 | 独立聊天、资料预览、阅读工作和已有工作都有独立的进入方式。引用可能在现有阅读界面打开，关联工作按原始工作身份恢复。 | A 叠在当前笔记上。B 左侧是原文，右侧是当前对话。C 展示独立任务。 |
| 标准、目标和标签 | 目标模式可填写完成条件，运行能力受模型约束。标签工作按定义、漏标、关系等任务独立取参数。 | 任务模式集中切换。目标和标签字段只在相应模式的输入区出现。 |
| 资料范围 | 明确选择的核心资料、允许继续搜索的库、当前页面与输入附件各有来源语义。资料策略决定可用搜索和记忆。发送后保留该轮的提交和证据身份。 | 详情直达选择器。核心资料和库分开显示。确认后影响下一条，关闭即取消编辑，既有引用仍可打开。 |
| 可复用研究专题 | 可保存和置顶资料组合、资料边界、策略与技能。应用前核对来源变更。手选资料与技能单独保留，只有显式勾选才合并到下一条。 | 任务模式内的「全部专题」带搜索、置顶和复核。部分资料不可用时明确提示，确认后使用还可用的资料。 |
| 笔记关联专题 | 专题与 Obsidian 笔记关联，保存方法与配置版本。先预览当期固定资料，得到读取授权后创建并打开工作。有原工作时继续原工作，成果、数据、历史归于该工作。 | 只在有笔记载体的 A、B 出现。示例可核对当期资料、授权读取、准备本期工作或打开上期原工作。配置编辑和数据版本只列在源码约束中。 |
| 记忆 | 对话使用设置、管理面板查看范围和写入目标分别控制。仅用所选资料时限制记忆，不清除原有使用偏好。待确认建议有独立审核状态。 | 管理记忆分开显示使用开关、查看范围和保存范围。由详情进入后，返回原详情项。 |
| 联网、模型、技能与工具 | 联网模式受来源策略及模型能力约束。选择当前技能、管理技能包和启用外部工具属于不同操作。 | 搜索保留在「联网与工具」首层，低频项放高级设置。模型和当前技能在输入区独立。技能包管理留在现有设置。 |
| 运行与会话接续 | 公开工作过程按执行记录更新。停止、排队、恢复、预算及待核对是独立状态。条件、任务树和工作状态各有自己的数据与控制。 | A、B 可展开对话内进度。C 用右栏显示本轮状态和已用资料。三套都可操作停止和排队示例。 |
| 回答与引用 | 用户提交的附件和模型回答的证据使用不同定位路径。回答、工具结果、数据图表和历史成果各有展示入口。 | 行内引用回到该轮原文，输入框附件走资料预览。B 点引用后左侧定位摘录，右侧回答仍可读。 |
| 保存与业务变更 | 回答保存按追加页面、新建笔记或创建滴答任务选择目标，预览后确认，并可核对写入结果。笔记修改、标签操作和插件写入各有独立的确认与回读。 | 回答的「更多」提供三种保存方式。演示待核对与核验完成两种回执。真实更新和业务专项交互依现有流程核验。 |
| 对话历史 | 现有组件提供搜索、归档、置顶和更多记录，打开会话按本地工作身份恢复。 | 保留左上历史入口。示例提供搜索和打开，用于进入同一评审场景。 |
| 云端 Agents | 桌面入口、VPS 线程和 Android 云端入口各有身份。跨端移交经过清单准备、确认、接续或撤回。 | 沿用独立入口。本轮聚焦三种本地对话载体，云端移交、权限撤销和真实外部写入需要在现有客户端专项验收。 |

## 主要代码入口

- 启动、会话和任务入口。[StandaloneAgentLauncher](../../../../src/StandaloneAgentLauncher.tsx) · [AgentInvestigation](../../../../src/AgentInvestigation.tsx) · [AgentTaskMode](../../../../src/AgentTaskMode.tsx) · [AgentTagWorkspace](../../../../src/AgentTagWorkspace.tsx)
- 材料和专题。[AgentMaterials](../../../../src/AgentMaterials.tsx) · [AgentLibraryScope](../../../../src/AgentLibraryScope.tsx) · [AgentSourceScope](../../../../src/AgentSourceScope.tsx) · [AgentResearch](../../../../src/AgentResearch.tsx) · [AgentTopics](../../../../src/AgentTopics.tsx) · [AgentTopicWork](../../../../src/AgentTopicWork.tsx)
- 记忆、模型和能力。[SharedMemory](../../../../src/SharedMemory.tsx) · [useSharedMemory](../../../../src/useSharedMemory.ts) · [AgentModelMenu](../../../../src/AgentModelMenu.tsx) · [AgentMcpServices](../../../../src/AgentMcpServices.tsx) · [AgentSkills](../../../../src/AgentSkills.tsx)
- 运行、成果和写入。[AgentActivity](../../../../src/AgentActivity.tsx) · [AgentLifecycle](../../../../src/AgentLifecycle.tsx) · [AgentDelivery](../../../../src/AgentDelivery.tsx) · [AgentAnswerSave](../../../../src/AgentAnswerSave.tsx) · [AgentBusinessActions](../../../../src/AgentBusinessActions.tsx)
- 记录与云端。[AgentConversationHistory](../../../../src/AgentConversationHistory.tsx) · [CloudAgents](../../../../src/CloudAgents.tsx) · [服务部署及职责](../../../../../services/hub-agents/README.md) · [移交流程](../../../../../services/hub-agents/handoffs.py)
