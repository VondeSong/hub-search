const variants = { a: '浮窗助手', b: '三栏工作区', c: '专注任务台' };
const modes = { standard: '标准', goal: '目标', tag: '标签' };
const topics = [
  { id: 'front', label: '前门线束评审核对', hint: '对照接口清单和评审记录，区分结论与待复核项。', scope: [0, 1], policy: '只用所选资料' },
  { id: 'record', label: '试装记录单页核对', hint: '检查问题描述、复现位置与后续动作。', scope: [2], policy: '只用所选资料' },
  { id: 'weekly', label: '每周问题回顾', hint: '整理未闭环事项，标明下一步。', scope: [0, 2], policy: '材料优先' }
];
const documents = [
  { label: '前门线束评审记录', kind: '评审纪要', excerpt: '接口与连接器位置已对齐。固定点随试装件复核，压接规格以最新端子图纸为准。' },
  { label: '连接器接口清单', kind: '资料表', excerpt: '连接器编号与接口定义可作为本轮设计输入。端子压接参数请以供应商图纸为准。' },
  { label: '试装问题记录', kind: '现场记录', excerpt: '复核前门内板的固定点与卡扣手部可达性。试装后补回装配位置照片。' }
];
const chats = [
  { id: 'review', label: '前门线束评审核对', date: '今天', question: '梳理评审结论，区分已确认项和待复核项。', answer: '前门线束评审小结' },
  { id: 'mount', label: '卡扣安装位置核对', date: '昨天', question: '这份试装记录里还有哪些没确认？', answer: '卡扣安装复核小结' },
  { id: 'interface', label: '接口清单检查', date: '昨天', question: '整理接口清单的确认条件。', answer: '接口清单检查小结' }
];
const steps = [
  ['核对资料范围', '确认 2 份核心材料'],
  ['比对评审与接口', '提取共同结论和差异'],
  ['整理结论与待办', '为每项结论关联来源']
];
const suggestions = [
  ['FileText', '概括已有资料'],
  ['ListChecks', '提取待办与复核项'],
  ['SearchCheck', '核对结论的依据']
];
const initialVariant = new URL(location.href).searchParams.get('view');
let variant = Object.hasOwn(variants, initialVariant) ? initialVariant : document.documentElement.dataset.variant;
let activeChat = chats[0], phase = 'complete', step = 3, mode = 'standard', topic = null, draft = '';
let posted = activeChat.question, selected = [0, 1], pins = new Set(['front']), archived = new Set();
let stack = [], showArchive = false, search = '', source = 0, topicReview = null, timer, toastTimer, toast = '';
let web = '关闭', memoryEnabled = false, useSkill = false, model = 'GPT-6.2 Sol', draftNote = '';
let criteria = '', targetTag = '线束设计', memoryTab = 'saved';
let processOpen = false, copied = false, saved = false;
const app = document.querySelector('#app');
const safe = value => String(value ?? '').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const svg = name => icons[name] ?? '';
const iconButton = (icon, label, action, value = '', extra = '') => `<button type="button" class="icon-button ${extra}" data-action="${action}" data-value="${value}" aria-label="${label}" title="${label}">${svg(icon)}</button>`;
const button = (label, action, options = {}) => `<button type="button" class="${options.className || 'button'}" data-action="${action}" data-value="${options.value ?? ''}"${options.disabled ? ' disabled' : ''}>${options.icon ? svg(options.icon) : ''}<span>${safe(label)}</span></button>`;
const panel = () => stack.at(-1) ?? '';
const notify = message => {
  toast = message;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast = ''; showToast(); }, 2600);
  showToast();
};
function showToast() { const message = app.querySelector('.toast'); if (message) message.textContent = toast; }
function navigate(key, nested = false) {
  stack = nested && panel() ? [...stack, key] : [key];
  search = '';
  render(true);
}
function goBack() {
  const previous = panel();
  stack = stack.slice(0,-1); search = '';
  render(true);
  if (panel() === 'details') app.querySelector(`.sheet [data-value="${previous}"]`)?.focus({preventScroll:true});
}
function resetChat() {
  clearTimeout(timer);
  phase = 'empty'; activeChat = null; step = 0; posted = ''; draft = '';
  selected = []; topic = null; mode = 'standard'; stack = [];
  criteria = ''; targetTag = '线束设计';
  copied = false; processOpen = false; saved = false;
  render();
  app.querySelector('#question')?.focus();
}
function loadChat(chat) {
  clearTimeout(timer);
  activeChat = chat; phase = 'complete'; step = 3; posted = chat.question; draft = '';
  selected = chat.id === 'mount' ? [2] : [0, 1];
  mode = 'standard'; topic = null; stack = []; copied = false; saved = false; processOpen = false;
  render();
}
function send() {
  if (!draft.trim() || phase === 'running') return;
  posted = draft.trim();
  if (mode === 'goal' && criteria.trim()) posted += '\n完成条件 · ' + criteria.trim();
  if (mode === 'tag') posted += '\n目标标签 · #' + targetTag;
  draft = ''; phase = 'running'; step = 0; stack = [];
  activeChat = null; processOpen = true; saved = false; copied = false;
  render();
  timer = setInterval(() => {
    step += 1;
    if (step >= steps.length) { clearInterval(timer); phase = 'complete'; processOpen = false; }
    render();
  }, 850);
}
function renderReview() {
  return `<header class="review">
    <div class="review-brand"><span class="hub-logo">${svg('Layers')}</span><span><strong>Hub Agents</strong><small>设计评审</small></span></div>
    <nav aria-label="切换设计方案" class="variants">${Object.entries(variants).map(([id,name]) => `<button type="button" data-action="variant" data-value="${id}" aria-pressed="${id === variant}"><b>${id.toUpperCase()}</b> ${name}</button>`).join('')}</nav>
    <div class="review-state">${button('查看示例','sample',{icon:'RotateCcw',className:'soft-button'})}</div>
  </header>`;
}
function desk() {
  return `<div class="desk" aria-hidden="true">
    <aside class="desk-sidebar"><span class="hub-logo">${svg('Layers')}</span><span class="desk-icon">${svg('Search')}</span><span class="desk-icon">${svg('Library')}</span><span class="desk-icon">${svg('Bookmark')}</span></aside>
    <div class="desk-doc"><div class="desk-path">${svg('FolderOpen')} 工程资料 <span>/</span> 评审记录</div><h2>前门线束评审记录</h2><p class="desk-meta">T29 <span>·</span> 设计评审</p>
    <div class="paper-rule"></div>
    <h3>连接器接口</h3><p>本轮核对连接器编号、接口定义和装配位置。冻结前，图纸应与接口清单保持一致。</p>
    <dl class="paper-data"><div><dt>接口清单</dt><dd>已核对</dd></div><div><dt>固定点</dt><dd>待试装复核</dd></div><div><dt>压接规格</dt><dd>待端子图纸</dd></div></dl>
    <h3>试装复核</h3><p>查看卡扣可达性，补齐固定点照片和端子规格。记录保留变更来源。</p>
    <span class="desk-tag">线束设计</span><span class="desk-tag">评审纪要</span></div>
  </div>`;
}
function modeLabel() { return topic?.label || modes[mode]; }
function toolbar() {
  const title = activeChat?.label || (posted ? '前门线束评审' : '新聊天');
  return `<header class="toolbar">
    <div class="tool-start">${iconButton('Menu','对话历史','open','history','history-icon')}${iconButton('Plus','新聊天','new','','new-icon')}</div>
    <div class="session-name"><span>${safe(title)}</span>${button(modeLabel(),'open',{icon:'ChevronDown',value:'mode',className:'mode-pill'})}</div>
    <div class="tool-end">${iconButton('FolderBookmark','全部专题','open','topics','toolbar-topics')}${iconButton('MoreHorizontal','对话详情','open','details')}</div>
  </header>`;
}
function historyRows(items) {
  return items.length ? items.map(chat => `<div class="list-row history-row">
    <button type="button" data-action="chat" data-value="${chat.id}" aria-current="${activeChat?.id === chat.id}">${svg('Clock')}<span><strong>${chat.label}</strong><small>${chat.date} · 2 条消息</small></span></button>
    ${iconButton(showArchive ? 'RotateCcw' : 'Archive', showArchive ? '恢复对话' : '归档对话','archive',chat.id,'row-action')}
  </div>`).join('') : `<p class="empty-list">${search ? '没有匹配的对话' : '这里还没有对话'}</p>`;
}
function libraryRail() {
  return `<aside class="library-rail"><div class="rail-title">${svg('Layers')}<strong>Agents</strong></div>
    ${button('新聊天','new',{icon:'Plus',className:'primary rail-new'})}
    <nav class="rail-navigation" aria-label="工作区导航">${button('专题','open',{icon:'FolderBookmark',value:'topics',className:'rail-button'})}${button('对话历史','open',{icon:'Clock',value:'history',className:'rail-button'})}</nav>
    <section class="rail-recent"><h3>最近对话</h3>${chats.filter(chat => !archived.has(chat.id)).map(chat => button(chat.label,'chat',{value:chat.id,className:'rail-chat'+(chat.id===activeChat?.id?' current':'')})).join('')}</section>
  </aside>`;
}
function workRail() {
  return `<aside class="work-rail"><div class="rail-title">${svg('Activity')}<strong>任务进度</strong></div>
    <div class="work-state"><i></i>${phase === 'complete' ? '已完成' : phase === 'running' ? '进行中' : phase === 'stopped' ? '已停止' : '等待开始'}</div>
    ${progress()}
    <nav aria-label="任务上下文" class="work-nav">${button('资料范围','open',{icon:'Layers',value:'sources',className:'rail-button'})}${button('全部专题','open',{icon:'FolderBookmark',value:'topics',className:'rail-button'})}${button('对话历史','open',{icon:'Clock',value:'history',className:'rail-button'})}</nav>
  </aside>`;
}
function progress() {
  return `<ol class="steps">${steps.map(([label,note],i) => `<li data-status="${i < step ? 'done' : i === step && phase === 'running' ? 'running' : 'waiting'}"><span class="step-mark">${i < step ? svg('Check') : ''}</span><span><strong>${label}</strong><small>${i === 0 ? (selected.length ? '已选 '+selected.length+' 份资料' : '本轮未附带资料') : note}</small></span></li>`).join('')}</ol>`;
}
function citations(index) {
  if (!selected.includes(index)) return '';
  return `<button type="button" class="cite" data-action="source" data-value="${index}" aria-label="查看来源：${documents[index].label}">${index+1}</button>`;
}
function result() {
  const fromMount = activeChat?.id === 'mount';
  const fromInterface = activeChat?.id === 'interface';
  const heading = activeChat?.answer || '本轮资料小结';
  const exampleText = fromMount ? '先确认固定点和装配可达性，再补齐试装记录。' : fromInterface ? '先核对接口编号与定义，压接参数单独查证。' : '可以先冻结连接器清单。固定点与压接规格等复核后再更新图纸。';
  return `<article class="answer">
    <div class="answer-author"><span class="assistant-symbol">${svg('Layers')}</span><strong>Hub 助手</strong></div>
    <h2>${heading}</h2><p class="lead">${exampleText} ${citations(fromMount ? 2 : 0)}</p>
    <div class="findings">
      <div><span class="finding-mark confirmed">${svg('Check')}</span><div><h3>已确认</h3><p>${fromMount?'卡扣位置已纳入试装验证清单。':'连接器编号和接口定义已对齐。'} ${citations(fromMount?2:1)}</p></div></div>
      <div><span class="finding-mark pending">${svg('CircleDot')}</span><div><h3>待复核</h3><p>${fromInterface?'压接规格以最新端子图纸为准。':'复核固定点与卡扣可达性，补齐压接规格。'} ${citations(fromMount?2:0)}</p></div></div>
    </div>
    <div class="answer-actions">
      ${button(copied?'已复制':'复制','copy',{icon:copied?'Check':'Copy',className:'soft-button'} )}
      ${button(saved?'再次预览笔记':'保存为笔记','save',{icon:'NotebookPen',className:'soft-button'})}
      ${button('更多','open',{icon:'MoreHorizontal',value:'outcomes',className:'soft-button'})}
    </div>
    ${variant === 'c' && selected.length ? `<section class="result-sources" aria-label="本轮引用">
      <h3>本轮引用</h3><div>${selected.map(n=>row('FileText',documents[n].label,documents[n].kind,'source',n)).join('')}</div>
    </section>` : ''}
  </article>`;
}
function thread() {
  if (phase === 'empty') return `<div class="welcome">
    <div class="welcome-head"><span class="assistant-symbol">${svg('Layers')}</span><h2>从一个问题开始</h2></div>
    <div class="quick" aria-label="对话建议">${suggestions.map(([icon,label]) => button(label,'suggestion',{icon,value:label,className:'quick-action'})).join('')}</div>
  </div>`;
  return `<div class="thread-body"><div class="user-message">${safe(posted)}</div>
    <div class="activity">
      <button type="button" class="activity-toggle" data-action="process" aria-expanded="${processOpen}">${svg('Activity')}<span>${phase==='running'?steps[step]?.[0]:phase==='stopped'?'任务已停止':'已完成资料核对'}</span>${svg('ChevronDown')}</button>
      ${processOpen ? progress() : ''}</div>
    ${phase === 'complete' ? result() : phase === 'stopped' ? `<div class="stopped"><p>已停止这次处理，原问题可以重新编辑。</p>${button('编辑原问题','retry',{className:'button'})}</div>` : ''}
  </div>`;
}
function composer() {
  const modeOptions = mode === 'goal'
    ? `<label class="mode-field"><span>完成条件</span><input id="criteria" placeholder="怎样算完成？" value="${safe(criteria)}"></label>`
    : mode === 'tag' ? `<label class="mode-field"><span>目标标签</span><select id="targetTag">${['线束设计','试装复核','接口核对'].map(tag=>`<option${targetTag===tag?' selected':''}>${tag}</option>`).join('')}</select></label>` : '';
  return `<div class="compose-wrap"><div class="composer">
    ${selected.length ? `<div class="attached">${selected.slice(0,2).map(n=>button(documents[n].label,'source',{value:n,icon:'FileText',className:'attachment'})).join('')}${selected.length>2?`<span class="overflow-count">+ ${selected.length-2}</span>`:''}</div>` : ''}
    ${modeOptions}
    <textarea rows="2" id="question" aria-label="给 Hub 助手的消息" placeholder="${phase === 'empty' ? '询问 Hub 助手…' : '继续追问…'}">${safe(draft)}</textarea>
    <div class="composer-tools"><div class="input-actions">
      ${iconButton('Plus','添加资料','open','sources')}
      ${button('资料范围','open',{icon:'Layers',value:'sources',className:'soft-button scope-control'})}
      ${iconButton('Brain','记忆与保存','open','memory')}
      ${iconButton('Sparkles','技能','open','skills')}
    </div><div class="input-actions right">
      ${button(model,'open',{icon:'ChevronDown',value:'model',className:'soft-button model-control'})}
      ${phase==='running'?iconButton('Square','停止','stop','','send'):iconButton('ArrowUp','发送','send','','send')}
    </div></div></div><span class="compose-hint">交互示例 <kbd>Ctrl</kbd> + <kbd>Enter</kbd> 发送</span></div>`;
}
function row(icon, label, status, action, value = '', type = 'link') {
  return `<button class="settings-row" type="button" data-action="${action}" data-value="${value}">${svg(icon)}<strong>${safe(label)}</strong>${status?`<span>${safe(status)}</span>`:''}${svg(type==='expand'?'ChevronDown':'ChevronRight')}</button>`;
}
function group(title, content) { return `<section class="settings-group"><h3>${title}</h3>${content}</section>`; }
function inputs(placeholder) {
  return `<label class="search">${svg('Search')}<input id="panelSearch" type="search" aria-label="${placeholder}" placeholder="${placeholder}" value="${safe(search)}"></label>`;
}
function topicRows() {
  const list = topics.filter(t=>(!stack.includes('linked-topics') || t.id !== 'weekly') && t.label.includes(search.trim()))
    .sort((a,b)=>Number(pins.has(b.id))-Number(pins.has(a.id)));
  return list.length ? list.map(t => `<div class="list-row topic-row">
    <button type="button" data-action="check-topic" data-value="${t.id}" aria-current="${variant==='b' && panel()==='topic-review' && topicReview?.id===t.id}"><span class="topic-icon">${svg('FolderBookmark')}</span><span><strong>${t.label}</strong><small>${t.policy} · ${t.scope.length} 份资料</small></span></button>
    <button type="button" class="icon-button row-action" data-action="pin" data-value="${t.id}" aria-pressed="${pins.has(t.id)}" aria-label="${pins.has(t.id)?'取消置顶':'置顶'}${t.label}" title="${pins.has(t.id)?'取消置顶':'置顶'}">${svg('Pin')}</button>
  </div>`).join('') : '<p class="empty-list">没有匹配的专题</p>';
}
function topicPanel() {
  return inputs('搜索专题') + `<div id="filterResults" class="list">${topicRows()}</div>`;
}
function sourceRows() {
  return documents.map((doc,n)=>`<div class="material-row">
    <label><input type="checkbox" data-material="${n}" ${selected.includes(n)?'checked':''}><span><strong>${doc.label}</strong><small>${doc.kind}</small></span></label>
    ${iconButton('ArrowUpRight','查看原文：'+doc.label,'source',n,'row-action')}
  </div>`).join('');
}
function bodyOf(key) {
  switch (key) {
    case 'details':
      return group('资料与工具',
        row('Layers','资料范围',selected.length ? selected.length+' 份资料' : '未选资料','next','sources')+
        row('Globe2','联网与工具',web,'next','network')+
        row('FolderBookmark','专题',topic?.label || '','next','linked-topics')+
        row('Brain','管理记忆',memoryEnabled?'已开启':'','next','memory')) +
        group('进度与成果',row('Activity','任务状态',phase==='complete'?'已完成':phase==='running'?'进行中':'尚未开始','next','progress')+row('NotebookPen','成果与保存','','next','outcomes'));
    case 'mode':
      return group('任务模式',Object.entries(modes).map(([id,name]) => row(id==='goal'?'Target':id==='tag'?'Tag':'Layers',name,id===mode?'当前':'','mode',id)).join('')) +
        group('专题',row('FolderBookmark','全部专题',String(topics.length)+' 个','next','topics'));
    case 'topics': return topicPanel();
    case 'linked-topics': return topicPanel()+`<div class="panel-footer">${button('查看全部专题','open',{value:'topics',icon:'FolderOpen'})}</div>`;
    case 'topic-review': return topicReview ? `${variant==='b'?topicPanel():''}
      <section class="topic-preview">
        <h3 class="panel-item-title">${topicReview.label}</h3><p>${topicReview.hint}</p>
        <div class="source-preview">${topicReview.scope.map(n=>row('FileText',documents[n].label,'','source',n)).join('')}</div>
        ${stack.includes('linked-topics') ? row('Clock','打开关联对话','','chat',topicReview.id==='front'?'review':'mount') : ''}
        <div class="panel-footer">${button('应用到当前对话','apply-topic',{className:'primary',icon:'Check'})}</div>
      </section>` : '';
    case 'history': return inputs('搜索对话标题')+`<div id="filterResults" class="list">${historyResults()}</div><div class="panel-footer">${button(showArchive?'返回最近对话':'已归档的对话','show-archive',{icon:'Archive',className:'button'})}</div>`;
    case 'sources': return `<div class="list materials-list">${sourceRows()}</div><div class="panel-footer"><span>${selected.length} 份资料</span>${button('完成','back',{className:'primary'})}</div>`;
    case 'source': {
      const doc = documents[source];
      return `<h3 class="panel-item-title">${doc.label}</h3><p class="muted">${doc.kind} · 示例原文</p><blockquote>${doc.excerpt}</blockquote>`;
    }
    case 'memory': return `<label class="toggle-row"><span><strong>使用已保存记忆</strong><small>当前对话</small></span><input type="checkbox" id="memory" ${memoryEnabled?'checked':''}></label>
      <div class="memory-tabs">${button('已保存','memory-tab',{value:'saved',className:memoryTab==='saved'?'button current':'button'})}${button('待确认','memory-tab',{value:'pending',className:memoryTab==='pending'?'button current':'button'})}</div>
      ${memoryTab==='saved'?'<details class="advanced"><summary>评审结论的表达方式</summary><p>把已确认项和待复核项分别列出，并为结论附上资料出处。</p></details>':'<p class="empty-list">本对话没有待确认记忆。</p>'}
      <div class="panel-footer">${button(stack.length>1?'返回对话详情':'完成','back',{className:'primary',icon:'ArrowLeft'})}</div>`;
    case 'network': return `<label class="config-row"><span>联网搜索</span><select id="web">${['关闭','缓存搜索','实时搜索'].map(name => `<option${web===name?' selected':''}>${name}</option>`).join('')}</select></label>
      <details class="advanced"><summary>${svg('ChevronDown')}高级设置</summary><div class="advanced-body">${row('Globe2','外部工具（MCP）','','next','mcp')}${row('Layers','执行与协作','','next','collaboration')}${row('SlidersHorizontal','开发者诊断','','next','diagnostics')}</div></details>`;
    case 'mcp': return '<p class="empty-list">当前对话没有选用外部工具。</p>';
    case 'collaboration': return '<p class="empty-list">此对话由当前助手执行。已选资料会显示在资料范围。</p>';
    case 'diagnostics': return '<div class="config-row"><span>工具调用方式</span><strong>直接调用</strong></div>';
    case 'progress': return progress();
    case 'outcomes': return `<p>${phase==='complete'?'可将答案整理为笔记草稿。':'完成回答后可预览保存草稿。'}</p>${button('保存为笔记','save',{className:'primary',disabled:phase!=='complete',icon:'NotebookPen'})}`;
    case 'save': return `<label class="draft-label" for="draftNote">笔记内容</label><textarea id="draftNote" rows="7">${safe(draftNote)}</textarea><div class="panel-footer">${button('确认保存示例','confirm-save',{className:'primary'})}</div>`;
    case 'skills': return `<label class="toggle-row"><span><strong>资料分析与核对</strong><small>本轮使用</small></span><input id="skill" type="checkbox" ${useSkill?'checked':''}></label>`;
    case 'model': return group('模型',['GPT-6.2 Sol','GPT-6.2 Astra','DeepSeek'].map(name=>row('Layers',name,model===name?'当前':'','model',name)).join(''));
    default: return '';
  }
}
const sheetTitles = { details:'对话详情',mode:'任务模式',topics:'全部专题','linked-topics':'当前笔记的专题','topic-review':'核对专题资料',history:'对话历史',sources:'资料范围',source:'引用原文',memory:'管理记忆',network:'联网与工具',progress:'任务状态',outcomes:'成果与保存',save:'笔记草稿',skills:'技能',model:'选择模型',mcp:'外部工具（MCP）',collaboration:'执行与协作',diagnostics:'开发者诊断' };
function sheet(key, placement) {
  const previous = stack.at(-2);
  const backTitle = previous ? '返回'+sheetTitles[previous] : '返回对话';
  return `<section class="sheet ${placement}" data-panel="${key}" aria-label="${sheetTitles[key]}">
    <header class="sheet-head">${previous || placement==='page-sheet' ? iconButton('ArrowLeft',backTitle,'back') : ''}<h2 tabindex="-1">${showArchive&&key==='history'?'已归档的对话':sheetTitles[key]}</h2>
    ${iconButton('X','关闭'+sheetTitles[key],'close')}</header><div class="sheet-body">${bodyOf(key)}</div>
  </section>`;
}
function historyResults() { return historyRows(chats.filter(chat=>archived.has(chat.id)===showArchive && chat.label.includes(search.trim()))); }
function inspector() {
  if (panel()) return sheet(panel(),'inspect-sheet');
  return `<aside class="sheet inspect-sheet default-inspector" aria-label="当前上下文"><header class="sheet-head"><h2>当前上下文</h2></header><div class="sheet-body">
    ${group('本轮资料',selected.length?selected.map(n=>row('FileText',documents[n].label,documents[n].kind,'source',n)).join(''):`<p class="empty-list">未附带资料</p>`)}
    ${button('编辑资料范围','open',{icon:'Plus',value:'sources',className:'button edit-materials'})}
    ${group('任务进度',progress())}
  </div></aside>`;
}
function render(focusPanel = false) {
  document.documentElement.dataset.variant = variant;
  document.title = 'Hub Agents · ' + variants[variant];
  const html = `<main class="stage">
    ${variant==='a'?desk():''}
    <section class="workspace ${variant==='a'?'floating':'full-workspace'}" aria-label="Hub 助手">
      ${variant==='b'?libraryRail():''}
      ${toolbar()}
      ${variant==='c'?workRail():''}
      <div class="conversation" ${variant==='c'&&panel()?'hidden':''}>
        <div class="messages">${thread()}</div>${composer()}
      </div>
      ${variant==='b'?inspector():panel()?sheet(panel(),variant==='a'?'float-sheet':'page-sheet'):''}
    </section></main>`;
  const scroll = app.querySelector('.messages')?.scrollTop || 0;
  app.innerHTML = renderReview()+html+'<div class="toast" role="status" aria-live="polite"></div>';
  if (!focusPanel) { const messages = app.querySelector('.messages'); if (messages) messages.scrollTop = scroll; }
  showToast();
  syncSend();
  if (focusPanel && panel()) (app.querySelector('#panelSearch') ?? app.querySelector('.sheet-head h2'))?.focus({preventScroll:true});
}
function syncSend() {
  const trigger = app.querySelector('.send[data-action="send"]');
  if (trigger) trigger.disabled = !draft.trim();
}
app.addEventListener('input', event => {
  const target = event.target;
  if (target.id==='question') { draft=target.value; syncSend(); }
  else if (target.id==='criteria') criteria=target.value;
  else if (target.id==='draftNote') draftNote=target.value;
  else if (target.id==='panelSearch') {
    search=target.value;
    app.querySelector('#filterResults').innerHTML=panel()==='history'?historyResults():topicRows();
  }
});
app.addEventListener('change', event => {
  const target=event.target;
  if (target.hasAttribute('data-material')) {
    const n=Number(target.dataset.material);
    selected=target.checked?[...selected,n]:selected.filter(i=>i!==n);
    render();
    app.querySelector(`[data-material="${n}"]`)?.focus({preventScroll:true});
  } else if (target.id==='web') web=target.value;
  else if (target.id==='targetTag') targetTag=target.value;
  else if (target.id==='memory') { memoryEnabled=target.checked; notify(memoryEnabled?'已开启本对话记忆':'已关闭本对话记忆'); }
  else if (target.id==='skill') { useSkill=target.checked; notify(useSkill?'已选用核对技能':'已移除核对技能'); }
});
app.addEventListener('click', async event => {
  const control=event.target.closest('button[data-action]');
  if (!control) return;
  const {action,value}=control.dataset;
  switch(action) {
    case 'variant': {
      variant=value;
      const url = new URL(location.href); url.searchParams.set('view',variant); history.replaceState(null,'',url);
      render(); app.querySelector(`.variants [data-value="${variant}"]`)?.focus({preventScroll:true}); break;
    }
    case 'sample': loadChat(chats[0]); break;
    case 'new': resetChat(); break;
    case 'open': panel()===value?goBack():navigate(value); break;
    case 'next': navigate(value,true); break;
    case 'back': goBack(); break;
    case 'close': { stack=[]; search=''; render(); app.querySelector('.tool-end [data-value="details"]')?.focus({preventScroll:true}); break; }
    case 'mode': mode=value; topic=null; stack=[]; render(); break;
    case 'memory-tab': memoryTab=value; render(); break;
    case 'check-topic':
      topicReview=topics.find(t=>t.id===value);
      if (panel()==='topic-review') render(true);
      else navigate('topic-review',true);
      break;
    case 'apply-topic': topic=topicReview; selected=[...topic.scope]; stack=[]; render(); notify('已应用专题及资料范围'); break;
    case 'pin': {
      if (pins.has(value)) pins.delete(value); else pins.add(value);
      app.querySelector('#filterResults').innerHTML=topicRows();
      app.querySelector(`[data-action="pin"][data-value="${value}"]`)?.focus({preventScroll:true}); break;
    }
    case 'source': source=Number(value); navigate('source',true); break;
    case 'chat': loadChat(chats.find(chat=>chat.id===value)); break;
    case 'archive': {
      if (archived.has(value)) archived.delete(value); else archived.add(value);
      app.querySelector('#filterResults').innerHTML=historyResults(); notify(showArchive?'已恢复示例对话':'已归档示例对话'); break;
    }
    case 'show-archive': showArchive=!showArchive; search=''; render(true); break;
    case 'suggestion': draft=value; render(); app.querySelector('#question')?.focus(); break;
    case 'send': send(); break;
    case 'stop': clearInterval(timer); phase='stopped'; processOpen=false; render(); break;
    case 'retry': draft=posted; phase='empty'; render(); app.querySelector('#question')?.focus(); break;
    case 'process': processOpen=!processOpen; render(); app.querySelector('.activity-toggle')?.focus({preventScroll:true}); break;
    case 'copy': {
      const answer=app.querySelector('.answer');
      const words = [answer.querySelector('h2').textContent,...[...answer.querySelectorAll('p')].map(p=>p.textContent)].join('\n\n');
      try { await navigator.clipboard.writeText(words); copied=true; render(); notify('已复制回答'); }
      catch { notify('浏览器未允许复制，可选中文字复制'); }
      break;
    }
    case 'save': draftNote=app.querySelector('.answer h2')?.textContent || '前门线束评审小结'; navigate('save',true); break;
    case 'confirm-save':
      if (!draftNote.trim()) { notify('请填写笔记内容'); break; }
      saved=true;stack=[];render();notify('已保存到示例记录');break;
    case 'model': model=value; stack=[]; render(); break;
  }
});
document.addEventListener('keydown', event => {
  if (event.isComposing) return;
  if (event.key==='Escape' && panel()) { event.preventDefault(); goBack(); }
  else if (event.key==='Enter' && (event.ctrlKey || event.metaKey) && event.target.id==='question') { event.preventDefault(); send(); }
});
render();
