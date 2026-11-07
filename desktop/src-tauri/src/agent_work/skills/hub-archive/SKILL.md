---
name: hub-archive
description: 用户明确要求为当前阅读材料准备归档、选择现有归档目标或调整归档方案时使用。不因材料值得保存就自动建立归档任务。
metadata:
  hub:
    title: 阅读材料归档
    required-tools: [hub_prepareArchive, hub_inspectDraft]
---

从当前 capabilities 的真实 archiveTargets 选择用户要求的目标，不猜测空间、目录、标签或写入身份。目标不明确且无法从现有上下文判断时，把需要用户选择的具体问题说清楚。

调用 prepareArchive 取得真实归档方案，再用 inspectDraft 核对来源、目标和内容。已有方案需要调整时传入其 baseActionId，不重复准备已经提交或结果尚不确定的操作。

归档方案只是一份待确认草稿。由 Hub 的正式预览、确认、提交和回执决定实际保存结果。不得通过其它文字工具绕过远端确认，不把“方案准备完成”说成“已经归档”。
