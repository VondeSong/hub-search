const variants = {a: '阅读浮窗', b: '原文并排', c: '任务工作台'};
const documents = [
  {label: '前门线束评审记录', kind: '评审纪要', excerpt: '接口与连接器位置已对齐。固定点随试装件复核，压接规格以最新端子图纸为准。'},
  {label: '连接器接口清单', kind: '资料表', excerpt: '连接器编号与接口定义可作为设计输入。端子压接参数以供应商图纸为准。'},
  {label: '试装问题记录', kind: '现场记录', excerpt: '复核前门内板的固定点与卡扣手部可达性。试装后补回装配位置照片。'},
  {label: '前门试装照片', kind: '资料库文件', unavailable: true},
];
const recipes = [
  {id: 'front', label: '线束评审核对', files: [0, 1], policy: 'only', library: false, skills: ['资料分析与核对']},
  {id: 'record', label: '试装记录核对', files: [2, 3], policy: 'only', library: false, skills: []},
  {id: 'weekly', label: '每周问题回顾', files: [0, 2], policy: 'first', library: true, skills: []},
];
const chats = [
  {id:'review', label:'前门线束评审核对', date:'今天', question:'梳理评审结论，区分已确认项和待复核项。', title:'前门线束评审小结', files:[0,1,2], evidence:[1,0], condition:'逐项记下设计依据和待复核项'},
  {id:'mount', label:'卡扣安装位置核对', date:'昨天', question:'这份试装记录里还有哪些没确认？', title:'卡扣安装复核小结', files:[2], evidence:[2]},
  {id:'interface', label:'接口清单检查', date:'昨天', question:'整理接口清单的确认条件。', title:'接口清单检查小结', files:[1], evidence:[1]},
];
const priorWork = {id:'period', label:'10 月装配问题复核', question:'核对 10 月装配问题与复核进展。', title:'10 月装配复核小结', files:[0,2], evidence:[2], method:'每期装配问题复核 · 第 2 版'};
const resultLines = {
  0: {heading:'待复核', text:'固定点需在试装复核，压接规格等最新端子图纸。'},
  1: {heading:'已确认', text:'连接器编号和接口定义可作为设计输入。'},
  2: {heading:'待复核', text:'复核卡扣可达性，补齐装配位置照片。'},
};
const progressSteps = ['核对请求与可用资料', '读取资料并整理发现', '生成回答与来源'];
const suggestions = [['FileText','概括已有资料'], ['ListChecks','提取待办与复核项'], ['SearchCheck','核对结论的依据']];
const board = document.querySelector('#app');
const safe = value => String(value ?? '').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const svg = name => icons[name] ?? '';
const initialVariant = new URL(location.href).searchParams.get('view');
let variant = Object.hasOwn(variants, initialVariant) ? initialVariant : document.documentElement.dataset.variant;
let currentChat, draft, turns, tasks, queued, runTimer;
let stack = [], scopeEdit, recipeReview, panelTrigger, search = '', showArchive = false;
let selectedTurn, original = 0, citation = 0, material = 0, actionDraft, prepared, selectedReceipt;
let month = '2026-11', monthConsent = false, periodWork;
let toastTimer, memoryView = '当前空间';
const pinned = new Set(['front']);
const archived = new Set();
const latest = () => turns.at(-1);
const running = () => latest()?.status === 'running';
const panel = () => stack.at(-1);

function button(label, action, value = '', icon = '', className = 'soft-button', disabled = false) {
  return `<button type="button" class="${className}" data-action="${action}" data-value="${safe(value)}"${disabled?' disabled':''}>${svg(icon)}<span>${safe(label)}</span></button>`;
}
function iconButton(icon, label, action, value = '', disabled = false) {
  return `<button type="button" class="icon-button" data-action="${action}" data-value="${safe(value)}" aria-label="${label}" title="${label}"${disabled?' disabled':''}>${svg(icon)}</button>`;
}
function row(icon, label, status, action, value = '') {
  return `<button class="settings-row" type="button" data-action="${action}" data-value="${safe(value)}">${svg(icon)}<strong>${safe(label)}</strong>${status?`<span>${safe(status)}</span>`:''}${svg('ChevronRight')}</button>`;
}
function group(title, content) { return `<section class="settings-group"><h3>${title}</h3>${content}</section>`; }
function selectField(id, label, values, selected, disabled = false) {
  return `<label class="config-row"><span>${label}</span><select id="${id}"${disabled?' disabled':''}>${Object.entries(values).map(([key,value])=>`<option value="${safe(key)}"${key===selected?' selected':''}>${safe(value)}</option>`).join('')}</select></label>`;
}
const options = values => Object.fromEntries(values.map(value=>[value,value]));

