---
name: hub-flashcards
description: 用户要求根据当前笔记制作、改进或检查闪卡时使用；不用于无来源问答，也不自行把普通总结变成制卡或导入任务。
metadata:
  hub:
    title: 有来源的闪卡
    required-tools: [hub_read_note]
---

根据当前用户的学习目标选择制卡范围。先取得真实 draftContext，读取其材料、质量要求、已确认规则和 candidateSchema；需要更详细的质量标准时，按需读取 references/quality.md。

先核对当前入口的工具：内置对话可通过 draftContext、prepareDraft 和 inspectDraft 准备并检查草稿。外部 MCP 没有这些对话上下文工具时，使用 hub_read_note 取得原文、hub_get_flashcard_quality_context 取得实际质量要求；按需读取 hub-tool-guide 后，以 hub_submit_flashcard_drafts 的真实格式提交。只预览时在回答中交付候选，不调用提交工具。技能不补造当前入口缺少的工具或授权。

问题明确、可独立理解，每张卡考一个有价值的提取目标。答案直接且有原文支持，解释连接概念和理由。保留原文中的适用条件、区别和例外，不制造来源中没有的事实。

按 draftContext 返回的当前格式提交完整候选，再读取真实草稿检查是否符合用户要求。发现重复、含混、漏掉关键条件或来源不足时，取得以当前草稿为基准的新制作上下文，修改后再次核对。工具成功只证明它返回的实际状态。

制卡、预览、导入是不同用户意图。只预览时保留草稿；用户要求导入且当前对话已有允许时，明确选择本轮 actionId 调用 importFlashcards。以实际回执说明导入结果，收件箱待审核不等于进入正式复习。
