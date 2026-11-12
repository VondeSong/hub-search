# Hub 手机端原型

<!-- impeccable:product-schema 1 -->

## Platform
web（手机浏览器优先，独立 Sites 预览）

## Stack
静态 HTML、CSS、JavaScript；示例数据在浏览器本地。

## Users
假设以 Hub 的个人使用者为首要体验对象，面向通勤、临时查找和回顾等短会话。

## Product Purpose
检验已有搜索、资料浏览、阅读、任务和闪卡怎样适配手机，各模块展开其手机代表流程；同时预演 Issue #2 洞察的查看依据、处理和开放回顾，以及 Issue #32 手机接入个人 VPS 后的 Agents 标准对话。与桌面站点独立。

## Agents Scope

遵循 Issue #32 更新后的主方案：手机通过 Hub 服务连接个人 Linux VPS，由执行端运行官方 Codex app-server。Windows 关机不阻塞新云端会话。原型展示文字、多轮、图片选择、流式回复、停止、断线恢复和结果保存；短视频仅展示带时间点的关键帧实验。

保留五个主标签。Agents 通过顶部、浏览、资料与洞察上下文进入，全屏对话中保留对话、材料、成果三种视图。已有桌面聊天迁移与桌面私有资料访问不在本轮范围内。

## Boundaries
示例数据与本地演示状态，不连接真实资料库、VPS 或 Codex，不调用模型，不改写同步任务。示例回复均明确标注；实际选择的图片仅在当前浏览器中预览和保存，不声称已经识别。手机 Web 原型不代表现有 Android 功能已经具备洞察或完成云端 Agents 接入。