function launch(chat) {
  clearInterval(runTimer);
  if (turns && running()) latest().status='stopped';
  currentChat = chat?.label ?? '';
  draft = newRequestDraft(chat?.files);
  if (chat?.method) {
    draft.fixedMethod = chat.method;
    draft.scope.policy = 'only';
  }
  turns = [];
  tasks = [];
  stack = [];
  queued = null;
  search = '';
  original = chat?.files[0] ?? 0;
  if (chat) {
    const setup = {...draft, text:chat.question, fixedMethod:chat.method, pattern:chat.condition?'goal':'ask', condition:chat.condition??''};
    const result = {title:chat.title, evidence:chat.evidence};
    turns.push(addTurn(prepareRequest(setup).request,result));
  }
  render();
}
function focusQuestion() { board.querySelector('#question')?.focus({preventScroll:true}); }
function navigate(key, nested = false, trigger = document.activeElement) {
  if (!nested || !panel()) panelTrigger = trigger?.dataset;
  stack = nested && panel() ? [...stack,key] : [key];
  if (key==='scope') scopeEdit = {...draft.scope, files:[...draft.scope.files], merge:draft.includeManual};
  if (key==='period') monthConsent=false;
  search = '';
  render(true);
}
function closePanel(all = false) {
  const leaving = panel();
  stack = all ? [] : stack.slice(0,-1);
  search = '';
  render(!!panel());
  const controls = [...board.querySelectorAll('button[data-action]')];
  const target = panel() ? controls.find(control=>control.closest('.sheet')&&control.dataset.value===leaving)
    : controls.find(control=>control.dataset.action===panelTrigger?.action&&control.dataset.value===panelTrigger?.value&&control.checkVisibility());
  target?.focus({preventScroll:true});
}
function notice(message) {
  const toast = board.querySelector('.toast');
  toast.textContent = message;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(()=>toast.textContent='',3300);
}
function submit() {
  if (running() && queued) { notice('已有排队请求。可移出队列后再发送。'); return; }
  const {request,error,field} = prepareRequest(draft);
  if (error) {
    if (field==='question') focusQuestion();
    else navigate(field);
    if (field==='question') notice(error);
    else previewStatus(error);
    return;
  }
  draft.text = '';
  draft.includeManual = false;
  if (running()) {
    queued = request;
    render();
    focusQuestion();
    return;
  }
  begin(request);
}
function addTurn(request, result = null) {
  let taskId = request.taskId;
  if (request.pattern==='goal' && !taskId) {
    const task = createTask(tasks.length+1,request);
    tasks.push(task);
    taskId = task.id;
  }
  return createTurn(turns.length+1,request,taskId,result);
}
function begin(request) {
  const turn = addTurn(request);
  turns.push(turn);
  currentChat ||= request.text;
  stack = [];
  render();
  const list = board.querySelector('.messages');
  list.scrollTop = list.scrollHeight;
  focusQuestion();
  runTimer = setInterval(()=>{
    turn.step++;
    if (turn.step===progressSteps.length) {
      clearInterval(runTimer);
      turn.status = 'complete';
      turn.result = {
        title: request.pattern==='tag' ? request.tagTask+' · '+request.tag : '本轮回答',
        evidence: request.files.slice(0,2),
      };
    }
    refreshRun(turn);
  },1200);
}
function refreshRun(turn) {
  const node = board.querySelector(`[data-turn="${turn.id}"]`);
  const list = board.querySelector('.messages');
  const follow = list.scrollHeight-list.scrollTop-list.clientHeight < 48;
  if (node) {
    const body = node.querySelector('.turn-response');
    body.innerHTML = response(turn);
  }
  board.querySelector('.work-rail')?.replaceWith(document.createRange().createContextualFragment(workRail()));
  if (panel()==='record' && selectedTurn===turn) board.querySelector('.sheet-body').innerHTML = runRecord(turn);
  if (turn.status!=='running') {
    board.querySelector('.composer-actions').innerHTML = composerActions();
    board.querySelector('.queue')?.replaceWith(document.createRange().createContextualFragment(queueRow()));
  }
  if (follow) list.scrollTop = list.scrollHeight;
  syncSend();
}

