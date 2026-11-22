export const citationCaseTitle = '项目周记核对与背景查证';

export const citationCaseSources = [
  { title: 'Disclosure (Show/Hide) Pattern', host: 'w3.org/WAI/ARIA/apg/patterns/disclosure/', badge: 'WAI' },
  { title: 'MDN · overflow-anchor', host: 'developer.mozilla.org/en-US/docs/Web/CSS/overflow-anchor', badge: 'MDN' },
  { title: 'Scroll Anchoring', host: 'drafts.csswg.org/css-scroll-anchoring/', badge: 'W3C' },
];

const noteTitle = '助手项目周记（示例）';
export const citationCaseParagraphs = [
  { number: 14, title: '滚动锚点', text: '展开旧回执后，视口应停留在当前证据。首段回答进入时仍需验证锚点。' },
  { number: 17, title: '键盘焦点', text: '打开证据面板后，焦点应落到面板中。关闭时回到原来的引用。' },
  { number: 29, title: '减少动态效果', text: '减少动态效果时，回到最新应立即定位，手动回看的选择仍应保留。' },
];

export const citationCaseMessages = [
  { id: 'citation-request', role: 'user', text: '补读项目周记，梳理仍待验证的问题并标注原文段落。顺便核对展开控件和滚动锚定的公开资料。' },
  {
    id: 'citation-answer',
    role: 'assistant',
    duration: '1 分 24 秒',
    hasWebSources: true,
    citations: citationCaseParagraphs,
    text: '还有三项待验证：滚动锚点、键盘焦点和减少动态效果。展开控件和滚动锚定各自提供基础，流式追加仍需要保留当前阅读位置。',
    timeline: [
      {
        id: 'citation-context', type: 'contextPrep', summary: '已载入上下文 · 1 份材料 · 1 条规则',
        items: [
          { kind: 'doc', name: noteTitle, meta: 'Obsidian · 示例库' },
          { kind: 'rule', name: '示例库工作规则', file: 'AGENTS.md', hash: '示例版', fullPath: '示例库 / AGENTS.md' },
        ],
      },
      { id: 'citation-progress', type: 'thought', text: '我会先核对周记中的待办，并留下可回原文的段落引用，再查公开规范确认展开和滚动行为。' },
      {
        id: 'citation-read', type: 'toolGroup', icon: 'fileText', title: '已读取知识库 · 1 篇笔记', badges: ['Hub'],
        steps: [{
          id: 'citation-excerpt', icon: 'fileText', label: `读取笔记「${noteTitle}」`, detail: '3 处片段',
          excerpt: citationCaseParagraphs,
          techJson: JSON.stringify({ tool: 'hub_read_note', note: noteTitle, paragraphs: citationCaseParagraphs.map(item => item.number) }, null, 2),
        }],
      },
      {
        id: 'citation-web', type: 'toolGroup', icon: 'search', title: '网页检索', badges: ['WAI', 'MDN', 'W3C'],
        steps: [
          { id: 'citation-query', icon: 'search', label: '搜索网页', detail: 'Disclosure pattern / CSS scroll anchoring' },
          { id: 'citation-pages', icon: 'globe', label: '已浏览 3 个页面', pages: citationCaseSources },
        ],
      },
    ],
  },
];
