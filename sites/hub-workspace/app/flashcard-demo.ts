export const demoCards = [
  {id: 'knowledge', deck: '学习笔记', question: '阅读中的一个观点，怎样成为真正可用的知识？', answer: '把观点与当前问题连接，保留原始依据与适用条件，再用一个小样本验证。', source: '知识应用 · DXF 试验', isNew: false},
  {id: 'hub', deck: '学习笔记', question: '在 Hub 中处理一条洞察，会自动完成原任务吗？', answer: '不会。发现的处理状态与来源任务状态分别维护。需要操作时，回到任务清单确认。', source: 'Hub · 洞察边界', isNew: false},
  {id: 'engineering', deck: '工程知识', question: '比对两份工程记录时，应该先核对哪些信息？', answer: '先确认对象、版本、记录时间和适用工况，再比较差异；不要只按相似标题合并。', source: '线束 · 资料核对', isNew: true},
  {id: 'decision', deck: '学习笔记', question: '决定值得回顾的触发条件有哪些？', answer: '到了约定日期，或关键假设有了新证据。回顾时对照当时理由和后来观察。', source: '决策 · 条件与回顾', isNew: true},
];
export const sessionLimits = [10, 20, 50, 100, 0];
export const dailyLimits = [0, 5, 10, 20, 50];
export function reviewPlan(dueIds: string[], studiedIds: string[], dailyLimit: number, studiedToday: number, sessionLimit: number, deck = '') {
  let allowance = dailyLimit === 0 ? Infinity : Math.max(0, dailyLimit - studiedToday);
  const eligible = demoCards.filter(card => dueIds.includes(card.id) && (!deck || card.deck === deck))
    .filter(card => !card.isNew || studiedIds.includes(card.id) || allowance-- > 0);
  return {eligible, session: sessionLimit === 0 ? eligible : eligible.slice(0, sessionLimit)};
}
