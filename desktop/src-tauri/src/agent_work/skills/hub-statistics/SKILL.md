---
name: hub-statistics
description: 需要完整枚举授权笔记、计算关键词提及数量、核对日记日期重复或按月年统计时使用。简单摘要或不需要数量的问题不必使用。
metadata:
  hub:
    title: 材料统计与覆盖核对
    required-tools: [hub_list_note_sources, hub_analyze_notes, hub_create_analysis_snapshot, hub_read_analysis_snapshot]
---

围绕用户问题选择分析单位、范围、关键词和分组，不机械执行固定步骤。同一轮已完整读取且未变化的方法可继续复用，不为每页材料重复加载同一技能。清单工具枚举授权文档，与搜索排名无关。标题/路径筛选是字面包含，不是全文搜索；分页沿用同一 snapshot，变化后重新核对。

需要跨分页分析、调整统计口径或在后续轮次复核同一份输入时，先用 hub_create_analysis_snapshot 捕获授权材料，再把返回的 snapshot 作为 expectedSnapshot 传给枚举/统计工具。此时成员和正文保持在 sourceAsOf 时点；来源更新不会偷偷替换输入。按 itemIndex 使用 hub_read_analysis_snapshot 读取捕获的原文，引用需带 snapshot、itemIndex 和 Unicode scalar 字符区间，不冒充当前原文引用。来源删除、撤权、快照到期或缺失时停止使用旧输入，明确说明原因；需要重新分析时显式创建新快照，并用 supersedes 关联仍可追溯的旧快照。

快照 status=partial 表示有正文不可读取，不能宣称完整。当前最新数据问题需要新建快照，历史快照只能用于注明截至时间的复盘。工具会公开 expiresAt 与容量；默认保留窗不等于完整 Work 长期恢复保证。未使用分析快照时，原实时统计和清单指纹校验保持原有语义。

统计工具实际扫描本地缓存正文。先核对 complete、documentsMatched/documentsAnalyzed、skippedCount、groupsTruncated 和覆盖范围。授权若只有选中文档，不能说已覆盖整库；本地缓存不等于远端全部资料。可用原文读取核对统计口径与异常。

document 单位为文档或明确授权的页面。day 只识别独占一行的有效日期标题（YYYY-MM-DD 或 YYYY年M月D日，可带 Markdown 标题与 @），每个资料库内按日合并重复日期。重复章节的词语次数仍累加，matchingUnits 则每个日期只计一次。不同库的同一日期不默认是同一天记录的副本。没有日期归属的文本不进入按日分母，须说明 unassignedCharacters。按月/年统计需要 day 单位；日期范围包含首尾两天。

关键词是字面文本提及，不是事件发生率；多个关键词可重叠。不要把记录缺失解释成实际未发生，也不据此作诊断。计算结果按工具回执说明，原文引用仍从本轮可引用原文中选择；不把统计 JSON 假装成原文引句。

遇到扫描上限、不可读取内容或不适用日期格式，缩小问题、换单位或准确说明未完成部分。当前工具不执行任意 Python、Shell 或技能脚本，不伪造图表或代码运行。

本内置技能当前没有配套 references/ 文件。完整方法在本说明和当前工具 schema 中，不猜测参考路径。主睡眠实际时长仅在当前提供 sleepDataset/chart 工具时处理，不由技能增加权限。

快照工具的 supersedes 是旧 snapshot 身份；下述数据行 supersedes 是旧修订号:rowId，二者不可混用。

主睡眠候选读完并核对后，首次优先用 sleepDataset create 一次提交全部完整 rows，不为取得 datasetId 专门先创建空数据集。空 rows 是允许的数据状态，但不表示抽取已完成或已有图表证据。create 的每行 correctionSource、supersedes 均为 null；reviewBasis 仍须说明实际评审依据。若已创建空数据集，之后补充是 revise 新增行：correctionSource 必填，supersedes 为 null（该行没有旧版本），可注明真实 modelReview，sourceRef 为 null，reason 说明本次读取与评审；不得冒充用户纠正。

跨多篇留存主睡眠线索及可重开出处时，即使没有精确时长，也使用现有 sleepDataset 保存核对过的 missing/ambiguous 线索、null 数值及固定快照 evidenceRefs；当前数据面板可逐行打开这些固定原文。完整的快照读取和行出处不需要再为每行 hub_read 取得普通编号引文，也不增加普通取证实体额度。报告可用少量必要编号引文并指向当前数据及逐行固定出处，不自加“每条线索都须有正文编号引文”的完成条件。完整读取和逐行出处仍须核对；除非用户要求逐篇明细，报告集中呈现结果、覆盖差项与必要依据，不重复整份来源清单、哈希或字符区间。数据留存不表示任何值已 accepted_for_analysis；没有充分精确值仍不计算月均、不生成图表。候选和排除判断来自实际原文，不预设条数或具体日期。

create 和 revise 中的每个 rows 条目都必须包含 schema 的全部 required 字段，即使值应为 null 或空字符串也要显式填写。不接受只有 date/hours/rowId 的简写；日期和值分别用 eventDate、normalizedValue，但仅改名仍不够，必须有原文出处、单位、归日、评审及其它必填字段。revise 是提交完整行集合，不是宿主按 rowId 合并缺失字段的局部补丁。

修订前先 read 当前数据集，沿用 datasetId、rowId、eventRef 及未改动行的全部字段。revise 改动已有行须填写合法 correctionSource，supersedes 为字符串 "expectedRevision:rowId"，使用本次所读旧数据集修订号；不能仅填 rowId、不能用对象，也不是新修订号或 datasetId。userCorrection 的 sourceRef 取当前 goalState 的真实用户命令来源，不用引文编号代替。改动评审说明等字段也属于行变更；未改动行保留已有 correctionSource/supersedes，不随新修订号重写。

主睡眠只纳入有充分依据的精确实际时长，排除午睡、旧估计和在床时间，未知不补零，不按起止时间推算实际睡眠。异常数字、单位或时刻表述在数据和报告中均保留原样与歧义，不把含混写法改成确定钟点或时长。保留 Unicode scalar 原文出处和排除原因；数据修订后重新绑定同一图表的新数据修订并 validate，完成状态仍由宿主证据门核对。首次创建时一并给出符合用户范围的标题与口径；已正确表达目标的标题无需仅为润色新增修订，只有实质问题才修正。

候选覆盖与精确值接受分开核对：本人明确叙述“醒来”“被吵醒”等睡眠相关事件，即使没有时刻或时长，也可形成 missing 候选，数值保持 null。不能只靠“睡眠”关键词或有无数字筛选候选。仅“早晨起来”伴随情绪、疲劳，或只有在床不适，不足以确认睡眠事件；保留语义歧义或非指标排除说明，不推断实际时长。完整阅读范围与有候选的材料数分别说明，不将没有精确值解释为没有相关线索。
