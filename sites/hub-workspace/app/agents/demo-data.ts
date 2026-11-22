export const agentDemoModes = [
  ["ui-demo", "排版示例"],
  ["source-demo", "来源示例"],
  ["activity-demo", "工作过程示例"],
] as const;

export type AgentDemoMode = typeof agentDemoModes[number][0];
export const isAgentDemoMode = (value: string | null): value is AgentDemoMode =>
  agentDemoModes.some(([id]) => id === value);

export const sourceDemoIds = ["migrated-assembly-craft", "migrated-assembly-obsidian"] as const;
export const sourceDemoQuestion = "评审稿和现场的卡扣安装顺序相反，是现场装错了吗？";
export const sourceDemoAnswer = "目前不能判定现场装错。两份记录的安装顺序确实相反，但采用的零件条件可能不同。";
export const sourceDemoSections = [
  { heading: "设计评审稿", body: "建议先装卡扣 1，再装卡扣 2；对应支架 V2 和饰板方案 A。", sourceIds: [sourceDemoIds[0]] },
  { heading: "现场试装记录", body: "实际先装卡扣 2，再装卡扣 1；支架暂记为 V3，饰板方案未记录。", sourceIds: [sourceDemoIds[1]] },
  { heading: "下一步", body: "打开两份资料，核对版本、卡扣编号和照片视角。确认是同一套零件条件后，再比较安装顺序。", sourceIds: [] },
];

export const formattingDemoMessages = [
      { id: 'ui-demo-question-short', role: 'user', text: '哪些分数通过了筛选？' },
      { id: 'ui-demo-answer-short', role: 'assistant', text: '通过筛选的是 **72、91、60**，共 **3 / 5** 个分数。' },
      { id: 'ui-demo-question-long', role: 'user', text: '用代码、步骤和表格说明为什么是 3 / 5。' },
      { id: 'ui-demo-answer-long', role: 'assistant', text: [
        '# 把筛选结果解释清楚',
        '这里有 **5 个原始分数**。条件 `$_ -ge 60` 保留大于或等于 60 的值，所以恰好 60 分也通过。',
        '## 先看这段代码',
        '```powershell\n$scores = 58, 72, 91, 60, 45\n$passingScores = $scores | Where-Object { $_ -ge 60 }\n"及格人数: $($passingScores.Count) / $($scores.Count)"\n```',
        '### 逐步核对',
        '1. `$scores` 保存原来的 5 个分数。\n2. `Where-Object` 逐个检查，只保留满足条件的分数。\n3. 用 `.Count` 分别读取及格数与总数，得到 **3 / 5**。',
        '## 用表格复核',
        '| 分数 | 是否达到 60 | 处理结果 |\n| ---: | :---: | --- |\n| 58 | 否 | 排除 |\n| 72 | 是 | 保留 |\n| 91 | 是 | 保留 |\n| 60 | 是 | 保留，等于阈值也通过 |\n| 45 | 否 | 排除 |',
        '> 阈值包含等号。把 `-ge` 改成 `-gt` 后，60 分就不会保留。',
        '## 还可以检查什么',
        '- 先确认及格线是否包含等号。\n- 复制代码时保留变量名、引号和缩进。\n- 如需查语法，可打开 [PowerShell 官方 Where-Object 文档](https://learn.microsoft.com/powershell/module/microsoft.powershell.core/where-object)。',
      ].join('\n\n'),
      },
] as const;
