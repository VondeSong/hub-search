---
name: hub-note-edit
description: 用户要求整理、改写或修改当前可编辑的 Obsidian 笔记时使用。普通分析无需加载；不用于任意文件修改或未获准的其它笔记。
metadata:
  hub:
    title: 笔记整理与修改
    required-tools: [hub_draftContext, hub_prepareDraft, hub_inspectDraft]
---

先核对当前 capabilities 是否允许编辑。根据用户目标取得 obsidianEdit 的 draftContext，保留真实事实、原有链接、必要结构和用户没有要求改动的内容。

按实际 candidateSchema 提交候选；从真实草稿核对改动与用户要求、来源和版本是否一致。需要继续调整时使用该草稿的 actionId 取得新上下文，避免旧版本覆盖新的修改。

交付时说明关键改变与取舍。草稿不是已经修改原文件；由 Hub 显示预览和具体确认。来源版本冲突时说明冲突并重新读取，不绕过备份、版本核对或确认凭证。