function reviewBar() {
  return `<header class="review">
    <div class="review-brand"><span class="hub-logo">${svg('Layers')}</span><span><strong>Hub Agents</strong><small>设计评审</small></span></div>
    <nav class="variants" aria-label="切换工作方式">${Object.entries(variants).map(([key,name])=>`<button type="button" data-action="variant" data-value="${key}" aria-pressed="${variant===key}"><b>${key.toUpperCase()}</b> ${name}</button>`).join('')}</nav>
    <div class="review-state">${button('恢复示例','sample','','RotateCcw')}</div>
  </header>`;
}
function toolbar() {
  const title = currentChat || '新对话';
  return `<header class="toolbar">
    <div class="tool-start">${iconButton('Menu','对话历史','open','history')}${iconButton('Plus','新聊天','new')}</div>
    <div class="session-name"><span title="${safe(title)}">${safe(title)}</span></div>
    <div class="tool-end">${variant==='c'?'':iconButton('FolderBookmark','笔记关联工作','open','linked')}
    ${iconButton('SlidersHorizontal','助手设置','open','settings')}</div>
  </header>`;
}
function desk() {
  const quote = variant==='b' && panel()==='evidence';
  const shown = quote ? citation : original;
  const doc = documents[shown];
  return `<div class="desk" ${variant==='a'?'aria-hidden="true"':''}><div class="desk-doc">
    <div class="desk-path">${svg('FolderOpen')} Obsidian <span>/</span> 线束设计 <span>/</span> ${doc.kind}</div>
    <div class="doc-heading"><h2>${doc.label}</h2>${quote?button('返回回答','back','','ArrowLeft'):''}</div>
    <p class="desk-meta">评审资料 · 示例原文</p><div class="paper-rule"></div>
    <h3>${shown===0?'连接器接口':'原文摘录'}</h3><p>${quote?'<mark class="source-highlight">'+doc.excerpt+'</mark>':doc.excerpt}</p>
    ${shown===0?`<dl class="paper-data"><div><dt>接口清单</dt><dd>已核对</dd></div><div><dt>固定点</dt><dd>待试装复核</dd></div><div><dt>压接规格</dt><dd>待端子图纸</dd></div></dl><h3>试装复核</h3><p>查看卡扣可达性，补齐固定点照片和端子规格。</p>`:''}
  </div></div>`;
}
function workRail() {
  const task = tasks.at(-1);
  if (!task) return `<aside class="work-rail" aria-label="任务">${row('Target','建立任务','','start-goal')}</aside>`;
  const recent = turns.findLast(turn=>turn.taskId===task.id);
  const status = recent.status;
  const state = status==='running'?'进行中':status==='stopped'?'已停止':task.accepted?'已确认完成':'有回答待验收';
  return `<aside class="work-rail" aria-label="任务">
    <h2>任务</h2><p class="work-goal">${safe(task.goal)}</p>
    ${task.condition?`<div class="goal-condition"><span>完成条件</span><p>${safe(task.condition)}</p></div>`:''}
    <div class="work-state" data-phase="${status}"><i></i>${state}</div>
    ${button('查看任务记录','record',recent.id,'Activity')}
    ${!task.accepted&&status!=='running'?button('继续此任务','continue-task',task.id,'ArrowRight'):''}
  </aside>`;
}
function turnInput(turn) {
  const request = turn.request;
  return `<div class="turn-request"><div class="user-message">${safe(request.text)}</div>
    ${request.pattern==='goal' && request.condition ? `<p class="request-condition">完成条件 · ${safe(request.condition)}</p>`:''}
    ${request.pattern==='tag' ? `<p class="request-condition">${request.tagTask} · #${safe(request.tag)}${request.compareTag?' / #'+safe(request.compareTag):''}</p>`:''}
    </div>`;
}
function activity(turn) {
  const label = turn.status==='running' ? progressSteps[turn.step] : '本轮已停止';
  return `<div class="activity" role="status">
    ${button(label,'record',turn.id,'Activity','soft-button activity-toggle')}
    ${turn.status==='stopped'?button('重用原问题','edit-turn',turn.id,'','button'):''}
    </div>`;
}
function response(turn) {
  if (!turn.result) return activity(turn);
  const {result} = turn;
  return `<article class="answer">
    <div class="answer-author"><span class="assistant-symbol">${svg('Layers')}</span><strong>Hub 助手</strong></div>
    <h2>${safe(result.title)}</h2>
    ${result.evidence.length?`<div class="findings">${result.evidence.map((doc,i)=>{
      const entry = resultLines[doc];
      return `<div><span class="finding-mark ${entry.heading==='已确认'?'confirmed':'pending'}">${svg(entry.heading==='已确认'?'Check':'CircleDot')}</span><div><h3>${entry.heading}</h3><p>${entry.text} <button type="button" class="cite" data-action="cite" data-value="${turn.id}:${doc}" aria-label="查看来源：${documents[doc].label}">${i+1}</button></p></div></div>`;
    }).join('')}</div>`:`<p class="lead">当前没有资料可用于核对。你可以补充相关记录，再检查具体结论。</p>`}
    <div class="answer-actions">
      ${button('本轮记录','record',turn.id,'Activity')}
      ${button('复制','copy',turn.id,'Copy')}
      ${button('保存回答','save-target',turn.id,'NotebookPen')}
    </div>
    ${turn.saves.map(item=>`<div class="answer-receipt">${row('NotebookPen',item.state==='verified'?'已保存并核验':'保存待核对',item.preview.target,'receipt',turn.id+':'+item.id)}</div>`).join('')}
  </article>`;
}
function messages() {
  if (!turns.length) return `<div class="welcome"><div class="welcome-head"><span class="assistant-symbol">${svg('Layers')}</span><h2>你想处理什么？</h2></div><div class="quick" aria-label="对话建议">${suggestions.map(([icon,label])=>button(label,'suggestion',label,icon,'quick-action')).join('')}</div></div>`;
  return `<div class="thread-body">${turns.map(turn=>`<section class="turn" data-turn="${turn.id}">${turnInput(turn)}<div class="turn-response">${response(turn)}</div></section>`).join('')}</div>`;
}
function composerActions() {
  return `<div class="input-actions">${button('执行设置','open','execution','SlidersHorizontal','soft-button')}
      </div><div class="input-actions right">
      ${running() ? button('停止','stop','','Square','soft-button') : ''}
      ${button(running()?'排队追问':'发送','send','',running()?'CornerDownLeft':'ArrowUp','send-button primary',true)}
    </div>`;
}
function queueRow() {
  return queued ? `<div class="queue"><span><strong>排队中</strong> ${safe(queued.text)}</span>${button('查看请求','open','queued')}${running()?'':button('继续执行','dequeue','','ArrowRight')}${iconButton('X','移出队列','drop-queue')}</div>` : '';
}
function composer() {
  const requested = resolveDraft(draft);
  const scopeLabel = requested.files.length ? requested.files.length+' 份资料'+(requested.library?' · 1 个库':'') : requested.library ? '1 个可检索库' : '添加资料';
  return `<div class="compose-wrap">
    ${queueRow()}
    <div class="composer">
      <div class="draft-context">
        <span class="draft-caption">${turns.length?'下一条':'请求'}</span>
        ${button(workPatterns[draft.pattern],'open','intent','ChevronDown','context-button')}
        ${button(scopeLabel,'open','scope','Layers','context-button')}
        ${draft.fixedMethod?`<span class="fixed-method">${svg('FolderBookmark')}固定方法</span>`:button(draft.recipe?.label??'使用模板','open','recipes','FolderBookmark','context-button')}
      </div>
      ${draft.pattern==='goal' && draft.condition?`<p class="draft-condition">${safe(draft.condition)}</p>`:''}
      <textarea id="question" rows="2" aria-label="给 Hub 助手的消息" placeholder="${turns.length?'继续追问…':'输入要处理的问题…'}">${safe(draft.text)}</textarea>
      <div class="composer-actions composer-tools">${composerActions()}</div>
    </div><span class="compose-hint">交互示例 <kbd>Ctrl</kbd> + <kbd>Enter</kbd> 发送</span>
  </div>`;
}
function historyRows(items = chats.filter(chat=>archived.has(chat.id)===showArchive && chat.label.includes(search.trim()))) {
  return items.length ? items.map(chat=>`<div class="list-row history-row">
    <button type="button" data-action="chat" data-value="${chat.id}">${svg('Clock')}<span><strong>${chat.label}</strong><small>${chat.date} · 2 条消息</small></span></button>
    ${iconButton(showArchive?'RotateCcw':'Archive',showArchive?'恢复对话':'归档对话','archive',chat.id)}
  </div>`).join('') : `<p class="empty-list">${search?'没有匹配的对话':'这里还没有对话'}</p>`;
}
function searchBox(label, results) {
  return `<label class="search">${svg('Search')}<input id="panelSearch" type="search" aria-label="${label}" placeholder="${label}" value="${safe(search)}"></label><div id="filterResults" class="list">${results}</div>`;
}
function recipeRows() {
  const items = recipes.filter(item=>item.label.includes(search.trim())).sort((a,b)=>Number(pinned.has(b.id))-Number(pinned.has(a.id)));
  return items.length ? items.map(item=>`<div class="list-row topic-row">
    ${button(item.label,'review-recipe',item.id,'FolderBookmark')}
    <button type="button" class="icon-button row-action" data-action="pin" data-value="${item.id}" aria-pressed="${pinned.has(item.id)}" aria-label="置顶或取消置顶 ${item.label}">${svg('Pin')}</button>
  </div>`).join('') : '<p class="empty-list">没有匹配的模板</p>';
}
function picker() {
  if (draft.fixedMethod) return group(draft.fixedMethod,`<ul class="record-inputs">${draft.scope.files.map(n=>`<li>${documents[n].label}</li>`).join('')}</ul>`)+
    '<p class="muted inline-note">本期采用已授权的固定范围。</p>';
  const files = documents.map((doc,index)=>`<div class="material-row">
      <label><input type="checkbox" data-file="${index}" ${scopeEdit.files.includes(index)?'checked':''} ${doc.unavailable?'disabled':''}>
      <span><strong>${doc.label}</strong><small>${doc.unavailable?'当前不可用':doc.kind}</small></span></label>
      ${doc.unavailable?'':iconButton('ArrowUpRight','预览 '+doc.label,'material',index)}
    </div>`).join('');
  return `${draft.recipe?`<p class="status-note">当前使用「${draft.recipe.label}」。下方是手选范围。</p>`:
       selectField('policy','资料策略',sourcePolicy,scopeEdit.policy)}
    ${group('核心资料',files)}
    ${group('检索范围',`<label class="toggle-row"><span>线束设计库</span><input id="scopeLibrary" type="checkbox" ${scopeEdit.library?'checked':''}></label>`)}
    ${draft.recipe?`<label class="toggle-row"><span>下一条合并手选资料与技能</span><input id="scopeMerge" type="checkbox" ${scopeEdit.merge?'checked':''}></label>`:''}
    <div class="panel-footer"><span class="muted" id="scopeCount">${scopeEdit.files.length} 份手选资料</span>${button('应用到下一条','apply-scope','','','primary')}</div>`;
}
function execution() {
  const effective = resolveDraft(draft);
  const lockedSearch = effective.policy==='only' || draft.model==='DeepSeek';
  return `${selectField('model','模型',options(['GPT-6.2 Sol','GPT-6.2 Astra','DeepSeek']),draft.model)}
    ${selectField('search','联网搜索',options(['关闭','缓存搜索','实时搜索']),effective.search,lockedSearch)}
    <label class="toggle-row"><span>使用已保存记忆${effective.policy==='only'?'<small>仅用所选资料时暂停</small>':''}</span><input id="memory" type="checkbox" ${effective.memory?'checked':''} ${effective.policy==='only'?'disabled':''}></label>
    <label class="toggle-row"><span>资料分析与核对<small>手选技能</small></span><input id="skill" type="checkbox" ${draft.skill?'checked':''}></label>
    ${lockedSearch?`<p class="muted inline-note">${effective.policy==='only'?'当前资料策略限制外部来源。':'当前模型不支持此处的联网搜索。'}</p>`:''}
    <div class="panel-footer">${button('完成','back','','','primary')}</div>`;
}
function requestSummary(request) {
  const sources = request.files.length ? request.files.map(n=>`<li>${documents[n].label}</li>`).join('') : '<li>未指定核心资料</li>';
  return `<dl class="record-config">
    <div><dt>处理方式</dt><dd>${workPatterns[request.pattern]}${request.method?' · '+safe(request.method):''}</dd></div>
    <div><dt>来源规则</dt><dd>${sourcePolicy[request.policy]}${request.library?' · 可检索线束设计库':''}</dd></div>
    <div><dt>执行设置</dt><dd>${request.model} · 联网${request.search} · 记忆${request.memory?'开启':'关闭'}</dd></div>
    ${request.skills.length?`<div><dt>技能</dt><dd>${safe(request.skills.join('、'))}</dd></div>`:''}
    </dl>${group('提交时指定的资料',`<ul class="record-inputs">${sources}</ul>`)}`;
}
function runRecord(turn) {
  const sources = turn.result?.evidence ?? [];
  const task = tasks.find(item=>item.id===turn.taskId);
  const current = task && turns.findLast(item=>item.taskId===task.id)===turn;
  const log = `<ol class="steps">${progressSteps.map((text,index) => `<li data-status="${index<turn.step?'done':index===turn.step&&turn.status==='running'?'running':'waiting'}"><span class="step-mark">${index<turn.step?svg('Check'):''}</span><strong>${text}</strong></li>`).join('')}</ol>`;
  return `${requestSummary(turn.request)}
    ${turn.result?group('回答引用',sources.length?sources.map(n=>row('FileText',documents[n].label,'','cite',turn.id+':'+n)).join(''):'<p class="muted inline-note">本轮没有资料引用。</p>'):''}
    ${turn.result?`<details class="advanced record-log"><summary>${svg('ChevronDown')}运行过程</summary>${log}</details>`:group('运行过程',log)}
    ${turn.result&&current?group('验收',task.accepted?'<p class="status-note">用户已确认任务完成。</p>':
      `<p class="muted inline-note">${safe(task.condition||'按任务目标核对回答。')}</p><div class="panel-footer">${button('确认任务完成','accept-task',task.id,'Check','button',queued?.taskId===task.id)}</div>`):''}`;
}

function intent() {
  const labels = ['线束设计','试装复核','接口核对'];
  return `${selectField('pattern','处理方式',workPatterns,draft.pattern)}
    ${draft.pattern==='goal'? `<label class="form-field">完成条件<input id="condition" placeholder="例如：列出每项待复核问题及依据" value="${safe(draft.condition)}"${draft.taskId?' readonly':''}></label>` : ''}
    ${draft.taskId?`<p class="muted inline-note">继续当前任务，沿用原完成条件。</p>`:''}
    ${draft.pattern==='tag'?selectField('tagTask','标签任务',options(['起草定义','查找漏标','比较关系']),draft.tagTask)+
       selectField('tag','目标标签',options(labels),draft.tag)+
       (draft.tagTask==='比较关系'?selectField('compareTag','对照标签',options(labels),draft.compareTag):''):''}
    <div class="panel-footer">${button('完成','back','','','primary')}</div>`;
}
function reviewRecipe() {
  const missing = recipeReview.files.filter(n=>documents[n].unavailable);
  return `<h3 class="panel-item-title">${recipeReview.label}</h3>
    ${group('下次发送时使用',recipeReview.files.map(n=>`<div class="material-row"><span>${documents[n].label}</span><small class="${missing.includes(n)?'unavailable':'muted'}">${missing.includes(n)?'不可用':'可用'}</small></div>`).join('')+
    `<p class="muted inline-note">${sourcePolicy[recipeReview.policy]}${recipeReview.library?' · 可检索线束设计库':''}${recipeReview.skills.length?' · '+recipeReview.skills.join('、'):''}</p>`)}
    ${missing.length?'<p class="status-note attention">部分资料不可用。确认后使用剩余资料。</p>':''}
    <div class="panel-footer">${button(missing.length?'仅用剩余资料':'用于下一条','apply-recipe','','','primary')}</div>`;
}
function fixedWork() {
  if (month==='2026-10'||periodWork) return `<p class="status-note">${month} 有已建立的工作。</p>
    <div class="panel-footer">${button('打开原工作',month==='2026-10'?'open-prior':'open-period','','','primary')}</div>`;
  return `${group('本期固定资料',[0,2].map(n=>row('FileText',documents[n].label,'','material',n)).join(''))}
    <label class="toggle-row"><span>授权读取以上资料</span><input id="periodConsent" type="checkbox" ${monthConsent?'checked':''}></label>
    <div class="panel-footer">${button('创建并打开本期工作','create-period','','','primary',!monthConsent)}</div>`;
}
function answerText(turn) {
  return turn.result.evidence.map(index=>resultLines[index].text).join('\n') || '当前没有资料可用于核对。';
}
function writeDraft() {
  return `<p class="muted">${actionDraft.type}</p>
    <label class="form-field">写入位置<input id="writeTarget" value="${safe(actionDraft.target)}"></label>
    <label class="form-field">标题<input id="writeTitle" value="${safe(actionDraft.title)}"></label>
    <label class="form-field">内容<textarea id="writeBody" rows="5">${safe(actionDraft.body)}</textarea></label>
    <div class="panel-footer">${button('预览写入','prepare-write','','','primary')}</div>`;
}
function writeSummary(item) {
  return `<p class="muted">${item.type} · ${safe(item.target)}</p><h3 class="panel-item-title">${safe(item.title)}</h3><blockquote>${safe(item.body)}</blockquote>`;
}
function bodyOf(key) {
  switch(key) {
    case 'scope': return picker();
    case 'intent': return intent();
    case 'execution': return execution();
    case 'recipes': return (draft.recipe?`<div class="selected-recipe"><span>已选 · ${draft.recipe.label}</span>${button('移除','drop-recipe')}</div>`:'')+searchBox('搜索研究模板',recipeRows());
    case 'recipe-review': return reviewRecipe();
    case 'record': return runRecord(selectedTurn);
    case 'queued': return `<p>${safe(queued.text)}</p>${requestSummary(queued)}`;
    case 'evidence':
    case 'material': {
      const doc = documents[key==='evidence'?citation:material];
      return `<h3 class="panel-item-title">${doc.label}</h3><p class="muted">${doc.kind} · 示例原文</p><blockquote>${doc.excerpt}</blockquote>`;
    }
    case 'settings': return row('Brain','管理记忆','','next','memory')+
      row('Globe2','外部工具（MCP）','','next','tools');
    case 'memory': return selectField('memoryView','查看范围',options(['当前空间','全局']),memoryView)+
      `<p class="empty-list">${memoryView==='当前空间'?'本空间没有待确认的记忆。':'全局没有待确认的记忆。'}</p>`;
    case 'tools': return '<p class="empty-list">评审示例尚未连接外部工具。</p>';
    case 'linked': return group('每期装配问题复核','<p class="muted inline-note">固定方法第 2 版 · 核对评审与试装问题</p>')+
      selectField('month','工作周期',options(['2026-11','2026-10']),month)+
      `<div class="panel-footer">${button('查找或准备本期工作','next','period','','primary')}</div>`;
    case 'period': return fixedWork();
    case 'save-target': return [
      ['FileText','插入到页面','Obsidian / 前门线束评审记录'],
      ['NotebookPen','新建笔记','Obsidian / 线束设计'],
      ['ListChecks','创建任务','滴答清单 / 线束复核'],
    ].map(([icon,title,target])=>row(icon,title,target,'write',title)).join('');
    case 'write': return writeDraft();
    case 'write-preview': return writeSummary(prepared)+`<div class="panel-footer">${button('返回编辑','back','','','button')}${button('确认写入','confirm-write','','','primary')}</div>`;
    case 'receipt': return `<p class="status-note ${selectedReceipt.state==='verified'?'':'attention'}">${selectedReceipt.state==='verified'?'已回读目标位置，内容一致。':'保存结果待核对。请先核对目标位置。'}</p>`+
      writeSummary(selectedReceipt.preview)+(selectedReceipt.state==='verified'?'':`<div class="panel-footer">${button('核对保存结果','verify','','','primary')}</div>`);
    case 'history': return searchBox('搜索对话标题',historyRows())+`<div class="panel-footer">${button(showArchive?'返回最近对话':'已归档的对话','archive-view','','Archive','button')}</div>`;
    default: return '';
  }
}
const titles = {
  scope:'下一条资料范围', intent:'下一条处理方式', execution:'下一条执行设置', recipes:'研究模板',
  'recipe-review':'复核研究模板', record:'本轮记录', queued:'排队请求', evidence:'引用原文', material:'资料预览',
  settings:'助手设置', memory:'管理记忆', tools:'外部工具', linked:'笔记关联工作', period:'本期工作',
  'save-target':'保存回答', write:'编辑写入内容', 'write-preview':'确认写入', receipt:'保存回执', history:'对话历史',
};
const contextual = ['scope','intent','execution','recipes','recipe-review','record','queued','evidence','material','save-target','write','write-preview','receipt'];
function sheet(key, placement) {
  const previous = stack.at(-2);
  const title = key==='history'&&showArchive?'已归档的对话':titles[key];
  return `<section class="sheet ${placement}" data-panel="${key}" aria-label="${title}"><header class="sheet-head">
    ${previous?iconButton('ArrowLeft','返回'+titles[previous],'back'):''}
    <h2 tabindex="-1">${title}</h2>${iconButton('X','关闭'+title,'close')}
    </header><div class="sheet-body">${bodyOf(key)}</div></section>`;
}
function render(focusPanel = false) {
  document.documentElement.dataset.variant = variant;
  document.title = 'Hub Agents · '+variants[variant];
  const key = panel();
  const docked = variant==='c' && contextual.includes(key);
  const scroll = board.querySelector('.messages')?.scrollTop ?? 0;
  board.innerHTML = reviewBar()+`<main class="stage">${variant==='a'?desk():''}
    <section class="workspace ${variant==='a'?'floating':'full-workspace'}${docked?' has-context':''}" aria-label="Hub 助手">
      ${variant==='b'?desk():''}${toolbar()}
      <div class="conversation"><div class="messages">${messages()}</div>${composer()}</div>
      ${variant==='c'&&!docked?workRail():''}
      ${key?sheet(key,docked?'context-sheet':'float-sheet'+(variant==='b'&&key==='evidence'?' source-sheet':'')):''}
    </section></main><div class="toast" role="status" aria-live="polite"></div>`;
  board.querySelector('.messages').scrollTop = scroll;
  if (focusPanel) {
    const backToAnswer = board.querySelector('.doc-heading button');
    (backToAnswer?.checkVisibility() ? backToAnswer : board.querySelector('#panelSearch') ?? board.querySelector('.sheet h2'))?.focus({preventScroll:true});
  }
  syncSend();
}
function syncSend() { board.querySelector('[data-action=send]').disabled = !draft.text.trim(); }
function locateTurn(id) { return turns.find(turn=>turn.id===Number(id)); }
function openReceipt(turn, receipt) {
  selectedTurn = turn;
  selectedReceipt = receipt;
  navigate('receipt');
}
function openPeriod(create = false) {
  if (!create && periodWork?.draft===draft) { closePanel(true); return; }
  if (create) {
    const setup = newRequestDraft([0,2]);
    setup.fixedMethod = '每期装配问题复核 · 第 2 版';
    setup.scope.policy = 'only';
    setup.text = '核对 11 月的装配问题与复核进展';
    periodWork = {label:'11 月装配问题复核',draft:setup,turns:[],tasks:[]};
  }
  clearInterval(runTimer);
  if (running()) latest().status='stopped';
  currentChat = periodWork.label;
  draft = periodWork.draft;
  turns = periodWork.turns;
  tasks = periodWork.tasks;
  queued = null;
  stack = [];
  render();
  focusQuestion();
}
function previewStatus(message) {
  const errors = board.querySelector('.sheet-body');
  if (!errors) return notice(message);
  let node = errors.querySelector('.form-warning');
  if (!node) {
    node = document.createElement('p');
    node.className = 'form-warning status-note attention';
    node.setAttribute('role','alert');
    errors.prepend(node);
  }
  node.textContent = message;
}

board.addEventListener('input', event=>{
  const input = event.target;
  switch(input.id) {
    case 'question': draft.text = input.value; syncSend(); break;
    case 'condition': draft.condition = input.value; break;
    case 'writeTarget': actionDraft.target = input.value; break;
    case 'writeTitle': actionDraft.title = input.value; break;
    case 'writeBody': actionDraft.body = input.value; break;
    case 'panelSearch':
      search=input.value;
      board.querySelector('#filterResults').innerHTML=panel()==='history'?historyRows():recipeRows();
      break;
  }
});
board.addEventListener('change', event=>{
  const input = event.target;
  if (input.dataset.file!==undefined) {
    const n = Number(input.dataset.file);
    scopeEdit.files = input.checked ? [...scopeEdit.files,n] : scopeEdit.files.filter(file=>file!==n);
    board.querySelector('#scopeCount').textContent=scopeEdit.files.length+' 份手选资料';
    return;
  }
  switch(input.id) {
    case 'policy': scopeEdit.policy=input.value; break;
    case 'scopeLibrary': scopeEdit.library=input.checked; break;
    case 'scopeMerge': scopeEdit.merge=input.checked; break;
    case 'periodConsent': monthConsent=input.checked; board.querySelector('[data-action=create-period]').disabled=!monthConsent; break;
    case 'month': month=input.value; monthConsent=false; break;
    case 'memoryView': memoryView=input.value; render(true); break;
    default: {
      if (Object.hasOwn(draft,input.id)) {
        draft[input.id] = input.type==='checkbox'?input.checked:input.value;
        if (input.id==='pattern'&&input.value!=='goal') draft.taskId=null;
        if (['pattern','tagTask','model'].includes(input.id)) {
          render();
          board.querySelector('#'+input.id)?.focus();
        }
      }
    }
  }
});
board.addEventListener('click', async event=>{
  const control = event.target.closest('button[data-action]');
  if (!control) return;
  const {action,value} = control.dataset;
  switch(action) {
    case 'variant': {
      variant=value;
      const url = new URL(location.href);
      url.searchParams.set('view',variant);
      history.replaceState(null,'',url);
      render();
      board.querySelector(`.variants [data-value="${variant}"]`)?.focus();
      break;
    }
    case 'sample': launch(chats[0]); break;
    case 'new': launch(); focusQuestion(); break;
    case 'open': panel()===value?closePanel():navigate(value,false,control); break;
    case 'next': navigate(value,true,control); break;
    case 'back': closePanel(); break;
    case 'close': closePanel(true); break;
    case 'suggestion': draft.text=value; render(); focusQuestion(); break;
    case 'start-goal': draft.taskId=null; draft.pattern='goal'; navigate('intent',false,control); break;
    case 'continue-task': {
      const task=tasks.find(item=>item.id===Number(value));
      draft.taskId=task.id;
      draft.pattern='goal';
      draft.condition=task.condition;
      render();
      focusQuestion();
      break;
    }
    case 'apply-scope': {
      const {files,library,policy,merge}=scopeEdit;
      draft.scope={files,library,policy};
      if (draft.recipe) draft.includeManual=merge??false;
      closePanel();
      break;
    }
    case 'review-recipe': recipeReview=recipes.find(recipe=>recipe.id===value); navigate('recipe-review',true,control); break;
    case 'pin':
      pinned.has(value)?pinned.delete(value):pinned.add(value);
      board.querySelector('#filterResults').innerHTML=recipeRows();
      board.querySelector(`[data-action="pin"][data-value="${value}"]`)?.focus();
      break;
    case 'apply-recipe':
      draft.recipe={...recipeReview,files:recipeReview.files.filter(n=>!documents[n].unavailable)};
      draft.fixedMethod=null;
      draft.includeManual=false;
      closePanel(true);
      break;
    case 'drop-recipe': draft.recipe=null; draft.includeManual=false; render(true); break;
    case 'record': selectedTurn=locateTurn(value); navigate('record',false,control); break;
    case 'accept-task': {
      const task=tasks.find(item=>item.id===Number(value));
      task.accepted=true;
      if (draft.taskId===task.id) {
        draft.taskId=null;
        draft.pattern='ask';
        draft.condition='';
      }
      render(true);
      break;
    }
    case 'cite': {
      const [turnId,doc] = value.split(':').map(Number);
      const turn = locateTurn(turnId);
      if (!turn?.result.evidence.includes(doc)) break;
      selectedTurn=turn;
      citation=doc;
      navigate('evidence',!!panel(),control);
      break;
    }
    case 'material': material=Number(value); navigate('material',true,control); break;
    case 'send': submit(); break;
    case 'stop':
      clearInterval(runTimer);
      latest().status='stopped';
      refreshRun(latest());
      break;
    case 'dequeue': {
      const request=queued;
      queued=null;
      begin(request);
      break;
    }
    case 'drop-queue': queued=null; render(); break;
    case 'edit-turn': draft.text=locateTurn(value).request.text; render(); focusQuestion(); break;
    case 'chat': launch(chats.find(chat=>chat.id===value)); break;
    case 'archive-view': showArchive=!showArchive; search=''; render(true); break;
    case 'archive':
      archived.has(value)?archived.delete(value):archived.add(value);
      board.querySelector('#filterResults').innerHTML=historyRows();
      break;
    case 'open-prior': launch(priorWork); break;
    case 'open-period': openPeriod(); break;
    case 'create-period': if (monthConsent) openPeriod(true); break;
    case 'copy': {
      const turn=locateTurn(value);
      try { await navigator.clipboard.writeText(answerText(turn)); notice('已复制回答'); }
      catch { notice('可选中回答文字复制'); }
      break;
    }
    case 'save-target': {
      selectedTurn=locateTurn(value);
      const pending=selectedTurn.saves.find(item=>item.state==='unverified');
      if (pending) openReceipt(selectedTurn,pending);
      else navigate('save-target',false,control);
      break;
    }
    case 'write':
      actionDraft={type:value,title:selectedTurn.result.title,body:answerText(selectedTurn),
        target:value==='创建任务'?'滴答清单 / 线束复核':value==='新建笔记'?'Obsidian / 线束设计':'Obsidian / 前门线束评审记录'};
      navigate('write',true,control);
      break;
    case 'prepare-write':
      if (![actionDraft.target,actionDraft.title,actionDraft.body].every(text=>text.trim())) { previewStatus('请填写写入位置、标题和内容。'); break; }
      prepared=Object.freeze({...actionDraft,turnId:selectedTurn.id});
      navigate('write-preview',true,control);
      break;
    case 'confirm-write': {
      const receipt=confirmWrite(selectedTurn,prepared);
      if (receipt) openReceipt(selectedTurn,receipt);
      break;
    }
    case 'receipt': {
      const [turnId,id] = value.split(':').map(Number);
      const turn=locateTurn(turnId);
      openReceipt(turn,turn.saves.find(item=>item.id===id));
      break;
    }
    case 'verify': selectedReceipt.state='verified'; render(true); break;
  }
});
document.addEventListener('keydown',event=>{
  if (event.isComposing) return;
  if (event.key==='Escape'&&panel()) { event.preventDefault(); closePanel(); }
  else if (event.key==='Enter'&&(event.ctrlKey||event.metaKey)&&event.target.id==='question') { event.preventDefault(); submit(); }
});
launch(chats[0]);
