import {createInitialState, reducer, selectors, selectView, selectCounts, taskSources, validateState, ACTION_POOL_LIMIT} from './model.mjs';
import {renderFlow} from './flow.mjs';
import {renderPlanning} from './planning-ui.mjs';

const STORAGE_KEY = 'hub-task-flow-lab-v1';
const VIEW_KEY = 'hub-task-flow-lab-view-v1';
const ORIGINAL_SITE = 'https://hub-workspace-von11.song02211368537057.chatgpt.site/?view=tasks';
const SOURCE_NAMES = {dida:'滴答清单',craft:'Craft',feishu:'飞书',obsidian:'Obsidian',hub:'Hub 洞察'};
const STATE_NAMES = {todo:'待办',doing:'进行中',waiting:'等待条件',done:'已完成'};
const PAGES = {planning:'AI 规划',tasks:'任务',journal:'日志',insights:'洞察',materials:'关联资料',flow:'任务流程图'};
const VIEWS = {now:'现在',triage:'待整理',waiting:'等待',all:'全部'};
const LAYOUTS = {list:'列表',board:'看板',table:'表格',timeline:'时间线',tree:'项目树',relations:'关联图'};
const root = document.getElementById('app');
const dialog = document.getElementById('dialog');
const dialogContent = document.getElementById('dialog-content');
const toastElement = document.getElementById('toast');
let storageWarning = '';
let toastTimer;
let dialogSubmit = null;
let lastDialogFocus = null;
let timers = new Map();
let busyAI = new Set();
let asyncGeneration = 0;
let skipDraftCapture = false;
const esc = value => String(value ?? '').replace(/[&<>"']/g, value => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[value]));
const localDay = () => {const d=new Date();return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;};
const localStamp = () => `${localDay()}T${new Date().toTimeString().slice(0,8)}`;
const dateLabel = value => value ? `${Number(value.slice(5,7))}月${Number(value.slice(8,10))}日` : '未设置';
const taskById = id => state.tasks.find(t=>t.id===id);
const materialById = id => state.materials.find(m=>m.id===id);
const candidateById = id => state.candidates.find(c=>c.id===id);

const iconPaths = {
  tasks:'<path d="M9 6h11M9 12h11M9 18h11M3 6l1 1 2-2M3 12l1 1 2-2M3 18l1 1 2-2"/>',
  search:'<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4.5 4.5"/>',
  spark:'<path d="m12 3 2.3 6.7L21 12l-6.7 2.3L12 21l-2.3-6.7L3 12l6.7-2.3L12 3ZM20 2v4M18 4h4"/>',
  journal:'<path d="M5 3h14v18H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2ZM7 3v18M10 8h6M10 12h6"/>',
  layers:'<path d="m12 3 9 5-9 5-9-5 9-5ZM3 12l9 5 9-5M3 16l9 5 9-5"/>',
  flow:'<rect x="9" y="2" width="6" height="5" rx="1"/><rect x="2" y="17" width="6" height="5" rx="1"/><rect x="16" y="17" width="6" height="5" rx="1"/><path d="M12 7v5M5 17v-5h14v5"/>',
  sun:'<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/>',
  moon:'<path d="M20.6 13A8.8 8.8 0 0 1 11 3.4 9 9 0 1 0 20.6 13Z"/>',
  plus:'<path d="M12 5v14M5 12h14"/>',
  chevron:'<path d="m9 5 7 7-7 7"/>',
  down:'<path d="m6 9 6 6 6-6"/>',
  close:'<path d="m6 6 12 12M6 18 18 6"/>',
  arrow:'<path d="M4 12h16m-6-6 6 6-6 6"/>',
  back:'<path d="M20 12H4m6-6-6 6 6 6"/>',
  clock:'<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  check:'<path d="m5 12 4 4L19 6"/>',
  circleCheck:'<circle cx="12" cy="12" r="9"/><path d="m7 12 3 3 6-6"/>',
  link:'<path d="m10 13 4-4M8 15l-2 2a3.5 3.5 0 0 1-5-5l4-4a3.5 3.5 0 0 1 5 0m4 1 2-2a3.5 3.5 0 0 1 5 5l-4 4a3.5 3.5 0 0 1-5 0" transform="translate(1 -1)"/>',
  folder:'<path d="M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"/>',
  calendar:'<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M7 3v4M17 3v4M3 10h18M7 14h3M14 14h3"/>',
  inbox:'<path d="M4 4h16l2 11v5H2v-5L4 4ZM2 15h6l2 3h4l2-3h6"/>',
  target:'<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/>',
  play:'<path d="m8 4 12 8-12 8V4Z"/>',
  pause:'<path d="M8 5v14M16 5v14"/>',
  refresh:'<path d="M20 7v5h-5M4 17v-5h5M6 6a8 8 0 0 1 13 2M5 16a8 8 0 0 0 13 2"/>',
  external:'<path d="M14 3h7v7M21 3l-9 9M10 3H4a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1v-6"/>',
  info:'<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7h.01"/>',
  flag:'<path d="M5 21V3h13l-3 4 3 4H5"/>',
  document:'<path d="M14 2H5a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V9l-7-7ZM14 2v7h7M7 13h10M7 17h7"/>',
  more:'<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  edit:'<path d="m14 4 6 6M4 20l4-1L21 6a2 2 0 0 0-3-3L5 16l-1 4Z"/>',
  send:'<path d="m22 2-7 20-4-9L2 9l20-7ZM11 13 22 2"/>',
  menu:'<path d="M4 6h16M4 12h16M4 18h16"/>',
  arrowDown:'<path d="M12 3v18m-6-6 6 6 6-6"/>',
  shield:'<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z"/><path d="m8 12 3 3 5-6"/>',
  undo:'<path d="M4 4v6h6M4 10a8 8 0 1 1 1 9"/>',
};
function icon(name,size=16){return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${iconPaths[name]||iconPaths.document}</svg>`;}
function sourceMark(source){return `<span class="source-mark ${esc(source)}" aria-label="${esc(SOURCE_NAMES[source]||source)}">${({dida:'✓',craft:'C',feishu:'F',obsidian:'O',hub:'H'})[source]||'·'}</span>`;}
function button(action,label,cls='btn',id='',glyph=''){return `<button class="${cls}" type="button" data-action="${action}"${id?` data-id="${esc(id)}"`:''}>${glyph?icon(glyph,14):''}${label}</button>`;}
function iconButton(action,label,glyph,id='',cls=''){return `<button type="button" class="icon-btn ${cls}" aria-label="${esc(label)}" title="${esc(label)}" data-action="${action}"${id?` data-id="${esc(id)}"`:''}>${icon(glyph,15)}</button>`;}

function loadData(){
  try {const raw=localStorage.getItem(STORAGE_KEY);if(raw){const data=JSON.parse(raw);if(validateState(data))return data;storageWarning='示例存档格式不兼容，正在使用初始演示；原站点数据不受影响。';}}
  catch {storageWarning='无法读取本机示例存档，本次先使用临时演示数据。';}
  return createInitialState(localDay());
}
let state=loadData();
let ui={planningMode:'today',planCapacity:'120',planProject:'BEV',planTask:'t-harness',planCoverage:'fresh',planningBusy:false,page:'planning',view:'now',layout:'list',project:'all',source:'all',query:'',status:'open',selected:window.innerWidth>1050?'t-mobile':null,candidate:null,panelTab:'details',candidateMode:'link',candidateTarget:'t-harness',guide:false,guideStep:0,guideTaskId:'t-harness',navOpen:false,showResolved:false,theme:'light',simulation:'success',assistantDrafts:{},candidateDrafts:{}};
try{const saved=JSON.parse(localStorage.getItem(VIEW_KEY)||'{}');for(const key of ['project','source','layout','theme','simulation'])if(typeof saved[key]==='string')ui[key]=saved[key];for(const key of ['assistantDrafts','candidateDrafts'])if(saved[key]&&typeof saved[key]==='object'&&!Array.isArray(saved[key]))ui[key]=saved[key];if(!LAYOUTS[ui.layout])ui.layout='list';if(!['light','dark'].includes(ui.theme))ui.theme='light';if(!['success','failure','pending'].includes(ui.simulation))ui.simulation='success';}catch{}
const initialHash=location.hash.slice(1);
if(initialHash==='flow') {ui.page='flow';ui.selected=null;}
else if(['planning','journal','insights','materials'].includes(initialHash)){ui.page=initialHash;ui.selected=null;}
else if(VIEWS[initialHash]){ui.page='tasks';ui.view=initialHash;}

function save(){
  try{localStorage.setItem(STORAGE_KEY,JSON.stringify(state));localStorage.setItem(VIEW_KEY,JSON.stringify(ui));if(storageWarning.startsWith('无法保存'))storageWarning='';}
  catch{storageWarning='无法保存到浏览器：当前修改只在本次打开期间有效。请不要关闭此页。';}
}
function dispatch(action,message){
  const next=reducer(state,action,localStamp());
  if(next.error){state={...next,error:null};if(dialog.open){const el=document.getElementById('dialog-error');if(el)el.textContent=next.error;}else toast(next.error);render();return false;}
  state=next;save();render();if(message)toast(message);return true;
}
function toast(message,undoId){
  clearTimeout(toastTimer);toastElement.innerHTML=`<span>${esc(message)}</span>${undoId?`<button type="button" data-undo="${esc(undoId)}">撤销完成</button>`:''}`;toastElement.classList.add('visible');
  toastTimer=setTimeout(()=>toastElement.classList.remove('visible'),undoId?8000:4500);
}
toastElement.addEventListener('click',event=>{const el=event.target.closest('[data-undo]');if(el){dispatch({type:'UNDO_COMPLETE',id:el.dataset.undo},'已模拟撤销完成，原任务与历史都保留');toastElement.classList.remove('visible');}});

function navigate(page,view){
  ui.page=page;if(view)ui.view=view;ui.navOpen=false;
  if(page!=='tasks'){ui.candidate=null;ui.selected=null;}
  else if(ui.selected&&!visibleTasks().some(t=>t.id===ui.selected))ui.selected=null;
  history.replaceState(null,'',`#${page==='tasks'?ui.view:page}`);save();render();const main=document.getElementById('main');if(main)main.scrollTop=0;
}
window.addEventListener('hashchange',()=>{const h=location.hash.slice(1);if(VIEWS[h])navigate('tasks',h);else if(PAGES[h])navigate(h);});
function openTask(id,tab='details'){if(!taskById(id))return;ui.selected=id;ui.candidate=null;ui.panelTab=tab;render();const pane=document.querySelector('.detail-scroll');if(pane)pane.scrollTop=0;}
function openCandidate(id){const c=candidateById(id);if(!c)return;ui.selected=null;ui.candidate=id;ui.candidateMode='link';ui.candidateTarget=c.suggestedTaskId||state.tasks.find(t=>t.state!=='done')?.id;render();const pane=document.querySelector('.detail-scroll');if(pane)pane.scrollTop=0;}
function filters(){return {project:ui.project,source:ui.source,query:ui.query,status:ui.status,today:state.demoDate};}
function visibleTasks(view=ui.view){return selectView(state,view,{...filters(),status:view==='all'?ui.status:'open'});}
function visibleCandidates(){return state.candidates.filter(c=>{
  const active=ui.showResolved?c.status!=='pending':c.status==='pending';
  return active&&(ui.project==='all'||c.project===ui.project)&&(ui.source==='all'||c.source===ui.source)&&(c.title+' '+c.summary).toLowerCase().includes(ui.query.toLowerCase());
});}
function dueLabel(task){if(!task.due)return '';if(task.due<state.demoDate)return `已逾期 · ${dateLabel(task.due)}`;if(task.due===state.demoDate)return '今天截止';return dateLabel(task.due);}

function render(){
  captureDrafts();
  const active=document.activeElement;const activeId=active?.id;const activeCheck=active?.dataset?.check;const activeTask=active?.dataset?.task;const activeAction=active?.dataset?.action;const activeActionId=active?.dataset?.id;const position=active?.selectionStart;const contentScroll=document.getElementById('main')?.scrollTop||0;const panelScroll=document.querySelector('.detail-scroll')?.scrollTop||0;
  document.documentElement.dataset.theme=ui.theme;
  const counts=selectCounts(state);const panel=ui.page==='tasks'&&(ui.selected||ui.candidate);
  root.innerHTML=`<div class="app-shell ${ui.navOpen?'nav-open':''}">${renderRail()}${renderSidebar(counts)}<section class="workspace">${renderTopbar()}${storageWarning?`<div class="storage-warning" role="alert">${esc(storageWarning)}</div>`:''}${ui.guide?renderGuide():''}<div class="workspace-body ${panel?'with-detail':''}"><main id="main" class="content ${ui.page==='flow'?'flow-content':''}">${renderPage(counts)}</main>${panel?renderPanel():''}</div></section></div>`;
  const main=document.getElementById('main');if(main)main.scrollTop=contentScroll;
  const scroller=document.querySelector('.detail-scroll');if(scroller)scroller.scrollTop=panelScroll;
  let replacement=activeId?document.getElementById(activeId):activeCheck?root.querySelector(`[data-check="${CSS.escape(activeCheck)}"][data-task="${CSS.escape(activeTask)}"]`):activeAction?root.querySelector(`[data-action="${CSS.escape(activeAction)}"]${activeActionId?`[data-id="${CSS.escape(activeActionId)}"]`:''}`):null;
  if(replacement){replacement.focus({preventScroll:true});if(position!==null)try{replacement.setSelectionRange(position,position);}catch{}}
}
function captureDrafts(){if(skipDraftCapture){skipDraftCapture=false;return;}const assistant=document.getElementById('assistant-form');if(assistant)ui.assistantDrafts[assistant.dataset.task]=assistant.querySelector('textarea')?.value||'';const candidate=document.getElementById('candidate-form');if(candidate)ui.candidateDrafts[`${candidate.dataset.id}:${candidate.dataset.mode}`]=Object.fromEntries(new FormData(candidate));}
function guideTask(){return ui.guideTaskId||'t-harness';}
function resumeGuide(){const c=candidateById('c-drawing');ui.guideTaskId=c?.resolvedTaskId||'t-harness';const t=taskById(guideTask());ui.guideStep=!c?.resolvedTaskId?0:t?.state==='done'?6:t?.state==='waiting'?4:t?.history.some(h=>h.type==='resumed')?5:t?.aiNote?3:t?.now?2:1;}
function renderRail(){return `<nav class="rail" aria-label="Hub 模块"><a class="brand" href="#now" aria-label="Hub 任务工作台">H</a>${[['planning','spark','AI 规划'],['tasks','tasks','任务'],['materials','layers','资料'],['insights','spark','洞察'],['journal','journal','日志'],['flow','flow','流程图']].map(([page,glyph,label])=>`<button class="rail-btn ${ui.page===page?'active':''}" type="button" data-action="page" data-id="${page}" aria-label="${label}" title="${label}"${ui.page===page?' aria-current="page"':''}>${icon(glyph,18)}</button>`).join('')}<div class="rail-gap"></div><a class="rail-btn" href="${ORIGINAL_SITE}" target="_blank" rel="noopener" title="打开原 Hub 工作台（新标签页）" aria-label="打开原 Hub 工作台（新标签页）">${icon('external',17)}</a>${iconButton('theme',ui.theme==='dark'?'切换浅色':'切换深色',ui.theme==='dark'?'sun':'moon')}<div class="avatar" aria-label="个人工作空间">V</div></nav>`;}
function renderSidebar(counts){
  const projects=[...new Set(state.tasks.map(t=>t.project))];
  return `<aside class="sidebar"><div class="sidebar-title">任务工作台 <span>Hub</span></div><div class="sidebar-scroll"><button class="side-item ${ui.project==='all'?'active':''}" data-action="project" data-id="all">${icon('layers',15)}<span>全部项目</span><em>${counts.active}</em></button><div class="sidebar-label">项目与清单</div>${projects.map(project=>`<button class="side-item ${ui.project===project?'active':''}" data-action="project" data-id="${esc(project)}"><i class="project-dot"></i><span>${esc(project==='Hub'?'Hub 工作台':project==='BEV'?'BEV 线束':project==='160'?'160 项目':project)}</span><em>${state.tasks.filter(t=>t.project===project&&t.state!=='done').length}</em></button>`).join('')}<div class="sidebar-label">任务与关联来源</div>${Object.entries(SOURCE_NAMES).map(([source,label])=>`<button class="side-item ${ui.source===source?'active':''}" data-action="source" data-id="${source}">${sourceMark(source)}<span>${label}</span><em>${state.tasks.filter(t=>t.state!=='done'&&taskSources(state,t).includes(source)).length}</em></button>`).join('')}<div class="sidebar-note">任务留在原清单。<br>资料是依据，不是另一份待办。<br><button class="btn btn-link" data-action="page" data-id="flow">看看完整逻辑 ${icon('arrow',12)}</button></div></div><div class="sidebar-bottom"><span class="avatar">V</span><div>我的工作空间<small>独立原型 · 本机示例</small></div>${iconButton('about','原型说明','info')}</div></aside>`;
}
function renderTopbar(){return `<header class="topbar"><div class="breadcrumb">${iconButton('nav','展开项目导航','menu','','mobile-menu')}<span>工作空间</span><span>/</span><strong>${PAGES[ui.page]}</strong><span class="prototype-tag"><i></i>任务流程实验室</span></div><div class="top-actions"><span class="prototype-tag">示例数据 · 未连接外部账户</span>${button('guide','体验完整案例','btn case-btn','','play')}${button('page','流程图','btn flow-top','flow','flow')}${button('new','新建任务','btn btn-primary','','plus')}</div></header>`;}
const guideSteps=[
  ['先判断：这是新任务，还是新资料？','打开图纸变更线索，选择关联到已有的“核对线束固定点并反馈”。','triage'],
  ['同一任务，进入行动池','查看新关联的图纸，然后点击“加入行动池”。任务仍留在原清单。','now'],
  ['让 AI 帮你准备，而不是替你宣布完成','打开“助手”，点击生成核对清单，草稿会保留在这项任务上。','now'],
  ['卡住时，写清楚等待条件','点击“等待条件”，填入等待 DRE 确认版本以及跟进日期。','now'],
  ['条件满足后，继续同一个任务','在“等待”中点击“条件已满足，恢复”。恢复不代表任务完成。','waiting'],
  ['核对结果，再完成','勾选核对清单，点击“确认完成”。也可以模拟同步失败与重试。','all'],
  ['完成留下结果，日志能够追溯','到日志看这次完成记录；点击任务可重新打开，历史仍然保留。','journal'],
];
function renderGuide(){const [title,desc]=guideSteps[ui.guideStep]||guideSteps[0];return `<div class="guide"><span class="guide-number">${ui.guideStep+1}</span><div class="guide-text"><strong>${title}</strong><span>${desc}</span></div><div class="guide-track" aria-label="第 ${ui.guideStep+1} 步，共 7 步">${guideSteps.map((_,i)=>`<i class="${i<=ui.guideStep?'done':''}"></i>`).join('')}</div>${button('guide-go','前往此步','btn btn-small')}${iconButton('guide-close','结束案例引导','close')}</div>`;}

function renderPage(counts){
  if(ui.page==='planning')return renderPlanning(state,ui,{esc,icon,button,dateLabel});
  if(ui.page==='flow')return renderFlow();
  if(ui.page==='journal')return renderJournal();
  if(ui.page==='insights')return renderInsights();
  if(ui.page==='materials')return renderMaterialsPage();
  const headings={now:['现在，推进重要的事','先顾好今天的承诺，再专注于少量能开始的行动。','target'],triage:['把线索，整理成下一步','先判断是否需要行动。有关联，就不再重复创建任务。','inbox'],waiting:['让等待，也有下一步','写清等谁、缺什么、何时回看。条件满足后继续原任务。','clock'],all:['所有任务，一个入口','任务、资料和执行记录，始终围绕同一件事。','tasks']};
  const [title,desc,glyph]=headings[ui.view];
  return `<div class="page-heading"><div><div class="eyebrow">${dateLabel(state.demoDate)} · 示例工作日</div><h1>${title}</h1><p>${desc}</p></div><div class="heading-icon">${icon(glyph,23)}</div></div><nav class="view-tabs" aria-label="任务工作视图">${Object.entries(VIEWS).map(([key,name])=>`<button type="button" class="view-tab ${ui.view===key?'active':''}" data-action="view" data-id="${key}" ${ui.view===key?'aria-current="page"':''}>${name}<b>${counts[key]}</b></button>`).join('')}</nav>${renderToolbar()}${ui.view==='triage'?renderTriage():ui.view==='waiting'?renderWaiting():renderTasks()}<div class="workspace-footnote">${icon('shield',12)}独立交互原型 · 数据仅保存在此浏览器 · AI 与来源同步均为模拟</div>`;
}
function renderToolbar(){return `<div class="toolbar"><label class="search-field">${icon('search',15)}<input id="task-search" type="search" value="${esc(ui.query)}" aria-label="搜索当前任务与线索" placeholder="搜索任务、项目或下一步…" autocomplete="off"></label>${ui.view==='all'?`<select id="status-filter" class="layout-select" aria-label="任务完成状态"><option value="open"${ui.status==='open'?' selected':''}>未完成</option><option value="all"${ui.status==='all'?' selected':''}>所有状态</option><option value="done"${ui.status==='done'?' selected':''}>已完成</option></select>`:''}${['now','all'].includes(ui.view)?`<select id="layout-select" class="layout-select" aria-label="任务布局">${Object.entries(LAYOUTS).map(([v,l])=>`<option value="${v}"${ui.layout===v?' selected':''}>${l}</option>`).join('')}</select>`:''}${iconButton('simulation','同步情境设置','more')}</div>${ui.project!=='all'||ui.source!=='all'?`<div class="filter-line"><span>当前范围</span>${ui.project!=='all'?`<button class="filter-pill" data-action="clear-project">${esc(ui.project)} ${icon('close',10)}</button>`:''}${ui.source!=='all'?`<button class="filter-pill" data-action="clear-source">${SOURCE_NAMES[ui.source]||esc(ui.source)} ${icon('close',10)}</button>`:''}${button('clear-filters','清除筛选','btn btn-link')}</div>`:''}`;}
function renderTasks(){
  const tasks=visibleTasks();
  if(ui.layout!=='list')return renderAlternate(tasks);
  if(ui.view==='all')return tasks.length?`<div class="section-heading">${ui.status==='done'?'完成记录':ui.status==='open'?'未完成任务':'全部任务'}<em>${tasks.length} 项</em><span class="section-hint">点击任务查看目的与依据</span></div><div class="task-list">${tasks.map(renderTaskRow).join('')}</div>${button('new',`${icon('plus',14)} 新建一个明确的任务`,'quiet-add')}`:empty('没有匹配的任务','试试清除筛选，或者创建一个明确要做的行动。','new','新建任务');
  const due=tasks.filter(t=>t.due&&t.due<=state.demoDate);
  const planned=tasks.filter(t=>t.plannedDate&&t.plannedDate<=state.demoDate&&!t.now&&t.state!=='waiting'&&!due.includes(t));
  const pool=tasks.filter(t=>t.now&&t.state!=='waiting'&&!due.includes(t));
  const totalPool=selectCounts(state).actionPool;
  return `${state.candidates.some(c=>c.status==='pending')?`<div class="info-line"><span>${icon('inbox',14)}有 ${state.candidates.filter(c=>c.status==='pending').length} 条新线索待判断。它们还不是你的任务。</span>${button('view','去整理 →','btn btn-small','triage')}</div>`:''}<div class="section-heading amber">${icon('flag',14)}今天必须照顾的承诺<em>${due.length} 项</em></div>${due.length?`<div class="task-list">${due.map(renderTaskRow).join('')}</div>`:`<div class="section-description">当前范围内没有今天到期或逾期的任务。</div>`}${planned.length?`<div class="section-heading">${icon('calendar',14)}今天安排的任务<em>${planned.length} 项</em><span class="section-hint">已到计划日期 · 不占行动池</span></div><div class="task-list">${planned.map(renderTaskRow).join('')}</div>`:''}<div class="section-heading">${icon('target',15)}我的行动池<em>${totalPool} / ${ACTION_POOL_LIMIT}</em><span class="section-hint">少量、明确、现在能开始</span></div>${pool.length?`<div class="task-list">${pool.map(renderTaskRow).join('')}</div>`:empty('给下一步留一点空间','从全部任务里选择真正准备开始的事。加入行动池不会复制或移动任务。','view','选择下一步','all')}${button('view',`${icon('plus',14)} 从全部任务中选择`,'quiet-add','all')}<div class="section-description" style="margin-top:12px">截止任务单独显示，不受行动池 5 项上限影响。</div>`;
}
function renderTaskRow(task){const s=selectors(task);return `<article class="task-row ${ui.selected===task.id?'selected':''}" data-task-id="${esc(task.id)}"><button class="check-btn ${s.isDone?'complete':''} ${s.isSyncPending?'pending':''}" type="button" data-action="complete" data-id="${esc(task.id)}" aria-label="${s.isDone?'重新打开':s.isSyncPending?'查看待确认操作':'完成'}：${esc(task.title)}"><span class="check-circle">${s.isDone?icon('check',11):s.isSyncPending?icon('clock',11):''}</span></button><button class="task-main" type="button" data-action="task" data-id="${esc(task.id)}"><span class="task-title ${s.isDone?'done':''}">${esc(task.title)}</span><span class="task-meta">${sourceMark('dida')}<span>${esc(task.project)}</span><span class="dot">·</span><span>${esc(task.list)}</span>${task.due?`<span class="dot">·</span><span class="due">${esc(dueLabel(task))}</span>`:''}${task.materialIds.length?`<span class="extra-meta">${icon('link',10)} ${task.materialIds.length}</span>`:''}${s.isSyncFailed?'<span class="failed">模拟同步失败</span>':s.isSyncPending?'<span class="due">等待模拟确认</span>':''}</span></button><div class="row-tail">${task.state!=='todo'?`<span class="state-label ${task.state}">${STATE_NAMES[task.state]}</span>`:''}${task.state!=='done'&&task.state!=='waiting'?iconButton('now',task.now?'移出行动池（不删除任务）':'加入行动池','target',task.id,task.now?'pressed':''):''}</div></article>`;}
function empty(title,description,action,label,id=''){return `<div class="empty">${icon('inbox',26)}<h3>${esc(title)}</h3><p>${esc(description)}</p>${action?button(action,label,'btn btn-secondary',id):''}</div>`;}

function renderAlternate(tasks){
  if(!tasks.length)return empty('没有匹配的任务','视图和布局只改变展示，不改变任务本身。','clear-filters','清除筛选');
  if(ui.layout==='board')return `<div class="section-description">按执行状态查看 · 同一任务，不重复副本</div><div class="board">${['todo','doing','waiting',...(ui.status!=='open'?['done']:[])].map(status=>`<section class="board-column"><div class="board-heading">${STATE_NAMES[status]}<span>${tasks.filter(t=>t.state===status).length}</span></div>${tasks.filter(t=>t.state===status).map(t=>`<button class="board-card ${ui.selected===t.id?'selected':''}" data-action="task" data-id="${esc(t.id)}"><span class="task-title">${esc(t.title)}</span><span class="task-meta">${sourceMark(t.source)}${esc(t.project)}${t.due?` · ${esc(dueLabel(t))}`:''}</span>${t.now?'<span class="mini-label">在行动池</span>':''}</button>`).join('')||'<p class="muted" style="font-size:10px;padding:12px 0">这里暂时没有任务</p>'}</section>`).join('')}</div>`;
  if(ui.layout==='table')return `<div class="table-wrap"><table class="task-table"><thead><tr><th>任务</th><th>项目</th><th>状态</th><th>截止日期</th><th>行动池</th></tr></thead><tbody>${tasks.map(t=>`<tr class="${ui.selected===t.id?'selected':''}"><td><button data-action="task" data-id="${esc(t.id)}">${esc(t.title)}</button></td><td>${esc(t.project)}</td><td><span class="state-label ${t.state}">${STATE_NAMES[t.state]}</span></td><td>${t.due?esc(dateLabel(t.due)):'—'}</td><td>${t.now?'已选择':'—'}</td></tr>`).join('')}</tbody></table></div>`;
  if(ui.layout==='timeline'){const dates=[...new Set(tasks.map(t=>t.due||'未排期'))].sort();return `<div class="section-description">按截止日期分组 · 计划日期与完成日期分别记录</div>${dates.map(d=>`<div class="timeline-day"><span>${d==='未排期'?d:dateLabel(d)}</span><div class="task-list">${tasks.filter(t=>(t.due||'未排期')===d).map(renderTaskRow).join('')}</div></div>`).join('')}`;}
  if(ui.layout==='tree')return [...new Set(tasks.map(t=>t.project))].map(p=>`<section class="tree-project"><h3>${icon('folder',14)}${esc(p)}<span class="mini-label">项目容器，不计作任务</span></h3><div class="task-list">${tasks.filter(t=>t.project===p).map(renderTaskRow).join('')}</div><div class="divider"></div></section>`).join('');
  return `<div class="section-description">任务关联哪些依据？这些连线是资料关联，不是任务依赖。</div>${tasks.map(t=>`<section class="relation-task"><button data-action="task" data-id="${esc(t.id)}">${icon('circleCheck',14)}${esc(t.title)}</button><div class="relation-materials">${t.materialIds.map(id=>materialById(id)).filter(Boolean).map(m=>`<span>${sourceMark(m.source)}${esc(m.title)}</span>`).join('')||'<small>还没有关联资料，可在详情中添加</small>'}</div></section>`).join('')}`;
}
function renderTriage(){
  const candidates=visibleCandidates();const inbox=visibleTasks('triage');
  const resolved=state.candidates.filter(c=>c.status!=='pending').length;
  return `<div class="section-heading">${icon('spark',14)}${ui.showResolved?'处理记录':'待判断的线索'}<em>${candidates.length}</em><span class="section-hint">尚未成为任务</span></div><div class="candidate-list">${candidates.map(c=>renderCandidate(c)).join('')||empty(ui.showResolved?'还没有处理记录':'当前范围的线索已整理','你可以关联已有任务，也可以只保留资料。无需把每条线索都变成待办。')}</div>${resolved||ui.showResolved?button('resolved',ui.showResolved?'返回待判断线索':`查看已处理 / 暂放（${resolved}）`,'btn btn-link'):''}${!ui.showResolved?`<div class="section-heading">${sourceMark('dida')}已存在的收集箱任务<em>${inbox.length}</em><span class="section-hint">无需再次确认创建</span></div><div class="section-description">这些已经是任务，只需补充下一步或安排时间。</div>${inbox.length?`<div class="task-list">${inbox.map(renderTaskRow).join('')}</div>`:'<p class="muted" style="font-size:11px">当前范围没有待补充的任务。</p>'}`:''}`;
}
function renderCandidate(c){const labels={linked:'已关联原任务',updated:'已更新原任务',created:'已确认创建',ignored:'仅保留资料',deferred:'稍后处理'};return `<article class="candidate-card ${ui.candidate===c.id?'selected':''}"><button class="candidate-main" data-action="candidate" data-id="${esc(c.id)}"><span class="candidate-heading">${sourceMark(c.source)}${SOURCE_NAMES[c.source]}<span>·</span><span>${esc(c.project)}</span><span class="mini-label">${c.status==='pending'?'线索 · 非任务':labels[c.status]}</span></span><h3>${esc(c.title)}</h3><p>${esc(c.summary)}</p></button><div class="candidate-recommend"><span>${icon('link',12)}${c.resolvedTaskId?'已关联：'+esc(taskById(c.resolvedTaskId)?.title||'原任务'):c.suggestedTaskId?'可能已有相关任务':'先判断是否需要行动'}</span>${c.resolvedTaskId?button('task','查看原任务 →','btn btn-link',c.resolvedTaskId):['ignored','deferred'].includes(c.status)?button('restore-candidate','重新整理','btn btn-link',c.id):button('candidate','整理 →','btn btn-link',c.id)}</div></article>`;}
function renderWaiting(){const tasks=visibleTasks('waiting');return tasks.length?tasks.map(t=>`<article class="wait-card"><button class="task-main" data-action="task" data-id="${esc(t.id)}"><span class="task-title">${esc(t.title)}</span><span class="task-meta">${sourceMark(t.source)}${esc(t.project)} · 原任务仍在${esc(t.list)}</span></button><div class="wait-details"><strong>等待 ${esc(t.waiting?.person)}</strong><br>${esc(t.waiting?.reason)}${t.due&&t.due<=state.demoDate?`<br><strong>注意：${esc(dueLabel(t))}，等待不会取消截止承诺。</strong>`:''}</div><div class="wait-actions"><span>${icon('calendar',12)} ${t.waiting?.reviewDate?dateLabel(t.waiting.reviewDate)+' 跟进':'尚未安排跟进日期'}</span>${button('resume','条件已满足，恢复','btn btn-secondary btn-small',t.id,'play')}</div></article>`).join(''):empty('没有正在等待的任务','遇到阻碍时，在任务详情中记录等待对象与缺失条件。条件满足后继续原任务。','view','查看全部任务','all');}

function renderPanel(){if(ui.candidate)return renderCandidatePanel(candidateById(ui.candidate));const task=taskById(ui.selected);if(!task)return '';return `<aside class="detail-panel" aria-label="任务详情"><div class="detail-top"><span>${sourceMark(task.source)}滴答清单 · 示例主档</span><div>${iconButton('edit','编辑原任务','edit',task.id)}${iconButton('panel-close','关闭任务详情','close')}</div></div><nav class="detail-tabs" aria-label="任务详情区域">${[['details','任务详情'],['materials','关联资料'],['assistant','助手']].map(([id,label])=>`<button type="button" data-action="panel-tab" data-id="${id}" class="${ui.panelTab===id?'active':''}" aria-pressed="${ui.panelTab===id}">${label}${id==='materials'?` <small>${task.materialIds.length}</small>`:''}</button>`).join('')}</nav><div class="detail-scroll">${ui.panelTab==='details'?renderDetails(task):ui.panelTab==='materials'?renderTaskMaterials(task):renderAssistant(task)}</div><div class="detail-footer">${icon('shield',12)}同一任务 ${esc(task.id)} · 所有操作仅在此原型模拟</div></aside>`;}
function renderDetails(t){const s=selectors(t);return `<div class="detail-status"><span class="state-label ${t.state}">${STATE_NAMES[t.state]}</span>${t.now?'<span>行动池已选择</span>':''}${t.priority==='high'?'<span>重要承诺</span>':''}</div><h2 class="detail-title">${esc(t.title)}</h2><p class="detail-purpose">${esc(t.purpose)}</p><dl class="property-grid"><dt>${icon('folder',12)} 项目</dt><dd>${esc(t.project)}<span class="muted">/ ${esc(t.list)}</span></dd><dt>${icon('calendar',12)} 截止</dt><dd><button data-action="edit" data-id="${esc(t.id)}">${t.due?esc(dateLabel(t.due)):'未设置'}</button></dd><dt>${icon('clock',12)} 计划</dt><dd><button data-action="edit" data-id="${esc(t.id)}">${t.plannedDate?esc(dateLabel(t.plannedDate)):'随时可开始'}</button></dd><dt>${icon('link',12)} 依据</dt><dd><button data-action="panel-tab" data-id="materials">${t.materialIds.length} 份关联资料 ${icon('chevron',10)}</button></dd>${t.completedOn?`<dt>${icon('check',12)} 完成</dt><dd>${esc(dateLabel(t.completedOn))} · 模拟来源确认</dd>`:''}</dl>${t.waiting?`<div class="wait-box"><strong>等待 ${esc(t.waiting.person)}</strong>${esc(t.waiting.reason)}<br>${t.waiting.reviewDate?dateLabel(t.waiting.reviewDate)+' 跟进':'未设跟进日期'}${t.due&&t.due<=state.demoDate?'<br>今天的截止承诺仍需关注':''}</div>`:''}<section class="detail-section"><h3>${icon('arrow',13)}下一步行动</h3><div class="next-step">${esc(t.nextStep||'还没有写下下一步。点击编辑，写一个可以直接开始的动作。').replaceAll('\n','<br>')}</div></section>${t.checklist.length?`<section class="detail-section"><h3>${icon('tasks',13)}核对清单 <span class="muted">${s.checklistDone}/${s.checklistTotal}</span></h3><div class="checklist">${t.checklist.map(check=>`<label><input type="checkbox" data-task="${esc(t.id)}" data-check="${esc(check.id)}" ${check.done?'checked':''} ${s.isDone||s.isSyncPending||s.isSyncFailed?'disabled':''}>${esc(check.text)}</label>`).join('')}</div></section>`:''}<section class="detail-section"><h3>${icon('flag',13)}怎样才算完成</h3><p>${esc(t.doneCriteria||'完成当前承诺，并留下必要的结果。')}</p></section>${renderSyncStatus(t)}<div class="detail-actions">${s.isDone?button('reopen','重新打开任务','btn btn-secondary',t.id,'undo'):s.isWaiting?button('resume','条件已满足，恢复','btn btn-primary',t.id,'play'):s.isSyncPending?'':`${s.isSyncFailed?button('retry','重试同一次操作','btn btn-primary',t.id,'refresh'):button('complete','确认完成','btn btn-primary',t.id,'check')}${!s.isSyncFailed?button('wait','等待条件','btn btn-secondary',t.id,'pause')+button('now',t.now?'移出行动池':'加入行动池','btn btn-secondary',t.id,'target')+(t.state==='todo'?button('start','开始处理','btn btn-link',t.id,'play'):''):''}`}</div>${t.needsTriage?button('organized','下一步已明确，整理完成','btn btn-link',t.id):''}${t.aiNote?`<div class="detail-section"><h3>${icon('spark',13)}已附一份 AI 演示草稿</h3>${button('panel-tab','查看草稿与核对结果 →','btn btn-link','assistant')}</div>`:''}${t.history.length?`<section class="detail-section"><h3>最近活动</h3><ol class="history">${t.history.slice(-5).reverse().map(h=>`<li>${esc(h.message)}<time>${esc(h.at.replace('T',' ').slice(0,16))}</time></li>`).join('')}</ol></section>`:''}`;}
function renderSyncStatus(t){if(t.syncStatus==='pending')return `<div class="sync-status pending" role="status">${icon('clock',13)} 等待模拟来源确认。当前仍未完成，不会提前写入完成日志。<br><small>操作 ${esc(t.pendingOperation?.id)} · 可在刷新后继续核对</small><div>${button('resolve-success','模拟收到确认','btn btn-secondary btn-small',t.id)} ${button('resolve-failure','模拟失败','btn btn-small',t.id)} ${button('cancel-complete','取消这次完成操作','btn btn-link',t.id)}</div></div>`;if(t.syncStatus==='failed')return `<div class="sync-status failed" role="status">${icon('info',13)} 模拟同步失败：未收到来源确认。原任务仍未完成，重试不会创建副本。<br><small>保留同一操作 ${esc(t.pendingOperation?.id)}</small><br>${button('cancel-complete','取消这次完成操作，继续处理','btn btn-link',t.id)}</div>`;return '';}
function renderTaskMaterials(t){return `<h2 class="detail-title" style="font-size:17px">围绕这件事的依据</h2><div class="source-explainer">资料可以来自 Craft、飞书或 Obsidian。这里只建立关联，任务主档仍是滴答清单。</div>${t.materialIds.map(materialById).filter(Boolean).map(m=>renderMaterial(m,t)).join('')||empty('还没有关联资料','把执行时需要查看的依据关联进来，不复制成新的任务。')}${button('add-material','关联一份现有资料','btn btn-secondary',t.id,'plus')}<div class="divider"></div><p class="muted" style="font-size:10px;line-height:1.8">关联关系和资料正文均为示例。移除关联不会删除原资料。</p>`;}
function renderMaterial(m,task){return `<article class="material-card"><div class="material-head"><span>${sourceMark(m.source)} ${SOURCE_NAMES[m.source]} · ${esc(m.kind)}</span>${task?iconButton('remove-material','移除关联，不删除资料','close',`${task.id}|${m.id}`):''}</div><h4>${esc(m.title)}</h4><p>${esc(m.body)}</p><div class="task-meta">${esc(m.project)} · ${dateLabel(m.updatedAt)} · 示例正文</div></article>`;}
function renderAssistant(t){const generating=busyAI.has(t.id);return `<div class="assistant-badge">${icon('spark',18)}与这项任务一起工作<span class="mini-label">模拟</span></div><div class="ai-task-card">${icon('circleCheck',14)}${esc(t.title)}</div><p class="assistant-intro">我会围绕当前任务和已关联的 ${t.materialIds.length} 份资料准备草稿。你决定采用什么，以及什么时候算完成。</p><div class="prompt-list"><button data-action="ai" data-id="${esc(t.id)}" data-prompt="checklist" ${generating?'disabled':''}>${icon('tasks',13)} 整理一份核对清单</button><button data-action="ai" data-id="${esc(t.id)}" data-prompt="next" ${generating?'disabled':''}>${icon('arrow',13)} 帮我拆出能开始的下一步</button><button data-action="ai" data-id="${esc(t.id)}" data-prompt="reply" ${generating?'disabled':''}>${icon('document',13)} 准备一段待核对的反馈草稿</button></div>${generating?'<div class="ai-output" role="status">正在准备演示草稿…<br>这一步不会改变任务状态。</div>':t.aiNote?`<div class="ai-output"><strong>AI 演示草稿 · 请人工核对</strong><br>${esc(t.aiNote)}</div><div class="ai-disclaimer">已附到当前任务，未创建新任务，也未向任何人发送。上述内容是固定演示逻辑，不代表真实图纸分析。</div>`:''}<form id="assistant-form" data-task="${esc(t.id)}"><div class="assistant-input"><textarea id="assistant-prompt" name="prompt" aria-label="给当前任务的助手输入" placeholder="围绕当前任务继续问一句…" ${generating?'disabled':''}>${esc(ui.assistantDrafts[t.id]||'')}</textarea><button class="icon-btn" type="submit" aria-label="生成演示回复" ${generating?'disabled':''}>${icon('send',16)}</button></div></form><div class="ai-disclaimer">仅使用固定示例内容进行交互演示，不调用模型、不上传资料、不自动创建或完成任务。</div>`;}
function renderCandidatePanel(c){if(!c)return '';const material=materialById(c.materialId);const resolved=c.resolvedTaskId;const draft=ui.candidateDrafts[`${c.id}:${ui.candidateMode}`]||{};return `<aside class="detail-panel" aria-label="线索整理"><div class="detail-top"><span>${icon('inbox',13)}整理线索 · 尚未承诺执行</span>${iconButton('panel-close','关闭线索详情','close')}</div><div class="detail-scroll"><div class="candidate-heading">${sourceMark(c.source)}${SOURCE_NAMES[c.source]} · ${esc(c.project)}</div><h2 class="detail-title">${esc(c.title)}</h2><p class="detail-purpose">${esc(c.summary)}</p>${material?`<details class="source-explainer" style="margin-top:16px"><summary>查看原资料依据</summary><p style="margin-top:10px">${esc(material.body)}</p></details>`:''}${resolved?`<div class="sync-status">这条线索已经${c.status==='created'?'确认创建任务':'与原任务关联'}。不会再次新建副本。</div>${button('task','打开同一项任务 →','btn btn-primary',resolved)}`:ui.showResolved?`${button('restore-candidate','重新整理这条线索','btn btn-secondary',c.id)}`:`<div class="detail-section"><h3>这条线索应该如何处理？</h3>${[['link','关联已有任务','只增加依据，不增加任务数量。','link'],['update','更新已有任务','补充下一步，原日期和清单不变。','edit'],['create','确认新建任务','确实是新的行动，才保存到滴答。','plus']].map(([mode,title,sub,glyph])=>`<button class="candidate-choice ${ui.candidateMode===mode?'active':''}" data-action="candidate-mode" data-id="${mode}" aria-pressed="${ui.candidateMode===mode}"><strong>${icon(glyph,14)}${title}</strong><small>${sub}</small></button>`).join('')}</div><form class="candidate-form" id="candidate-form" data-id="${esc(c.id)}" data-mode="${ui.candidateMode}">${ui.candidateMode==='create'?`<label class="form-field">任务标题<input id="candidate-title" name="title" aria-label="候选新任务标题" value="${esc(draft.title??c.title)}" required maxlength="200"></label><div class="confirmation-note">将模拟创建到：滴答清单 / 收集箱。保留来源资料，不默认设置截止日期。</div>`:`<label class="form-field">选择原任务<select name="taskId" id="candidate-target" aria-label="要关联或更新的原任务">${state.tasks.filter(t=>t.state!=='done').map(t=>`<option value="${esc(t.id)}" ${t.id===(draft.taskId||ui.candidateTarget)?'selected':''}>${esc(t.title)} · ${esc(t.project)}</option>`).join('')}</select></label>${ui.candidateMode==='update'?`<label class="form-field">补充下一步<textarea id="candidate-next-step" name="nextStep" aria-label="更新后的下一步" required>${esc(draft.nextStep??`核对新资料：${material?.title||c.title}，保留需要确认的问题。`)}</textarea></label>`:''}<div class="confirmation-note">${ui.candidateMode==='update'?'更新原任务下一步，并关联这份资料。':'只关联这份资料。'}保留原任务 ID、清单和日期，不新增任务。</div>`}<button class="btn btn-primary" type="submit">${icon('check',14)}${ui.candidateMode==='create'?'确认创建（演示）':ui.candidateMode==='update'?'确认更新原任务':'确认关联原任务'}</button></form><div class="detail-actions">${button('candidate-ignore','只保留资料','btn btn-link',c.id)}${button('candidate-defer','稍后处理','btn btn-link',c.id)}</div>`}</div><div class="detail-footer">${icon('info',12)}资料范围不等于 AI 授权；这版不会上传或写入真实来源。</div></aside>`;}

function renderJournal(){const completed=state.journal.filter(j=>j.type==='completed'&&!j.reopenedAt);const entries=[...state.journal];return `<div class="page-heading"><div><div class="eyebrow">从行动到结果</div><h1>完成的事，留下轨迹</h1><p>记录实际完成日期，也保留重新打开的历史。</p></div><div class="heading-icon">${icon('journal',23)}</div></div><div class="journal-summary"><div><strong>${completed.length}</strong><span>有效完成记录</span></div><div><strong>${state.tasks.filter(t=>t.state==='waiting').length}</strong><span>等待条件</span></div><div><strong>${state.journal.filter(j=>j.type==='reopened').length}</strong><span>重新打开</span></div></div><div class="info-line"><span>${icon('info',14)}这里是本原型的模拟执行记录。没有截止日期的任务，也会按完成当天进入日志。</span></div>${entries.length?entries.map(j=>`<article class="journal-item"><div class="journal-mark">${icon(j.type==='reopened'?'undo':'check',13)}</div><div><time>${dateLabel(j.date)} · ${j.type==='reopened'?'模拟重新打开':'模拟来源确认完成'}${j.reopenedAt?' · 后续已重开':''}</time><h3>${esc(j.title)}</h3><p>${esc(j.project)} · 同一任务 ${esc(j.taskId)}<br>${j.type==='reopened'?'历史没有被抹掉，原任务回到可执行状态。':j.reopenedAt?'这次完成保留为历史，不计入当前已完成数量。':'完成结果与来源确认已记录，可以继续回到原任务查看依据。'}</p>${button('journal-task','查看原任务 →','btn btn-link',j.taskId)}</div></article>`).join(''):empty('还没有完成记录','先处理一项任务，再模拟完成确认。日志会自动出现。','view','回到任务','now')}<div class="workspace-footnote">${icon('shield',12)}本机示例历史 · 仅在模拟来源确认成功后记录完成</div>`;}
function renderInsights(){const waiting=state.tasks.filter(t=>t.state==='waiting');const candidates=state.candidates.filter(c=>c.status==='pending');return `<div class="page-heading"><div><div class="eyebrow">有依据的发现</div><h1>发现值得关注的事</h1><p>洞察帮助你作判断，不直接替你增加任务或宣布完成。</p></div><div class="heading-icon">${icon('spark',23)}</div></div><article class="insight-card"><div class="eyebrow">资料变化 · 任务关联</div><h3>新的资料，可能属于已经在做的事</h3><p>当前有 ${candidates.length} 条尚未判断的线索。先关联原任务，就能补全依据，而不增加一份重复待办。</p>${button('view','去判断这些线索','btn btn-secondary','triage','inbox')}</article><article class="insight-card"><div class="eyebrow">推进阻碍 · 等待条件</div><h3>${waiting.length} 项任务正在等待外部条件</h3><p>查看具体等谁、缺少什么，以及何时回看。收到回复时恢复原任务，无需另建“跟进”任务。</p>${button('view','检查等待事项','btn btn-secondary','waiting','clock')}</article><article class="insight-card"><div class="eyebrow">执行回顾 · 结果</div><h3>做完了什么，也要能找回为什么</h3><p>在日志中查看完成结果，返回同一任务查看关联资料。重新打开任务时，保留历史，不伪造持续完成。</p>${button('page','查看执行轨迹','btn btn-secondary','journal','journal')}</article><div class="workspace-footnote">${icon('info',12)}以上是根据示例状态生成的固定规则提示，不是真实 AI 分析。</div>`;}
function renderMaterialsPage(){return `<div class="page-heading"><div><div class="eyebrow">上下文，不是待办堆积</div><h1>资料围绕任务流动</h1><p>这些是示例依据。查看、关联、移除关联，都不会删除原资料。</p></div><div class="heading-icon">${icon('layers',23)}</div></div>${state.materials.map(m=>`${renderMaterial(m)}<div style="margin:-3px 0 22px">${state.tasks.filter(t=>t.materialIds.includes(m.id)).map(t=>button('journal-task',`${icon('link',12)} ${esc(t.title)}`,'btn btn-link',t.id)).join('')||'<span class="muted" style="font-size:10px">暂未关联任务 · 可在待整理中判断</span>'}</div>`).join('')}`;}

function showDialog(title,body,actions,onSubmit){
  lastDialogFocus=document.activeElement;dialogSubmit=onSubmit;
  dialogContent.innerHTML=`<form id="modal-form"><div class="dialog-header"><h2 id="dialog-title">${esc(title)}</h2>${iconButton('dialog-close','关闭对话框','close')}</div><div class="dialog-body">${body}<div id="dialog-error" class="dialog-error" role="alert"></div></div><div class="dialog-actions">${actions}</div></form>`;
  if(!dialog.open)dialog.showModal();
  const first=dialog.querySelector('input:not([type="checkbox"]),textarea,select');if(first)first.focus();
}
function closeDialog(){dialog.close();dialogSubmit=null;const origin=lastDialogFocus?.isConnected?lastDialogFocus:lastDialogFocus?.dataset.id?root.querySelector(`[data-suggestion="${CSS.escape(lastDialogFocus.dataset.id)}"]`):null;(origin||document.querySelector('#planning-form button[type="submit"]'))?.focus({preventScroll:true});}
dialog.addEventListener('click',e=>{if(e.target.closest('[data-action="dialog-close"]'))closeDialog();});
dialog.addEventListener('close',()=>{if(!dialog.open){dialogSubmit=null;if(lastDialogFocus?.isConnected)lastDialogFocus.focus();}});
dialogContent.addEventListener('submit',event=>{event.preventDefault();if(dialogSubmit)dialogSubmit(new FormData(event.target));});
function formActions(label){return `${button('dialog-close','取消','btn')}<button type="submit" class="btn btn-primary">${label}</button>`;}
function newTask(){const requestId=`create-${Date.now()}-${Math.random().toString(36).slice(2,7)}`;showDialog('新建一个明确的任务',`<p>你已经决定要做的事，可以直接创建。不需要先经过候选确认。</p><label class="form-field">任务标题<input name="title" required maxlength="200" placeholder="例如：核对新版接口定义并反馈"></label><div class="form-grid"><label class="form-field">项目<input name="project" value="${esc(ui.project==='all'?'个人':ui.project)}"></label><label class="form-field">原清单<input name="list" value="收集箱"></label></div><label class="form-field">下一步行动（可选）<textarea name="nextStep" placeholder="具体从哪个动作开始？"></textarea></label><div class="form-grid"><label class="form-field">计划日期（可选）<input type="date" name="plannedDate"></label><label class="form-field">截止日期（可选）<input type="date" name="due"></label></div><div class="confirmation-note">保存位置：滴答清单（模拟）。只创建一项任务，不另建 Hub 副本。</div>`,formActions('创建任务（演示）'),data=>{const before=new Set(state.tasks.map(t=>t.id));if(dispatch({type:'ADD_TASK',...Object.fromEntries(data),requestId})){const t=state.tasks.find(t=>!before.has(t.id));closeDialog();ui.project='all';ui.source='all';ui.query='';ui.status='open';navigate('tasks','all');openTask(t?.id);toast('已模拟创建到滴答收集箱，仅此一项任务');}});}
function editTask(id){const t=taskById(id);if(!t)return;if(['pending','failed'].includes(t.syncStatus)){toast('请先核对或取消当前完成操作，再修改任务');openTask(id);return;}showDialog('编辑原任务',`<p>修改的是同一项任务。项目、原清单、计划日期与截止日期分别保留。</p><label class="form-field">任务标题<input name="title" value="${esc(t.title)}" required maxlength="200"></label><div class="form-grid"><label class="form-field">项目<input name="project" value="${esc(t.project)}"></label><label class="form-field">原清单<input name="list" value="${esc(t.list)}"></label></div><label class="form-field">下一步行动<textarea name="nextStep">${esc(t.nextStep)}</textarea></label><label class="form-field">完成标准<textarea name="doneCriteria">${esc(t.doneCriteria)}</textarea></label><div class="form-grid"><label class="form-field">计划日期<input type="date" name="plannedDate" value="${esc(t.plannedDate)}"></label><label class="form-field">截止日期<input type="date" name="due" value="${esc(t.due)}"></label></div>`,formActions('保存到原任务（演示）'),data=>{if(dispatch({type:'UPDATE_TASK',id,patch:Object.fromEntries(data)},'已模拟更新原任务'))closeDialog();});}
function waitTask(id){const t=taskById(id);if(!t)return;if(['pending','failed'].includes(t.syncStatus)){toast('请先核对或取消当前完成操作，再记录等待');openTask(id);return;}showDialog('记录等待条件',`<p>等待不等于完成。记录阻碍，条件满足后继续同一任务。</p><label class="form-field">等待谁<input name="person" value="${esc(t.waiting?.person||(id==='t-harness'?'DRE':''))}" placeholder="负责人 / 供应商 / 自己" required></label><label class="form-field">还缺少什么条件<textarea name="reason" placeholder="例如：确认本次使用的最终图纸版本" required>${esc(t.waiting?.reason||(id==='t-harness'?'等待确认本次使用的最终图纸版本':''))}</textarea></label><label class="form-field">何时再看（可选）<input name="reviewDate" type="date" value="${esc(t.waiting?.reviewDate)}"></label><div class="confirmation-note">任务会移出行动池，但原清单和截止日期不变。今天到期的承诺仍会提示。</div>`,formActions('保存等待条件'),data=>{if(dispatch({type:'WAIT_TASK',id,...Object.fromEntries(data)})){closeDialog();if(ui.guide&&id===guideTask())ui.guideStep=4;navigate('tasks','waiting');openTask(id);toast('已记录等待条件，原任务没有被完成');}});}
function confirmComplete(id){const t=taskById(id);if(!t)return;const s=selectors(t);if(s.isDone){dispatch({type:'REOPEN_TASK',id},'已模拟重新打开同一任务，完成历史保留');return;}if(s.isWaiting){toast('这项任务还在等待条件，请先恢复原任务');openTask(id);return;}if(s.isSyncPending){openTask(id);return;}if(s.isSyncFailed){completeTask(id,true);return;}
  if(t.id==='t-harness'){showDialog('核对交付结果',`<p>${esc(t.title)}</p><div class="next-step">${esc(t.doneCriteria)}</div><p style="margin-top:15px">清单进度：${s.checklistDone}/${s.checklistTotal}。AI 草稿不能代替你的核对结论。</p><label class="acceptance-box"><input type="checkbox" name="accepted" required><span>我已核对必要结果，并确认这项任务可以完成。<br><small class="muted">这是原型演示，不会更改真实滴答任务。</small></span></label>`,formActions('确认完成（模拟同步）'),()=>{closeDialog();completeTask(id);});}
  else completeTask(id);
}
function completeTask(id,retry=false){if(!dispatch({type:retry?'RETRY_COMPLETE':'REQUEST_COMPLETE',id}))return;openTask(id);const t=taskById(id);if(t.syncStatus!=='pending')return;const operationId=t.pendingOperation.id;if(timers.has(operationId))return;toast(retry?'正在模拟重试同一次操作…':'正在等待模拟来源确认…');if(ui.simulation==='pending')return;const outcome=retry?'success':ui.simulation;const timer=setTimeout(()=>{timers.delete(operationId);resolveComplete(id,outcome,operationId);},850);timers.set(operationId,timer);}
function resolveComplete(id,outcome,operationId){const t=taskById(id);if(!t?.pendingOperation)return;const op=operationId||t.pendingOperation.id;const timer=timers.get(op);if(timer){clearTimeout(timer);timers.delete(op);}if(dispatch({type:'RESOLVE_COMPLETE',id,outcome,operationId:op})){if(outcome==='success'&&taskById(id)?.state==='done'){if(ui.guide&&id===guideTask())ui.guideStep=6;render();toast('模拟来源已确认完成，日志已更新',id);}else if(outcome==='failure')toast('模拟同步失败：原任务仍未完成，可重试');}}
function runAI(id,prompt='checklist',custom=''){const t=taskById(id);if(!t||busyAI.has(id))return;if(['pending','failed'].includes(t.syncStatus)){toast('请先核对或取消当前完成操作，再准备草稿');return;}const generation=asyncGeneration;busyAI.add(id);ui.panelTab='assistant';render();setTimeout(()=>{if(generation!==asyncGeneration)return;busyAI.delete(id);let text='';if(id!=='t-harness'||prompt!=='checklist')text=custom?`【针对输入的固定演示回复】\n你问：${custom}\n\n围绕“${t.title}”，先确认：${t.nextStep||'一个可执行的下一步'}。\n再查看 ${t.materialIds.length} 份关联资料，把不确定的信息列出来。\n草稿仅保存在原任务里；不会调用真实模型或自动执行。`:prompt==='reply'?`【反馈草稿 · 待人工核对，未发送】\n关于“${t.title}”：\n目前正在核对 ${t.materialIds.length} 份关联资料。\n已确认项：请按实际结果填写。\n待确认项：请补充具体问题与责任方。\n完成标准：${t.doneCriteria}\n\n这段示例不代表实际核对已经完成。`:`【AI 演示草稿 · 待人工核对】\n1. 明确目的：${t.purpose}\n2. 从这里开始：${t.nextStep||'先写下一个可立即开始的动作。'}\n3. 查看关联资料，记录不确定项。\n4. 按完成标准核对：${t.doneCriteria||'确认承诺的结果已经达成。'}\n\n没有新建任务，也没有自动标记完成。`;if(dispatch({type:'ADD_AI_NOTE',id,...(text?{text}:{})})){if(ui.guide&&id===guideTask())ui.guideStep=3;render();toast('演示草稿已附到原任务，等待你核对');}},650);}

function adoptPlan(id){
  const mode=ui.planningMode;const run=state.planning?.runs[mode];const suggestion=run?.suggestions.find(s=>s.id===id);
  if(!suggestion)return;
  if(suggestion.kind!=='nextStep'){dispatch({type:'PLAN_ADOPT',mode,id},'已采用，采纳记录已更新');return;}
  const task=taskById(suggestion.taskId);
  showDialog('预览来源修改（演示）',`<p>目标：${esc(SOURCE_NAMES[task.source])} / ${esc(task.list)}<br>原任务：${esc(task.title)}</p><dl class="planning-diff"><dt>修改前 · 下一步</dt><dd>${esc(task.nextStep||'未填写')}</dd><dt>修改后 · 下一步</dt><dd>${esc(suggestion.text)}</dd></dl><p>仅修改下一步；保留原任务 ID、清单、截止日和完成状态。</p><label class="form-field">模拟保存结果<select name="outcome"><option value="success">来源确认成功</option><option value="failure">保存失败，来源未改动</option><option value="unknown">连接中断，结果未知</option></select></label><p class="muted">这里只操作示例任务，不连接真实滴答。</p>`,formActions('确认模拟修改'),data=>{if(dispatch({type:'PLAN_ADOPT',mode,id,outcome:data.get('outcome')},'模拟操作已记录，请查看建议下方结果'))closeDialog();});
}

function openSimulation(){showDialog('选择演示情境',`<p>这里只模拟完成时的来源确认，不会向滴答、Craft 或飞书发送请求。</p><label class="form-field">下一次完成操作<select name="simulation"><option value="success"${ui.simulation==='success'?' selected':''}>正常：提交后收到确认</option><option value="failure"${ui.simulation==='failure'?' selected':''}>失败：保持未完成，可重试</option><option value="pending"${ui.simulation==='pending'?' selected':''}>待确认：手动模拟收到回执</option></select></label><p>“重试同一次操作”会演示恢复成功，保留原操作 ID，不产生重复任务或日志。</p><div class="divider"></div><button type="button" class="btn btn-danger" data-modal-reset>重置本原型的示例数据</button>`,formActions('应用情境'),data=>{ui.simulation=data.get('simulation');save();closeDialog();toast('已设置下一次完成操作的模拟情境');});}
dialogContent.addEventListener('click',event=>{if(event.target.closest('[data-modal-reset]')){showDialog('重置这一个原型？','<p>这会清除此站点里你刚才创建或修改的演示记录，恢复初始示例。原 Hub 站点和真实滴答资料不受影响。</p>',formActions('确认重置示例'),()=>{for(const timer of timers.values())clearTimeout(timer);timers.clear();asyncGeneration++;busyAI.clear();skipDraftCapture=true;state=createInitialState(localDay());ui={...ui,planningBusy:false,planningMode:'today',assistantDrafts:{},candidateDrafts:{},page:'tasks',view:'now',query:'',project:'all',source:'all',selected:'t-mobile',candidate:null,panelTab:'details',showResolved:false,guide:false,layout:'list',status:'open'};save();closeDialog();navigate('tasks','now');toast('此原型的演示记录已重置；原站点未改动');});}});

root.addEventListener('click',event=>{
  const target=event.target.closest('[data-action]');if(!target)return;const {action,id}=target.dataset;
  switch(action){
    case 'plan-mode':ui.planningMode=id;navigate('planning');break;
    case 'plan-task':ui.project='all';ui.source='all';ui.query='';ui.status='all';navigate('tasks','all');openTask(id);break;
    case 'plan-remove':dispatch({type:'PLAN_REMOVE',taskId:id},'已移出 Hub 今日计划，原任务保留');break;
    case 'plan-dismiss':dispatch({type:'PLAN_DISMISS',mode:ui.planningMode,id},'已暂不采用，原任务保持原样');break;
    case 'plan-adopt':adoptPlan(id);break;
    case 'plan-retry':dispatch({type:'PLAN_RETRY',mode:ui.planningMode,id},'同一条建议已模拟保存成功');break;
    case 'plan-reconcile':dispatch({type:'PLAN_RECONCILE',mode:ui.planningMode,id},'核对结果：本次示例来源未修改，请重新分析后采用');break;
    case 'page': navigate(id);break;
    case 'view':ui.candidate=null;ui.showResolved=false;navigate('tasks',id);break;
    case 'task':openTask(id);break;
    case 'journal-task':ui.project='all';ui.source='all';ui.query='';ui.status='all';navigate('tasks','all');openTask(id);break;
    case 'candidate':openCandidate(id);break;
    case 'candidate-mode':ui.candidateMode=id;render();break;
    case 'panel-tab':ui.panelTab=id;render();{const pane=document.querySelector('.detail-scroll');if(pane)pane.scrollTop=0;}break;
    case 'panel-close':ui.selected=null;ui.candidate=null;render();break;
    case 'project':ui.project=id;ui.navOpen=false;navigate('tasks',ui.view);break;
    case 'source':ui.source=ui.source===id?'all':id;ui.navOpen=false;navigate('tasks',ui.view);break;
    case 'clear-project':ui.project='all';save();render();break;
    case 'clear-source':ui.source='all';save();render();break;
    case 'clear-filters':ui.project='all';ui.source='all';ui.query='';save();render();break;
    case 'new':newTask();break;
    case 'edit':editTask(id);break;
    case 'complete':confirmComplete(id);break;
    case 'reopen':dispatch({type:'REOPEN_TASK',id},'已模拟重新打开原任务，保留完成历史');break;
    case 'start':dispatch({type:'START_TASK',id},'开始处理这项任务');break;
    case 'now':{const previous=taskById(id)?.now;if(dispatch({type:'TOGGLE_NOW',id},previous?'已移出行动池，原任务仍然保留':'已加入行动池，未新增任务')){if(ui.guide&&id===guideTask()&&!previous){ui.guideStep=2;navigate('tasks','now');openTask(id);}}break;}
    case 'wait':waitTask(id);break;
    case 'resume':if(dispatch({type:'RESUME_TASK',id},'已恢复原任务，尚未标记完成')){if(ui.guide&&id===guideTask())ui.guideStep=5;navigate('tasks','all');openTask(id);}break;
    case 'retry':completeTask(id,true);break;
    case 'cancel-complete':{const op=taskById(id)?.pendingOperation?.id;if(op&&timers.has(op)){clearTimeout(timers.get(op));timers.delete(op);}dispatch({type:'CANCEL_COMPLETE',id},'已取消这次模拟完成操作，原任务保持未完成');break;}
    case 'resolve-success':resolveComplete(id,'success');break;
    case 'resolve-failure':resolveComplete(id,'failure');break;
    case 'ai':runAI(id,target.dataset.prompt);break;
    case 'organized':if(!taskById(id)?.nextStep.trim()){toast('先写下一个明确的下一步，再整理完成');editTask(id);}else dispatch({type:'UPDATE_TASK',id,patch:{needsTriage:false}},'收集箱整理完成，仍然是原来那项任务');break;
    case 'candidate-ignore':case 'candidate-defer':if(dispatch({type:'RESOLVE_CANDIDATE',id,decision:action==='candidate-ignore'?'ignore':'defer'},action==='candidate-ignore'?'已保留资料，不创建任务':'已暂放，可从处理记录恢复')){ui.candidate=null;if(ui.guide&&id==='c-drawing'){ui.guide=false;toast('这条线索暂不行动，也是有效的处理结果。');}render();}break;
    case 'restore-candidate':dispatch({type:'RESTORE_CANDIDATE',id},'已放回待判断线索');ui.showResolved=false;openCandidate(id);break;
    case 'resolved':ui.showResolved=!ui.showResolved;ui.candidate=null;render();break;
    case 'remove-material':{const [taskId,materialId]=id.split('|');dispatch({type:'REMOVE_MATERIAL',id:taskId,materialId},'已移除关联，原资料没有删除');break;}
    case 'add-material':{const t=taskById(id);const materials=state.materials.filter(m=>!t.materialIds.includes(m.id));if(!materials.length){toast('现有示例资料都已关联');break;}showDialog('关联现有资料',`<p>只建立关联，不创建新任务，也不复制资料正文。</p><label class="form-field">选择资料<select name="materialId">${materials.map(m=>`<option value="${m.id}">${SOURCE_NAMES[m.source]} · ${esc(m.title)}</option>`).join('')}</select></label>`,formActions('确认关联'),data=>{if(dispatch({type:'ADD_MATERIAL',id,materialId:data.get('materialId')},'已把资料关联到原任务'))closeDialog();});break;}
    case 'theme':ui.theme=ui.theme==='dark'?'light':'dark';save();render();break;
    case 'nav':ui.navOpen=!ui.navOpen;render();break;
    case 'simulation':openSimulation();break;
    case 'guide':ui.guide=true;resumeGuide();ui.project='all';ui.source='all';ui.query='';ui.layout='list';ui.status='open';ui.showResolved=false;if(ui.guideStep===0){if(['ignored','deferred'].includes(candidateById('c-drawing')?.status))dispatch({type:'RESTORE_CANDIDATE',id:'c-drawing'});navigate('tasks','triage');openCandidate('c-drawing');}else if(ui.guideStep===6)navigate('journal');else{navigate('tasks',guideSteps[ui.guideStep][2]);openTask(guideTask(),ui.guideStep===2?'assistant':'details');}break;
    case 'guide-close':ui.guide=false;render();break;
    case 'guide-go':{const step=ui.guideStep;if(step===0){navigate('tasks','triage');openCandidate('c-drawing');}else if(step===6)navigate('journal');else{navigate('tasks',guideSteps[step][2]);openTask(guideTask(),step===2?'assistant':'details');}break;}
    case 'flow-open':ui.project='all';ui.source='all';ui.query='';if(target.dataset.target==='journal')navigate('journal');else navigate('tasks',target.dataset.target);break;
    case 'about':showDialog('关于这版任务原型','<p>这是独立的 Hub 任务流程实验室，原工作台没有被修改。</p><ul><li>任务和材料均为虚构示例，修改仅保存在此浏览器。</li><li>所有“滴答保存”“同步确认”和 AI 回复都是模拟。</li><li>待整理线索不自动成为任务，行动池不复制原任务。</li><li>等待、完成、同步和日志分别记录。</li><li>原型内可以切换明暗主题、视图和失败情境。</li></ul>',button('dialog-close','知道了','btn btn-primary'),null);break;
  }
});
root.addEventListener('input',event=>{if(event.target.id==='task-search'){ui.query=event.target.value;render();}else if(event.target.closest('#assistant-form,#candidate-form')){captureDrafts();save();}});
root.addEventListener('change',event=>{
  const el=event.target;
  if(el.closest('#planning-form')){const values=Object.fromEntries(new FormData(el.form));ui.planCapacity=values.capacity||ui.planCapacity;ui.planProject=values.project||ui.planProject;ui.planTask=values.taskId||ui.planTask;ui.planCoverage=values.coverage;save();}
  if(el.id==='layout-select'){ui.layout=el.value;save();render();}
  if(el.id==='status-filter'){ui.status=el.value;if(ui.selected&&!visibleTasks().some(t=>t.id===ui.selected))ui.selected=null;save();render();}
  if(el.id==='candidate-target'){ui.candidateTarget=el.value;captureDrafts();save();}
  if(el.dataset.check)dispatch({type:'TOGGLE_CHECK',id:el.dataset.task,checkId:el.dataset.check});
});
root.addEventListener('submit',event=>{
  event.preventDefault();const form=event.target;const data=new FormData(form);
  if(form.id==='planning-form'){
    if(ui.planningBusy)return;
    const mode=ui.planningMode;const generation=asyncGeneration;const values=Object.fromEntries(data);
    ui.planningBusy=true;render();
    const timer=setTimeout(()=>{timers.delete('planning');if(generation!==asyncGeneration)return;ui.planningBusy=false;dispatch({type:'PLAN_RUN',mode,...values});},550);
    timers.set('planning',timer);return;
  }
  if(form.id==='candidate-form'){
    const c=candidateById(form.dataset.id);const before=state.tasks.length;const mode=ui.candidateMode;
    if(dispatch({type:'RESOLVE_CANDIDATE',id:c.id,decision:mode,...Object.fromEntries(data)})){
      const resolved=candidateById(c.id);const count=state.tasks.length-before;
      if(ui.guide&&c.id==='c-drawing'){ui.guideTaskId=resolved.resolvedTaskId;ui.guideStep=1;}
      ui.project='all';ui.source='all';ui.query='';ui.status='open';navigate('tasks','all');openTask(resolved.resolvedTaskId,mode==='link'?'materials':'details');
      toast(count?`已模拟创建 ${count} 项任务，来源依据已保留`:mode==='update'?'已更新原任务并关联资料，任务数量不变':'资料已关联到原任务，任务数量没有增加');
    }
  }
  if(form.id==='assistant-form'){const prompt=String(data.get('prompt')||'').trim();if(!prompt){toast('先写一句你希望助手帮忙的内容');return;}const task=taskById(form.dataset.task);if(!task){toast('当前任务已不可用，输入草稿已保留');return;}if(busyAI.has(task.id)){toast('演示草稿仍在生成，输入内容已保留');return;}if(['pending','failed'].includes(task.syncStatus)){toast('请先核对或取消当前完成操作，输入草稿已保留');return;}ui.assistantDrafts[form.dataset.task]='';const input=form.querySelector('textarea');if(input)input.value='';save();runAI(form.dataset.task,'custom',prompt);}
});
document.addEventListener('keydown',event=>{if(event.key==='Escape'&&!dialog.open&&(ui.selected||ui.candidate)){ui.selected=null;ui.candidate=null;render();}if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='k'){event.preventDefault();if(ui.page!=='tasks')navigate('tasks','all');document.getElementById('task-search')?.focus();}});
if(ui.page==='tasks'&&ui.selected&&!visibleTasks().some(t=>t.id===ui.selected))ui.selected=null;
window.addEventListener('pagehide',save);
render();
