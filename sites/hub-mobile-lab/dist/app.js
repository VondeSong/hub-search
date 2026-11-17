'use strict';
const $ = (s) => document.querySelector(s);
const paths = {
 pin:'M8 3h8l-1 6 4 4v2H5v-2l4-4-1-6ZM12 15v6', trash:'M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7', mic:'M9 5a3 3 0 0 1 6 0v7a3 3 0 0 1-6 0V5ZM6 10v2a6 6 0 0 0 12 0v-2M12 18v4m-4 0h8', filter:'M4 5h16M7 12h10M10 19h4',
 hash:'M4 9h16M3 15h16M10 3 8 21M17 3l-2 18', image:'M3 3h18v18H3ZM3 16l5-5 5 5 3-3 5 5M8 7h.01', bold:'M6 4h7a4 4 0 0 1 0 8H6Zm0 8h8a4 4 0 0 1 0 8H6Z', list:'M9 6h12M9 12h12M9 18h12M3 6h.01M3 12h.01M3 18h.01', send:'m22 2-7 20-4-9-9-4 20-7ZM22 2 11 13',
 cloud:'M7 18h11a4 4 0 0 0 .6-7.95A6 6 0 0 0 7 8a5 5 0 0 0 0 10Z',
 arrowUp:'M12 20V4m-7 7 7-7 7 7', stop:'M7 7h10v10H7Z',
 paperclip:'m8 13 6-6a3 3 0 0 1 4 4l-8 8a5 5 0 0 1-7-7l9-9',
 camera:'M8 6l2-3h4l2 3h4v14H4V6Zm8 7a4 4 0 1 0-8 0 4 4 0 0 0 8 0Z',
 video:'M3 6h12v12H3Zm12 4 6-4v12l-6-4',
 wifi:'M3 8a15 15 0 0 1 18 0M6 12a10 10 0 0 1 12 0m-9 4a5 5 0 0 1 6 0m-3 4h.01',
 shield:'M12 3 4 6v6c0 5 8 9 8 9s8-4 8-9V6Zm-4 9 3 3 5-6',
 chevronDown:'m6 9 6 6 6-6', copy:'M8 8h12v13H8ZM16 8V3H3v13h5',

 more:'M5 12h.01M12 12h.01M19 12h.01',
 circle:'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z',
 search:'M21 21l-4.4-4.4M18 11a7 7 0 1 1-14 0 7 7 0 0 1 14 0Z', folder:'M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z',
 task:'M9 6h11M9 12h11M9 18h11M3 6l1 1 2-2M3 12l1 1 2-2M3 18l1 1 2-2', cards:'M8 4h11a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2ZM3 9v10a2 2 0 0 0 2 2h12M10 9h7m-7 4h4',
 spark:'M12 2l2.4 6.6L21 11l-6.6 2.4L12 20l-2.4-6.6L3 11l6.6-2.4L12 2Zm7 14v6m-3-3h6', chev:'m9 6 6 6-6 6', back:'m14 6-6 6 6 6m-6-6h12', plus:'M12 5v14M5 12h14', tune:'M4 6h16M4 12h16M4 18h16M8 4v4m8 2v4m-7 2v4', close:'m6 6 12 12M18 6 6 18',
 book:'M3 5h5a4 4 0 0 1 4 4v12a4 4 0 0 0-4-4H3Zm18 0h-5a4 4 0 0 0-4 4v12a4 4 0 0 1 4-4h5Z', note:'M6 3h8l4 4v14H6ZM14 3v5h4M9 12h6m-6 4h6', clock:'M12 7v5l3 2m6-2a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z',
 calendar:'M4 6h16v14H4Zm0 4h16M8 3v5m8-5v5', tag:'M3 4h8l10 10-7 7L3 10Zm4 3h.01', star:'m12 3 2.7 5.5 6.1.9-4.4 4.3 1 6.1-5.4-2.9-5.4 2.9 1-6.1L3.2 9.4l6.1-.9Z',
 sync:'M20 7v5h-5M4 17v-5h5m-4-3a8 8 0 0 1 13-3l2 3M4 15l2 3a8 8 0 0 0 13-3', info:'M12 11v5m0-8h.01m9 4a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z', check:'m5 12 4 4L19 6',
 link:'M13 5h6v6m0-6-9 9m-1-9H5v14h14v-4', money:'M4 6h16v12H4Zm8 8a2 2 0 1 0 0-4 2 2 0 0 0 0 4ZM7 12h.01m10 0h.01',
 chat:'M4 5h16v12H9l-5 4Z', settings:'M10.06 4.76L10.61 2.10L13.39 2.10L13.94 4.76L15.75 5.50L18.02 4.01L19.99 5.98L18.50 8.25L19.24 10.06L21.90 10.61L21.90 13.39L19.24 13.94L18.50 15.75L19.99 18.02L18.02 19.99L15.75 18.50L13.94 19.24L13.39 21.90L10.61 21.90L10.06 19.24L8.25 18.50L5.98 19.99L4.01 18.02L5.50 15.75L4.76 13.94L2.10 13.39L2.10 10.61L4.76 10.06L5.50 8.25L4.01 5.98L5.98 4.01L8.25 5.50ZM15 12a3 3 0 1 0-6 0 3 3 0 0 0 6 0Z'
};
const ico=(name,n=21)=>'<svg width="'+n+'" height="'+n+'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="'+(paths[name]||paths.note)+'"/></svg>';
const esc=(v)=>String(v??'').replace(/[&<>"']/g,(c)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const initial={find:{},corrections:{},notes:[],tasks:{},reading:{},stars:{},reviewed:[],history:[],offline:false,sourceChanged:false,revised:false,agent:false,draft:'',drafts:{},feedback:{},jobs:[],desktopOnline:false,cloudEnabled:true,readingSync:true,reviewSync:true,syncError:false,lastSync:null,actions:[],cache:{},grades:{},studyDeck:'全部',customTasks:[],linkedTasks:{},captureDraft:{kind:'note',text:'',title:'',url:''},preferences:{theme:'light',accent:'blue',largeText:false,reduceTransparency:false}};
let st;
try{const stored=JSON.parse(localStorage.getItem('hub-mobile-v1')||'{}');st={...structuredClone(initial),...(stored&&typeof stored==='object'&&!Array.isArray(stored)?stored:{})}}catch{st=structuredClone(initial)}
for(const key of ['notes','reviewed','history','jobs','actions','customTasks','customCards'])if(!Array.isArray(st[key]))st[key]=[];
for(const key of ['find','corrections','tasks','reading','stars','drafts','feedback','cache','grades','linkedTasks','captureDraft','preferences'])if(!st[key]||typeof st[key]!=='object'||Array.isArray(st[key]))st[key]=structuredClone(initial[key]||{});
for(const [id,value] of Object.entries(st.corrections||{})){if(value&&!st.feedback[id])st.feedback[id]=[{text:value,at:null,sent:false}];}
st.corrections={};
let readingQuery='', starQuery='', tagQuery='', taskDate='所有日期', searchDate='不限日期', searchType='全部类型', searchFolder='全部分组', readingView='全部内容', logMonth='11 月', undoTask=null;
let query='', source='全部资料库', readingSource='全部来源', readingFilter='全部', taskFilter='待办', filter='待关注', face=false, cardIndex=0, compare='month', toastTimer;
const save=()=>{try{localStorage.setItem('hub-mobile-v1',JSON.stringify(st));return true}catch{tell('浏览器暂时无法保存。请保留当前页面并重试。');return false}};
function tell(t){const el=$('#toast');el.textContent=t;el.hidden=false;const feedback=$('#sheet-feedback');if($('#sheet').open&&feedback){feedback.textContent=t;feedback.hidden=false}clearTimeout(toastTimer);toastTimer=setTimeout(()=>el.hidden=true,3800)}
const navs=[['search','搜索','search'],['browse','浏览','folder'],['agents','助手','chat'],['tasks','任务','task'],['review','复习','cards']];
const docs={
 d1:{t:'11 月 7 日 · 日志',s:'Obsidian',date:'11 月 7 日',tag:'生活日志',k:'日记 加班 作息 运动',body:'晚上加班到 21:20，原定的跑步没有去。回家后看了两集《漫长的季节》，大约 00:40 睡。'},
 d2:{t:'11 月 8 日 · 日志',s:'Obsidian',date:'11 月 8 日',tag:'生活日志',k:'日记 加班 作息 运动',body:'补完项目材料后取消了夜跑。晚饭后看了一集《漫长的季节》，过了午夜才睡。'},
 d3:{t:'阅读笔记：留出可回看的记录',s:'Craft',date:'11 月 8 日',tag:'阅读笔记',k:'阅读 笔记 复盘',body:'与其只收藏链接，不如先写下一句它和当前问题的关系。下次回看时，这句话能恢复当时的上下文。\n\n一个很小的做法：读完后补上「我为什么留下这段内容」。不用把整篇文章重新整理，只留下当时真正关心的那个问题。\n\n再次打开时，先看这句话，再回到原文。如果想法有了变化，就补一条新的记录，保留前后的思路。'},
 d4:{t:'11 月已记录支出',s:'Craft',date:'11 月 9 日',tag:'账目',k:'消费 医疗 支出 餐饮',body:'示例范围：11 月 1 日至 9 日，同一账户。餐饮 ¥500、就诊 ¥300、就诊退款 ¥100。净支出 ¥700。同期示例：上年餐饮 ¥500，净支出 ¥500。此处仅代表所选记录。'},
 d5:{t:'项目周回顾：验证与下一步',s:'Craft',date:'11 月 8 日',tag:'项目',k:'项目 验证 原型 工作',body:'纸面原型的核对已完成。实机验证仍未开始；下一步是用一组小样本验证交互与数据回读。'},
 d7:{t:'实机验证清单.pdf',s:'Craft',date:'11 月 9 日',tag:'项目',type:'PDF',k:'验证 附件 清单',body:'第 1 页：核对引用定位、手机返回和离线恢复。原型仅提供此示例页的文字摘录。'},
 d8:{t:'10 月 30 日 · 日志',s:'Obsidian',date:'10 月 30 日',tag:'生活日志',k:'日记 回顾',body:'月底整理了待回看的笔记。'},
 d6:{t:'11 月 9 日 · 日志',s:'Obsidian',date:'11 月 9 日',tag:'生活日志',k:'日记 阅读 运动',body:'读完《把时间当作朋友》。下午散步 25 分钟，晚上按原计划休息。'},
};
const reading=[
 {id:'r1',t:'让阅读笔记在下次有用',src:'X 书签',blurb:'用一个明确的问题串起摘录与应用。',body:'记录一句自己真正关心的问题，再把摘录和应用场景放在一起。下一次阅读并不需要重做整份笔记。\n\n试着把「值得收藏」换成一个具体问题：这段内容能帮助我做什么？问题越小，下次重新打开时就越容易继续。\n\n摘录可以短一些。保留必要的上下文和出处，再写一句自己的理解；遇到尚未核实的部分，也一起留下。\n\n整理不需要在这一刻完成。先读、先留下一点想法，回看时再决定它应该成为任务、笔记，还是一张复习卡。',status:'未读'},
 {id:'r2',t:'一周如何留出恢复时间',src:'Telegram',blurb:'对照日程和实际休息，识别被挤掉的空白。',body:'一周的计划里写下预留时间；结束后分别看计划和实际，不把取消的安排当作发生过。',status:'阅读中'},
 {id:'r3',t:'移动端信息密度检查清单',src:'滴答稍后读',blurb:'触控目标、首屏层级与返回位置。',body:'先验证单手能完成主要动作，再验证长文、窄屏和输入法出现时还能回到原位置。',status:'已读'},
 {id:'r4',t:'日常复盘中的例外',src:'X 喜欢',blurb:'用反例检查看起来合理的规律。',body:'尝试找到不符合解释的记录，避免只用支持当前假设的例子。',status:'未读'},
];
const tasks=[{id:'t1',t:'核对本周消费账单',date:'今天',src:'滴答清单 · 生活',note:'先核对同一账户的账单；退款与转账单独处理。'},{id:'t2',t:'为实机验证准备小样本',date:'今天',src:'Craft · Hub 项目',note:'选择两条有明确出处的示例记录，记录预期与实际。'},{id:'t3',t:'整理最近收藏的阅读材料',date:'明天',src:'滴答清单 · 收件箱',note:'先处理 3 条，再决定是否继续。'},{id:'t4',t:'核对纸面原型',date:'昨天',src:'Craft · Hub 项目',note:'纸面核对完成；实机验收另行安排。',done:true}];
const cards=[{id:'c1',deck:'复盘方法',q:'为什么同一份回顾要区分记录时间和事件时间？',a:'补录日期可能晚于事件发生日。使用事件时间归入正确窗口，保留记录时间用来解释何时补录。',doc:'d4'},{id:'c2',deck:'复盘方法',q:'什么条件下可以比较两期消费？',a:'来源、账户、币种、去重与时间窗口一致，且能明确两期覆盖。未知不能记作零。',doc:'d4'},{id:'c3',deck:'阅读方法',q:'让阅读摘录能在下次被用上的最小动作是什么？',a:'写下一句它和当前问题的关系，把摘录与可应用的场景一起保存。',doc:'d3'}];
const findings={
 f1:{t:'加班日的运动和作息，值得一起回看',desc:'两条日志都写到取消跑步、看剧和晚睡。',kind:'候选解释',icon:'spark',color:'purple',docs:['d1','d2'],body:'两条日志里，加班、取消夜跑和午夜后睡觉一起出现。可以核对：加班日是否需要更容易执行的休息安排？',limit:'只有两条记录；共同出现不能证明原因，也不能代表每个加班日。'},
 f2:{t:'本月已记录支出比同期多 ¥200',desc:'差额来自医疗净支出，按同一账户比较。',kind:'直接观察',icon:'money',color:'warm',docs:['d4'],body:'样本内本月净支出 ¥700，去年同期 ¥500，相差 ¥200（40%）。差额来自 ¥300 就诊支出扣除 ¥100 退款。',limit:'两期仅覆盖 11 月 1–9 日的同一示例账户。未纳入其他账户或现金支出。'},
 f3:{t:'纸面原型已核对，实机验证未开始',desc:'项目回顾将两项进展分开记录。',kind:'直接观察',icon:'task',color:'green',docs:['d5'],body:'原文只确认纸面原型核对。实机验证仍未开始，不能把两者合并成“已验收”。',limit:'依据为项目周回顾，不代表额外的执行回执。'},
 f4:{t:'摘录开始连接到当前问题',desc:'阅读笔记补上了下次使用的场景。',kind:'直接观察',icon:'book',color:'',docs:['d3'],body:'这篇笔记在摘录之外记下了一个可重复使用的办法：保存与当前问题的关系，方便下次找回上下文。',limit:'仅根据当前一篇阅读笔记，不能外推到全部阅读习惯。'}
};
const status=(id)=>st.find[id]?.until&&Date.now()>=st.find[id].until?'待关注':st.find[id]?.status||(id==='f4'?'已处理':'待关注');
if(!st.find.f3)st.find.f3={status:'稍后',until:new Date().setHours(24,0,0,0)};
const pending=(id)=>Boolean(st.feedback[id]?.some(f=>!f.resolved)||(id==='f2'&&st.sourceChanged));
const btn=(t,a,c='',i='')=>'<button type="button" class="btn '+c+'" data-act="'+a+'">'+(i?ico(i,17):'')+esc(t)+'</button>';
const plain=(t,a,i='')=>'<button type="button" class="plain" data-act="'+a+'">'+(i?ico(i,17):'')+esc(t)+'</button>';
const chip=(t,a,on)=>'<button class="chip" type="button" data-act="'+a+'" aria-pressed="'+!!on+'">'+esc(t)+'</button>';
const iconBtn=(t,a,i)=>'<button type="button" class="icon-btn" aria-label="'+esc(t)+'" title="'+esc(t)+'" data-act="'+a+'">'+ico(i)+'</button>';
const tag=(t,c='')=>'<span class="tag '+c+'">'+esc(t)+'</span>';
const row=(t,d,i,a,c='',end='')=>'<button type="button" class="row" data-act="'+a+'"><span class="tile '+c+'">'+ico(i,18)+'</span><span class="copy"><strong>'+esc(t)+'</strong>'+(d?'<small>'+esc(d)+'</small>':'')+'</span>'+(end||'<span class="tail">'+ico('chev',16)+'</span>')+'</button>';
const section=(t,body,action='')=>'<section class="section"><div class="section-head"><h2>'+esc(t)+'</h2>'+action+'</div>'+body+'</section>';
const group=(content,empty='暂无项目。')=>'<div class="group">'+(content||'<p class="empty">'+esc(empty)+'</p>')+'</div>';
const intro=(t,d)=>t===routes[route()[0]]&&!['doc','note','article','task','finding','work','deck','study','widgets'].includes(route()[0])?'':'<h1>'+esc(t)+'</h1><p class="lede">'+esc(d)+'</p>';
const detail=(t,badge,body)=>'<article class="detail">'+badge+'<h1>'+esc(t)+'</h1>'+body+'</article>';
const sourceRow=(id)=>row(docs[id].t,docs[id].s+' · '+docs[id].tag,'note','go:doc/'+id);
const routes={future:'后续功能',deck:'牌组', 'collab-sync':'协作同步演示',search:'搜索',browse:'浏览',tasks:'任务',review:'复习',insights:'洞察',reading:'阅读',favorites:'收藏',recent:'最近浏览',logs:'日志',tags:'标签',libraries:'资料库',settings:'设置',sync:'同步状态',agent:'助手',agents:'助手','agent-chat':'助手对话','agent-connection':'云端连接',requests:'更新请求',request:'请求详情',guide:'功能梳理',doc:'资料详情',article:'阅读详情',task:'任务详情',finding:'发现详情','journal-search':'搜索日志','journal-select':'选择笔记','journal-edit':'编辑日志','journal-record':'日志详情',capture:'快速记录',recap:'阶段回顾',works:'工作与专题',work:'工作详情',saved:'日志',label:'标签详情',study:'牌组复习',appearance:'外观与阅读'};
const parent={future:'settings',deck:'review','collab-sync':'future',reading:'browse',favorites:'browse',recent:'browse',logs:'browse',tags:'browse',libraries:'browse',settings:'browse',sync:'browse',agent:'browse',agents:'browse','agent-chat':'agents','agent-connection':'agents',requests:'insights',request:'insights',guide:'browse',doc:'browse',article:'browse',task:'tasks',finding:'insights',recap:'insights','journal-search':'logs','journal-select':'logs','journal-edit':'logs','journal-record':'logs',capture:'browse',works:'browse',work:'browse',saved:'browse',label:'browse',study:'review',appearance:'browse'};
Object.assign(routes,{connections:'连接总览',note:'本地笔记',card:'闪卡详情',widgets:'小组件预览'});
Object.assign(parent,{insights:'browse',connections:'browse',note:'browse',card:'review',agent:'agents',widgets:'settings'});
let activeRoute='', scrolls={}, sheets=new Map(), sheetSerial=0;
const tabFor=p=>{let cursor=p;for(let i=0;i<5;i++){if(navs.some(x=>x[0]===cursor))return cursor;cursor=parent[cursor]}return 'browse'};
history.scrollRestoration='manual';
if(!Number.isInteger(history.state?.hubDepth))history.replaceState({hubDepth:0},'');
const route=()=>{const h=location.hash.slice(1);const [p,id]=h.split('/');return routes[p]?[p,id]:['search','']};
function go(to){
 const next=to.split('/')[0], state=history.state||{};
 if(typeof journalEditorSession !== 'undefined' && journalEditorSession && route()[0]==='journal-edit' && to!=='journal-edit/'+journalEditorSession.id && !state.sheet){if(!journalCommitEdit(journalEditorSession.id))return;journalEditorSession=null;}
 if(!routes[next]||mobileClosingSheet)return;
 if(location.hash==='#'+to&&!state.sheet)return;
 if(route()[0]==='search'&&query&&workspaceIndex().some(item=>item.route===to))workspaceRememberQuery();
 scrolls[activeRoute]=pageScroll();
 const tab=navs.some(x=>x[0]===next)?next:state.tab||tabFor(route()[0]);
 const ns={hubDepth:(state.hubDepth||0)+(state.sheet?0:1),tab,from:route().filter(Boolean).join('/')};
 if(state.sheet){snapshotMobileSheet();dismissMobileSheet();history.replaceState(ns,'','#'+to)}else history.pushState(ns,'','#'+to);
 render(true);mobileRememberView();
}
function back(){if(mobileClosingSheet)return;if(history.state?.sheet){close();return}if(history.state?.hubDepth>0){history.back();return}const to=parent[route()[0]]||'search';history.replaceState({hubDepth:0,tab:to},'','#'+to);render(true)}

function findData(id){const f=findings[id];return id==='f2'&&st.revised?{...f,t:'本月已记录支出比同期多 ¥350',body:'采纳补录后的样本：本月净支出 ¥850，去年同期 ¥500，相差 ¥350（70%）。差额来自医疗净支出。'}:f}
function findRow(id){const f=findData(id);return '<button class="row finding" type="button" data-act="go:finding/'+id+'"><span class="tile '+f.color+'">'+ico(f.icon,18)+'</span><span class="copy"><span class="meta">'+tag(pending(id)?'待复核':f.kind,pending(id)?'warn':f.kind==='直接观察'?'blue':'')+'<span class="fine">'+f.docs.length+' 条依据</span></span><strong>'+esc(f.t)+'</strong><small>'+esc(f.desc)+'</small></span><span class="tail">'+ico('chev',16)+'</span></button>'}
function hero(t,desc,label,act,more=''){return '<div class="hero"><svg class="pattern" width="130" height="115" viewBox="0 0 130 115" fill="none" aria-hidden="true"><g stroke="#8fa9cf" stroke-width="1.35"><path d="M53 26h40l10 10v46H53zM93 26v12h10M62 47h31M62 56h31M62 65h21"/><path d="M43 42H33v51h43v-7M108 47h9v47H87v-7" opacity=".47"/></g></svg><h2>'+esc(t)+'</h2><p>'+esc(desc)+'</p><div class="hero-actions">'+btn(label,act)+more+'</div></div>'}
const match=(value,q)=>value.toLowerCase().includes(q.toLowerCase());
function marked(text,q){const i=q?text.toLowerCase().indexOf(q.toLowerCase()):-1;return i<0?esc(text):esc(text.slice(0,i))+'<mark>'+esc(text.slice(i,i+q.length))+'</mark>'+esc(text.slice(i+q.length))}
function searchInput(id,label,value=''){return '<div class="field"><label for="'+id+'">'+esc(label)+'</label><input type="search" id="'+id+'" value="'+esc(value)+'" placeholder="'+esc(label)+'"></div>'}
function searchPage(){return workspaceSearchPage()}
function searchResults(){return workspaceSearchResults()}
function refreshSearch(){const results=$('#results');if(results)results.innerHTML=searchResults();const clear=$('.search-clear');if(clear)clear.hidden=!query;const cancel=$('.search-cancel');if(cancel)cancel.hidden=!workspaceSearchActive;mobileRememberView()}

function selectField(id,label,items,current){return '<div class="field"><label for="'+id+'">'+esc(label)+'</label><select id="'+id+'">'+items.map(x=>'<option '+(x===current?'selected':'')+'>'+esc(x)+'</option>').join('')+'</select></div>'}

const owners={f1:'w1',f2:'w1',f3:'w2',f4:'w3'};
const workTitles={w1:'11 月阶段回顾',w2:'原型验证',w3:'阅读方法整理'};
const stamps=t=>t?new Date(t).toLocaleString('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}):'11 月 9 日 09:00（示例）';
const stages={queued:'待同步',waiting:'等待桌面上线',ready:'等待桌面处理',running:'桌面处理中',published:'桌面已完成 · 待接收',received:'新结果 · 待确认',applied:'已确认',cancelled:'已撤销',cancelPending:'撤销待同步'};
const jobStatus=j=>j.stage==='ready'&&!st.desktopOnline?stages.waiting:stages[j.stage];
const activeJob=id=>[...st.jobs].reverse().find(j=>j.target===id&&!['applied','cancelled'].includes(j.stage));
const jobHint=j=>({queued:'手机已保存请求，尚未送达桌面。',waiting:'请求已同步；桌面上线后才能开始。',ready:'桌面尚未开始执行。',running:'桌面已接收请求。手机仍可查看旧结果。',published:'桌面已有结果，等待手机同步。',received:'可对照证据与变化，再确认是否采用。',applied:'历史版本与反馈继续保留。',cancelled:'这条请求不会进入桌面处理。',cancelPending:'已保存撤销操作，下一次同步后生效。'}[j.stage]);
function requestRow(j){return row((workTitles[j.work]||'桌面工作')+' · '+jobStatus(j),j.text||jobHint(j),'sync','go:request/'+j.id,j.stage==='received'?'green':'')}
function syncSummary(){return group(row(st.desktopOnline?'桌面在线':'桌面离线','上次手机同步：'+(st.lastSync?stamps(st.lastSync):'尚未同步')+(st.offline?' · 手机离线':st.syncError?' · 同步失败':''),'sync','go:collab-sync',st.desktopOnline?'green':'warm'))}
function finding(id){const f=findData(id);if(!f)return missing();const j=activeJob(id);
 const fb=st.feedback[id]||[], action=st.actions.filter(a=>a.id===id).at(-1);
 return detail(f.t,tag(f.kind,f.kind==='直接观察'?'blue':'')+' '+tag(status(id))+(pending(id)?' '+tag('待复核','warn'):''),
 '<p class="lede">桌面发布 · '+esc(id==='f2'&&st.revised?'版本 2':'版本 1')+' · '+esc(stamps(id==='f2'?st.revisedAt:null))+'</p><p class="prose">'+esc(f.body)+'</p><p class="info">'+esc(f.limit)+'</p>'+
 (status(id)==='稍后'&&st.find[id]?.until?'<p class="info">稍后至 '+esc(new Date(st.find[id].until).toLocaleDateString('zh-CN'))+'，不发送提醒。</p>':'')+
 (pending(id)?'<p class="info warning">'+(id==='f2'&&st.sourceChanged?'桌面有补录账目待核对，当前仍显示上次结论。':'已有补充待复核。补充不直接改变结论。')+'</p>':'')+
 section('依据',group(f.docs.map(sourceRow).join('')))+
 findingTaskAction(id)+'<div class="actions finding-secondary">'+btn(status(id)==='已处理'?'恢复待关注':'标记已处理','status:'+id+':'+(status(id)==='已处理'?'待关注':'已处理'),'outline')+
 btn(status(id)==='稍后'?'恢复关注':'稍后','later:'+id,'outline','clock')+btn('补充或纠正','correct:'+id,'outline')+'</div>'+
 (action?'<p class="fine">处理状态'+(action.sent?'已完成示例同步':'已保存到手机 · 待同步')+'</p>':'')+
 (j?section('更新进度',group(requestRow(j))):'<div class="actions">'+btn('请求桌面更新','request:'+id,'secondary','sync')+'</div>')+
 (fb.length?section('反馈记录',fb.map(x=>'<blockquote class="quote"><div class="fine">'+esc((x.sent?'已同步 · 待桌面复核':'待同步')+(x.resolved?' · 已核对':'')+' · '+stamps(x.at))+'</div><p>'+esc(x.text)+'</p></blockquote>').join('')):'')+
 (id==='f2'&&st.revised?section('结论版本','<details class="quote"><summary>版本 1 · 11 月 9 日 09:00</summary><p>'+esc(findings.f2.body)+'</p></details><details class="quote"><summary>版本 2 · '+esc(stamps(st.revisedAt))+'</summary><p>更新原因：桌面核对补录的就诊支出 ¥150。</p><p>'+esc(f.body)+'</p></details>'):'')+
 '<div class="actions">'+plain('与助手继续聊','ask-finding:'+id,'chat')+plain('查看原工作：'+workTitles[owners[id]],'go:work/'+owners[id],'folder')+'</div>')}
const scopeLabels={log:'生活日志',ledger:'同一账户的账目',read:'完读记录'};
function recap(){
 const j=activeJob('recap');
 let result='';
 if(compare==='open')result=section('桌面发现的候选联系',group(findRow('f1')))+'<p class="info">联系来自两条生活日志，属于待核对线索。主题可留空。</p>';
 else{
  if(compare==='year')result=section('与去年同期比较',group(findRow('f2')))+'<p class="info">两期对齐 11 月 1–9 日；阅读、影视和健康缺少去年同口径记录，仅显示本月观察。</p>';
  result+=section(compare==='year'?'本月其他记录':'本月已记录内容',group(
   (compare==='month'?row('本月已记录净支出 ¥'+(st.revised?'850':'700'),st.sourceChanged?'待核对补录；金额为上次快照':'所选账户 · 11 月 1–9 日','money','go:doc/d4','warm'):'')+
   row('看了 3 集《漫长的季节》','两条日志明确记录了实际观看','book','go:logs')+
   row('完读《把时间当作朋友》','1 条完读记录；收藏不计入','book','go:doc/d6')+
   row('记录了散步与取消夜跑','活动记录不能据此判断健康变化','calendar','go:logs','green')));
  result+=section('额外发现',group(findRow('f1')));
 }
 return intro('阶段回顾','查看桌面已发布的结果。切换视角只改变查看内容。')+
 '<p class="info">桌面发布 · 资料覆盖 11 月 1–9 日 · 最近确认 '+esc(stamps(st.revisedAt))+'</p>'+
 '<div class="filter section">'+[['month','本月回顾'],['year','对比去年同期'],['open','开放探索']].map(([k,t])=>chip(t,'mode:'+k,compare===k)).join('')+'</div>'+
 (j?group(requestRow(j)):btn('请求桌面更新','request:recap','wide','sync'))+result;
}
function requestSheet(target){
 const existing=activeJob(target);if(existing){go('request/'+existing.id);return}
 const isRecap=target==='recap', isQuestion=target==='question', needsScope=isRecap||isQuestion;
 const draft=st.drafts[target]||{};
 const selected=draft.scopes||(isRecap?Object.keys(scopeLabels):[]);
 const attached=draft.doc||agentDoc;
 const work=owners[target]||(isQuestion?(attached==='d5'||attached==='d7'?'w2':attached==='d3'?'w3':'w1'):'w1');
 sheet(isQuestion?'提交给桌面':'请求桌面更新','<form id="request-form" data-target="'+target+'" data-work="'+work+'">'+
 '<p class="lede">将提交到「'+workTitles[work]+'」。'+(st.desktopOnline?'桌面接收后才开始。':'桌面当前离线，请求可先保存。')+'</p>'+
 (isRecap?selectField('request-mode','回顾视角',['本月回顾','对比去年同期','开放探索'],draft.mode||({month:'本月回顾',year:'对比去年同期',open:'开放探索'}[compare])):'')+
 (needsScope?'<fieldset><legend>本次允许使用的示例资料</legend>'+Object.entries(scopeLabels).map(([k,t])=>'<label class="choice"><input type="checkbox" name="scope" value="'+k+'" '+(selected.includes(k)?'checked':'')+'>'+t+'</label>').join('')+(isQuestion&&(draft.doc||agentDoc)?'<p class="fine">已附上：'+esc(docs[draft.doc||agentDoc]?.t||'本地快速记录')+'</p>':'')+'</fieldset>':'<p class="info">沿用此发现的原工作及已选依据。</p>')+
 (isRecap?'<fieldset><legend>关注主题（可留空）</legend>'+['消费','健康','阅读','影视娱乐'].map(t=>'<label class="choice"><input type="checkbox" name="topic" value="'+t+'" '+((draft.topics||[]).includes(t)?'checked':'')+'>'+t+'</label>').join('')+'</fieldset>':'')+
 '<div class="field"><label for="request-text">'+(isQuestion?'你的问题':'要核对的内容（可选）')+'</label><textarea id="request-text" maxlength="1200" '+(isQuestion?'required':'')+'>'+esc(draft.text||'')+'</textarea></div>'+
 (needsScope?'<label class="choice"><input type="checkbox" id="only-question" '+(draft.only?'checked':'')+'>只回答当前问题或所选主题</label>':'')+
 '<p id="request-error" class="fine" role="alert"></p><button class="btn wide">保存请求</button></form>');
}
function readRequest(f){return {text:$('#request-text').value,mode:$('#request-mode')?.value,doc:f.dataset.target==='question'?(st.drafts.question?.doc||agentDoc):'',scopes:[...f.querySelectorAll('[name=scope]:checked')].map(x=>x.value),topics:[...f.querySelectorAll('[name=topic]:checked')].map(x=>x.value),only:$('#only-question')?.checked||false}}
function submitRequest(f){
 const target=f.dataset.target,v=readRequest(f);
 if(target==='recap'&&!v.scopes.length){$('#request-error').textContent='请先选择至少一组资料。';return}
 if(target==='question'&&!v.text.trim()){$('#request-error').textContent='请先输入问题。';return}
 if(activeJob(target))return;
 const j={...v,id:'q'+crypto.randomUUID(),target,work:f.dataset.work,stage:'queued',at:Date.now()};
 const priorDraft=st.drafts[target];st.jobs.push(j);delete st.drafts[target];if(!save()){st.jobs.pop();st.drafts[target]=priorDraft||v;$('#request-error').textContent='暂时无法保存请求，输入已保留，请重试。';return}if(target==='question')agentDoc='';go('request/'+j.id);tell('请求已保存在此浏览器，等待示例同步');
}
function requestDetail(id){
 const j=st.jobs.find(x=>x.id===id);if(!j)return missing();
 const accept=j.stage==='received', hasChange=j.change&&!st.revised, already=j.stage==='applied';
 return detail(workTitles[j.work],tag(jobStatus(j),accept||already?'green':j.stage==='waiting'?'warn':'blue'),
 '<p class="lede">手机提交 · '+esc(stamps(j.at))+'</p><p class="info">'+esc(jobHint(j))+'</p>'+
 (j.mode||j.scopes.length||j.doc?section('本次范围','<p class="fine">'+esc([j.mode,...j.scopes.map(k=>scopeLabels[k]),...j.topics.map(t=>'关注：'+t),j.doc?(docs[j.doc]?.t||'本地快速记录'):'',j.only?'仅回答当前范围':'允许额外发现'].filter(Boolean).join(' · '))+'</p>'):'')+
 (j.text?section('提交的问题','<blockquote class="quote"><p>'+esc(j.text)+'</p></blockquote>'):'')+
 (accept||already?section('桌面结果',j.change?'<p class="prose">账目核对：原净支出 ¥700，补录就诊 ¥150 后为 ¥850；去年同期仍为 ¥500。</p>'+group(sourceRow('d4')):'<p class="prose">本次演示没有可替换的结论，保留当前成果与反馈。</p>')+'<p class="fine">演示结果；没有调用模型分析输入。</p>':'')+
 '<div class="actions">'+(accept?btn(hasChange?'确认采用版本 2':'确认已查看','apply-job:'+id):'')+
 (['queued','waiting','ready'].includes(j.stage)?btn('撤销请求','cancel-job:'+id,'outline'):'')+
 (!['applied','cancelled','received'].includes(j.stage)?btn('查看同步与桌面状态','go:collab-sync','outline','sync'):'')+plain('打开原工作','go:work/'+j.work,'chat')+'</div>');
}
function applyJob(id){const j=st.jobs.find(x=>x.id===id&&x.stage==='received');if(!j)return;
 if(j.change&&!st.revised){st.revised=true;st.revisedAt=j.finishedAt;st.sourceChanged=false}
 j.stage='applied';changed(j.change?'已确认版本 2，处理状态与反馈保留':'已确认查看，原结论保留')
}
function syncNow(){
 if(st.offline||!st.cloudEnabled||st.syncError){tell(st.offline?'手机离线，保留待同步操作。':!st.cloudEnabled?'请先开启本设备洞察同步。':'同步未成功；操作保留，可重试。');return}
 for(const j of st.jobs){if(j.stage==='queued')j.stage=st.desktopOnline?'ready':'waiting';else if(j.stage==='published')j.stage='received';else if(j.stage==='cancelPending')j.stage='cancelled'}
 for(const list of Object.values(st.feedback))for(const f of list)f.sent=true;
 for(const a of st.actions)a.sent=true;
 st.lastSync=Date.now();changed('已完成本轮示例同步')
}
function desktopStep(id){
 if(!st.desktopOnline){tell('桌面离线，不能开始或完成处理。');return}
 const j=st.jobs.find(x=>x.id===id);if(!j)return;
 if(['ready','waiting'].includes(j.stage)){j.stage='running';changed('桌面开始处理示例请求');return}
 if(j.stage==='running'){
  j.stage='published';j.finishedAt=Date.now();
  j.change=Boolean(!st.revised&&st.sourceChanged&&(j.target==='f2'||(j.target==='recap'&&j.scopes.includes('ledger')&&(!j.topics.length||j.topics.includes('消费')))));
  changed('桌面结果已发布，等待手机同步')
 }
}
function syncPage(){
 const jobs=st.jobs.filter(j=>['ready','waiting','running'].includes(j.stage));
 const pendingCount=st.jobs.filter(j=>['queued','published','cancelPending'].includes(j.stage)).length+Object.values(st.feedback).flat().filter(f=>!f.sent).length+st.actions.filter(a=>!a.sent).length;
 return intro('同步与离线','查看阅读、闪卡与洞察桌面更新的演示状态。')+
 section('助手云端对话',group(row('连接与设备','VPS 执行、订阅登录与断线恢复','cloud','go:agent-connection')))+
 section('桌面同步演示',group(
  row(st.offline?'同步网络离线':'同步网络在线','仅切换本页桌面同步情景；已发布缓存仍可读','sync','offline',st.offline?'warm':'green')+
  row(st.desktopOnline?'桌面在线':'桌面离线','切换示例桌面连接','sync','desktop-online',st.desktopOnline?'green':'warm')+
  row('同步设置','洞察'+(st.cloudEnabled?'开启':'暂停')+' · 阅读'+(st.readingSync?'开启':'暂停')+' · 闪卡'+(st.reviewSync?'开启':'暂停'),'settings','sync-settings')+
  row('本地缓存',Object.values(st.cache).filter(Boolean).length+' 篇阅读已标记离线 · 已发布洞察可查看','folder','go:reading')))+
 section('本次同步','<p class="fine">待传输 '+pendingCount+' 项 · 最近成功：'+(st.lastSync?esc(stamps(st.lastSync)):'尚未同步')+'</p>'+
  (st.syncError?'<p class="info warning">示例同步失败。待传输操作已保留。</p>':'')+
  '<div class="actions">'+btn(st.syncError?'重试同步':'同步一次','refresh-sync','','sync')+plain('请求记录','go:requests','clock')+'</div>')+
 section('桌面演示控制','<p class="fine">这些操作仅推进示例进度，不连接真实电脑或 AI。</p>'+
 '<div class="actions">'+(!st.sourceChanged&&!st.revised?btn('模拟补录账目','source-change','outline','plus'):'')+btn(st.syncError?'恢复同步连接':'模拟同步失败','sync-error','outline')+'</div>'+
 jobs.map(j=>'<div class="quote"><p>'+esc(workTitles[j.work]+' · '+jobStatus(j))+'</p><div class="actions">'+
  (st.desktopOnline?btn(j.stage==='running'?'模拟桌面完成':'模拟桌面开始','desktop-step:'+j.id,'secondary'):'<span class="fine">'+(j.stage==='running'?'桌面离线，处理暂未完成':'等待桌面上线')+'</span>')+'</div></div>').join(''));
}

const missing=()=>intro('找不到该项目','返回列表，选择一条有效的示例记录。');
function notesPage(){return journalPage()}
function readerBody(text,highlight=''){return text.split(/\n\s*\n/).map(paragraph=>'<p>'+marked(paragraph,highlight)+'</p>').join('')}
function docPage(id,localOnly=false){const local=localOnly||!docs[id]?st.notes.find(n=>n.id===id):null;const localDoc=local?{t:local.title||'快速记录',s:'本地记录',date:local.date,tag:local.kind==='link'?'链接':'随手记录',body:local.text||''}:null;const d=localOnly?localDoc:docs[id]||localDoc;if(!d)return missing();
 const starKey=local?'note/'+id:id,starred=st.stars[starKey]??(local&&!docs[id]?st.stars[id]:undefined)??(!local&&id==='d3');const related=local?[]:Object.keys(findings).filter(k=>findings[k].docs.includes(id));const body=d.body+(!local&&id==='d4'&&(st.sourceChanged||st.revised)?'\n\n补录记录：11 月 9 日就诊 ¥150，更新后示例净支出 ¥850。':'');
 return '<article class="reader"><p class="eyebrow">'+esc(d.s)+' · '+esc(d.tag)+'</p><h1>'+esc(d.t)+'</h1><div class="reader-meta"><span>'+esc(d.date)+'</span><span>'+(d.type?esc(d.type)+' · 文字摘录':'约 1 分钟阅读')+'</span></div><div class="reader-body">'+(local?.kind==='note'?captureNoteBody(body):readerBody(body,history.state?.tab==='search'?query.split(/\s+/).find(q=>q&&match(d.body,q)):''))+((local?.photos||local?.attachments)?'<div class="saved-capture-photos">'+attachmentMarkup(local)+'</div><div class="journal-file-links">'+recordAttachments(local).map(a=>plain('保存 '+a.name,'download-attachment:'+a.id,'note')).join('')+'</div>':'')+'</div>'+(local?.url?'<div class="actions">'+btn('查看链接出处','doc-source:'+id,'outline','link')+'</div>':'')+'<div class="reader-toolbar">'+plain(starred?'已收藏':'收藏','star:'+starKey,'star')+plain('带着资料提问','ask:'+id,'chat')+'</div>'+(related.length?section('由此发现',group(related.map(k=>row(findData(k).t,findData(k).kind+' · '+findData(k).docs.length+' 条依据','spark','go:finding/'+k,'purple')).join(''))):'')+'</article>'
}

const rstatus=(x)=>st.reading[x.id]||x.status;
function readingMatches(){return reading.filter(x=>(readingFilter==='全部'||rstatus(x)===readingFilter)&&(readingSource==='全部来源'||x.src===readingSource)&&(readingView!=='继续阅读'||rstatus(x)==='阅读中')&&(readingView!=='离线内容'||st.cache[x.id])&&match(x.t+' '+x.blurb+' '+x.src,readingQuery))}
function readingRows(){const items=readingMatches();return '<p class="reading-count" role="status">'+items.length+' 篇 · 示例内容</p>'+group(items.map(r=>'<button type="button" class="row reading-result" data-act="go:article/'+r.id+'"><span class="copy"><strong>'+esc(r.t)+'</strong><span class="reading-excerpt">'+esc(r.blurb)+'</span><small>'+esc(r.src+' · '+rstatus(r)+(st.cache[r.id]?' · 离线标记（示例）':''))+'</small></span><span class="tail">'+ico('chev',16)+'</span></button>').join(''),'没有符合条件的文章。可以更换关键词，或在筛选中放宽条件。')}
function readingPage(){const limited=readingSource!=='全部来源'||readingView!=='全部内容';return '<div class="reading-workspace"><div class="reading-search">'+searchInput('reading-query','搜索阅读',readingQuery)+iconBtn('筛选阅读'+(limited?'，有已选条件':''),'read-source','tune')+'</div><div class="filter reading-status" aria-label="阅读状态">'+['全部','未读','阅读中','已读'].map(t=>chip(t,'readfilter:'+t,readingFilter===t)).join('')+'</div><div class="reading-conditions" aria-label="已选阅读条件">'+(readingSource!=='全部来源'?plain(readingSource+' ×','read-clear:source'):'')+(readingView!=='全部内容'?plain(readingView+' ×','read-clear:view'):'')+'</div><div id="reading-results">'+readingRows()+'</div></div>'}
function readingFilterSheet(){sheet('筛选阅读','<form id="reading-filter-form">'+selectField('reading-source','来源',['全部来源',...new Set(reading.map(x=>x.src))],readingSource)+selectField('reading-view','内容范围',['全部内容','继续阅读','离线内容'],readingView)+'<p class="fine">“继续阅读”只看阅读中的文章；离线标记仅供本原型演示。</p><div class="actions">'+btn('重置','read-reset','outline')+'<button class="btn" type="submit">应用筛选</button></div></form>')}
function article(id){
 const r=reading.find(x=>x.id===id);if(!r)return missing();const starred=Boolean(st.stars['article/'+id]);
 return '<article class="reader"><p class="eyebrow">'+esc(r.src)+'</p><h1>'+esc(r.t)+'</h1><div class="reader-meta"><span>'+esc(rstatus(r))+'</span><span>'+(st.cache[id]?'已加入离线示例':'示例正文')+'</span></div><p class="reader-intro">'+esc(r.blurb)+'</p><div class="reader-body">'+readerBody(r.body)+'</div><div class="reader-toolbar">'+plain(starred?'已收藏':'收藏','star:article/'+id,'star')+plain('原文出处','reading-original:'+id,'link')+plain('更多','reading-manage:'+id,'settings')+'</div><div class="actions workspace-reading-actions">'+btn('记下想法','workspace-note:reading:'+id,'secondary','note')+btn('带进助手','workspace-agent:reading:'+id,'outline','chat')+plain('转成任务','workspace-task:reading:'+id,'task')+'</div><div class="actions">'+btn(rstatus(r)==='已读'?'恢复未读':'标记已读','read:'+id+':'+(rstatus(r)==='已读'?'未读':'已读'),'','check')+btn('稍后接着读','read:'+id+':阅读中','outline')+'</div></article>';
}

function articleRow(id){const r=reading.find(x=>x.id===id);return r?row(r.t,r.src+' · '+rstatus(r),'book','go:article/'+id,'purple'):''}
function itemRow(k){if(k.startsWith('article/'))return articleRow(k.split('/')[1]);if(!k.startsWith('note/')&&docs[k])return sourceRow(k);const id=k.startsWith('note/')?k.slice(5):k,n=st.notes.find(x=>x.id===id);return n?row(n.title||n.text.slice(0,45),'本地记录','note','go:note/'+id):''}
function favoriteRows(){const items=[...Object.entries(docs).map(([id,d])=>({key:id,title:d.t,star:st.stars[id]??id==='d3'})),...reading.map(r=>({key:'article/'+r.id,title:r.t,star:st.stars['article/'+r.id]})),...st.notes.map(n=>({key:'note/'+n.id,title:n.title||n.text||'',star:st.stars['note/'+n.id]??(!docs[n.id]?st.stars[n.id]:false)}))];return group(items.filter(item=>item.star&&match(item.title,starQuery)).map(item=>itemRow(item.key)).join(''),'没有符合条件的收藏。')}
const labels=['生活日志','阅读笔记','账目','项目'];
function tagRows(){return mobileTagRows()}

const done=(t)=>st.tasks[t.id]??!!t.done;
function review(){return mobileReviewPage()}

function study(){const deck=st.studyDeck,list=allReviewCards().filter(c=>deck==='全部'||c.deck===deck),todo=list.filter(c=>!st.reviewed.includes(c.id)),card=todo[cardIndex%todo.length];if(!list.length)return missing();
 if(!todo.length)return intro('复习完成',deck+' · 已完成 '+list.length+' 张')+section('本次记录',group(list.map(c=>row(c.q,st.grades[c.id]||'已复习','check','go:doc/'+c.doc,'green')).join('')))+'<div class="actions">'+btn('返回复习首页','go:review')+'</div>';
 const choices=card.id==='c3'&&!face?'<div class="actions">'+btn('写一句与问题的关系','flip','outline')+btn('只收藏链接','wrong-choice','outline')+'</div>':'';
 return '<div class="study-context"><span>'+esc(card.deck)+' · 还剩 '+todo.length+' 张</span>'+plain('编辑','edit-card:'+card.id)+'</div><section class="study-content" aria-label="'+(face?'答案':'问题')+'"><p class="study-face">'+(face?'答案':'问题')+'</p><div class="review-card review-focus-card"><p>'+esc(face?card.a:card.q)+'</p></div></section>'+
 (face?'<div class="study-source">'+plain('查看来源','go:doc/'+card.doc,'link')+'</div><div class="study-actions"><div class="ratings">'+[['重来','1 分钟'],['困难','10 分钟'],['记得','1 天'],['轻松','4 天']].map(([t,delay],i)=>'<button class="btn outline grade-'+i+'" data-act="grade:'+card.id+':'+t+'"><span>'+t+'</span><small>'+delay+'</small></button>').join('')+'</div><p class="fine">间隔为演示 · “重来”留在本轮</p></div>':'<div class="study-actions">'+(choices||'<div class="actions">'+btn('显示答案','flip','wide')+'</div>')+'</div>')}

let agentDoc='';
function works(){return intro('工作与专题','查看桌面成果及其对应的原工作。')+
 section('工作',group(Object.entries(workTitles).map(([k,t])=>row(t,Object.keys(owners).filter(id=>owners[id]===k).length+' 条已发布发现','chat','go:work/'+k)).join('')))+
 section('专题',group(row('生活回顾','手动查看已发布回顾','calendar','go:work/topic','green')))}
function work(id){
 if(id==='topic')return detail('生活回顾',tag('手动回顾','blue'),'<p class="prose">按选定范围查看桌面发布的本月结果。</p><div class="actions">'+btn('打开阶段回顾','go:recap')+'</div>');
 if(!workTitles[id])return missing();
 return detail(workTitles[id],tag('桌面已发布','green'),section('关联发现',group(Object.keys(owners).filter(k=>owners[k]===id).map(findRow).join('')))+
 section('更新请求',group(st.jobs.filter(j=>j.work===id).slice().reverse().map(requestRow).join(''),'该工作暂时没有更新请求。'))+
 (id==='w2'?'<p class="info">纸面核对已完成，实机记录仍待补。</p>':''))
}

const guideRows=[
 ['搜索与资料库','原型：笔记、日志、任务、阅读、对话、洞察和闪卡统一检索。','可多选资料库、空间分组，按类型、日期筛选；仅搜索示例与本机内容，不读取真实账号。'],
 ['阅读、收藏、最近浏览','现有：多来源阅读及状态、收藏与访问历史。','手机：单页接着读、快速更新状态。桌面：看板、表格、附件与批量归档。'],
 ['日志与标签','现有：按日期浏览日志、按标签定位资料。','手机：按天浏览、快速记录。支持文字、照片与文件草稿；上传和电脑写入在原型中显式演示，语音转写留待后续。'],
 ['任务','原型：创建、编辑、日期、优先级、筛选与完成撤销。','阅读、资料、洞察和 Agent 回答可以转任务并保留来源；都是本地演示，不写回 Craft / 滴答。'],
 ['闪卡','现有：牌组与移动复习。','手机：翻卡和评分；桌面：编辑牌组、质量检查和批量导入。'],
 ['助手云端会话','主仓方案 #32：Android 连接个人 VPS 与 Codex app-server，已有基础接入。','此站只演示会话、材料、重命名、归档、停止与恢复，不连接 VPS、不调用模型。此站新增材料与成果操作不代表真实 Android / 服务已具备。'],
 ['洞察与阶段回顾','原型：浏览中直达洞察，搜索首页有轻量提醒。','查看依据、补充纠正、安排下一步；桌面更新与阶段回顾仍为历史演示，不在手机运行真实分析。'],
 ['同步与设置','现有：资料库和同步诊断。','手机：查看缓存、恢复连接、选择同步范围和重试；备份恢复与批量维护在桌面完成。']
];
function guide(){return intro('功能梳理','手机优先做短、频繁、可中断的操作。')+
 '<dl class="takeaways">'+guideRows.map(([t,a,b])=>'<div><dt>'+esc(t)+'</dt><dd>'+esc(a)+'</dd><dd>'+esc(b)+'</dd></div>').join('')+'</dl>'+
 '<p class="info">手机优势：随手查看、输入和处理。限制：屏幕小、不便并排核对，网络和前后台状态更容易中断。这里通过单列详情、就近动作和本地样本状态验证分工。</p>'}
function content(p,id){
 const docIds=Object.keys(docs);
 switch(p){
 case 'search':return searchPage();case 'browse':return mobileBrowsePage();case 'insights':return mobileInsights();case 'finding':return finding(id);case 'recap':return recap();
 case 'capture':return capturePage();
 case 'saved':return notesPage();case 'doc':return docPage(id)+workspaceOriginMarkup(st.notes.find(n=>n.id===id)?.origin);case 'note':return docPage(id,true)+workspaceOriginMarkup(st.notes.find(n=>n.id===id)?.origin);case 'reading':return readingPage();case 'article':return article(id);
 case 'tasks':return taskToolsPage();case 'task':return taskToolsDetail(id);case 'review':return review();case 'card':return workspaceCardPage(id);case 'study':return study();case 'agent':case 'agents':return agentsPage();case 'agent-chat':return agentChatPage(id);case 'agent-connection':return agentConnectionPage();case 'request':return requestDetail(id);case 'requests':return intro('更新请求','查看待同步、桌面处理和已确认的请求。')+section('请求记录',group(st.jobs.slice().reverse().map(requestRow).join(''),'还没有更新请求。'),plain('同步与离线','go:collab-sync'));case 'works':return works();case 'work':return work(id);case 'guide':return guide();
 case 'favorites':return intro('收藏','回看已收藏的笔记与阅读内容。')+searchInput('star-query','搜索收藏',starQuery)+'<div id="star-results">'+favoriteRows()+'</div>';
 case 'recent':return intro('最近浏览','回到最近打开的资料与文章。')+section('访问历史',group(st.history.map(itemRow).join(''),'还没有浏览记录。'),st.history.length?plain('清除','clear-history'):'');
 case 'logs':return journalPage();
 case 'journal-edit':return journalRecordPage(id);
 case 'journal-search':return journalSearchPage();
 case 'journal-select':return journalStudioPage()+journalSelectionDock();
 case 'journal-record':return journalRecordPage(id,true);
 case 'tags':return intro('标签','按标签搜索示例资料。')+searchInput('tag-query','搜索标签',tagQuery)+'<div id="tag-results">'+tagRows()+'</div>';
 case 'label':{const t=labelFromRoute(id);return t?intro(t,'具有此标签的资料与速记。')+section('资料',group(mobileTagItems(t))):missing()}

 case 'libraries':return workspaceLibrariesPage();case 'connections':return workspaceConnectionsPage();
 case 'sync':return deviceSyncPage();case 'collab-sync':return syncPage();case 'future':return futurePage();case 'deck':return deckPage(id);
 case 'settings':return settingsPage();case 'appearance':return appearancePage();case 'widgets':return widgetPreviewPage();
 default:return missing();
 }}
function render(restore=false){
 const demoControls=document.querySelector('.demo-controls');if(demoControls)syncControlsOpen=demoControls.open;
 const widgetScenarios=document.querySelector('.widget-scenarios');if(widgetScenarios)widgetScenariosOpen=widgetScenarios.open;
 const [p,id]=route(),key=p+(id?'/'+id:'');const isTab=navs.some(x=>x[0]===p);
 if((((p==='doc'||p==='note')&&(docs[id]||st.notes.some(n=>n.id===id)))||p==='article')&&activeRoute!==key){const item=p==='article'?'article/'+id:p==='note'||!docs[id]?'note/'+id:id;st.history=[item,...st.history.filter(x=>x!==item)].slice(0,12);save()}
 if(activeRoute!==key){workspaceRememberOpened(key);if(p!=='search')workspaceSearchActive=false;}
 activeRoute=key;document.body.dataset.view=p;
 const isStudy=p==='study'&&allReviewCards().some(c=>(st.studyDeck==='全部'||c.deck===st.studyDeck)&&!st.reviewed.includes(c.id));
 document.body.classList.toggle('focus-session',isStudy);$('#tabs').hidden=isStudy||p==='agent-chat'||p==='widgets'||['logs','journal-search','journal-select','journal-edit','journal-record'].includes(p);
 const brand='<span class="brand">Hub <span class="sample-label">示例资料</span></span>';
 if(isTab||p==='agent')$('#header').innerHTML=mobileRootHeader(p==='agent'?'agents':p);
 else if(['agent-chat','agent-connection'].includes(p))$('#header').innerHTML=agentsHeader(p,id);
 else if(p==='study')$('#header').innerHTML=plain(history.state?.from==='widgets'?'返回小组件':'退出复习',history.state?.from==='widgets'?'back':'exit-study','back')+'<span class="top-title">'+esc(st.studyDeck==='全部'?'专注复习':st.studyDeck)+'</span>';
 else if(p==='logs')$('#header').innerHTML=journalStudioHeader();
 else if(p==='journal-search')$('#header').innerHTML=journalSearchHeader();
 else if(p==='journal-select')$('#header').innerHTML=journalSelectHeader();
 else if(p==='journal-edit')$('#header').innerHTML=journalEditorHeader(id);
 else if(p==='journal-record')$('#header').innerHTML=iconBtn('返回日志','back','back')+'<span class="top-title">日志详情</span>'+iconBtn('记录操作','journal-menu:'+id,'more');
 else if(p==='widgets')$('#header').innerHTML=plain('返回 Hub','back','back')+brand+iconBtn('添加到手机的说明','widget-help','info');
 else if(p==='doc'||p==='note')$('#header').innerHTML=iconBtn('返回','back','back')+'<span class="top-title">'+(p==='note'?'本地笔记':'资料')+'</span><div class="top-actions">'+iconBtn('资料出处','doc-source:'+id,'link')+iconBtn('更多操作','doc-tools:'+id,'more')+'</div>';
 else $('#header').innerHTML=iconBtn('返回','back','back')+'<h1 class="top-title">'+routes[p]+'</h1>'+iconBtn('快速速记','quick-capture:note','plus');
 const selected=['agent','agents','agent-chat','agent-connection'].includes(p)?'agents':isTab?p:history.state?.tab||tabFor(p);
 $('#tabs').innerHTML=navs.map(([k,t,i])=>'<button type="button" class="tab" data-act="tab:'+k+'" '+(k===selected?'aria-current="page"':'')+'><span class="tab-icon">'+ico(i,21)+'</span><span>'+t+'</span></button>').join('');
 $('#content').innerHTML=(['insights','works','work','recap','requests','request','finding','collab-sync'].includes(p)?'<div class="future-banner">示例交互 · 未连接真实分析或桌面服务 '+plain('功能边界','go:guide')+'</div>':'')+content(p,id);
 void hydrateAttachmentImages();
 document.title=(p==='search'?'Hub':routes[p]+' · Hub')+' · 手机原型';
 if(restore){window.scrollTo(0,scrolls[key]||0);$('#content').focus({preventScroll:true})}
 mobileUpdateViewport();
 if(p==='search')workspaceRevealActiveType();
 if(typeof agentUIAfterRender==='function')agentUIAfterRender();
 if(typeof journalStudioAfterRender==='function')journalStudioAfterRender();
}
function showSheet(t,html){
 const d=$('#sheet'),opened=d.open;
 if(!opened){mobileSheetFocus=document.activeElement?.closest('[data-act]')?.dataset.act||null;lockMobilePage()}
 const cardEditor=html.includes('id="card-edit-form"');
 d.innerHTML='<div class="sheet-handle" aria-hidden="true"></div><div class="sheet-head">'+(cardEditor?plain('暂不保存','close'):'')+'<h2 id="sheet-title">'+esc(t)+'</h2>'+(cardEditor?'<button class="btn" type="submit" form="card-edit-form">保存</button>':iconBtn('关闭','close','close'))+'</div><div class="sheet-body">'+html+'</div><p id="sheet-feedback" class="info" role="status" hidden></p>';
 if(!opened)d.showModal();if(typeof journalStudioAfterRender==='function')journalStudioAfterRender();if(d.querySelector('#workspace-scope-form'))workspaceSyncScopeParents();mobileUpdateViewport();
}
function sheet(t,html){
 if(mobileClosingSheet)return;const state=history.state||{},id=state.sheet||++sheetSerial;
 sheets.set(id,[t,html]);
 if(!state.sheet)history.pushState({...state,hubDepth:(state.hubDepth||0)+1,sheet:id},'');
 showSheet(t,html)
}
function close(){if(mobileClosingSheet)return;snapshotMobileSheet();if(history.state?.sheet){mobileClosingSheet=true;history.back()}else dismissMobileSheet(true)}
$('#sheet').addEventListener('cancel',e=>{if(e.target!==e.currentTarget)return;e.preventDefault();close()});


function changed(msg){const persisted=save();render();if(persisted)tell(msg);return persisted}
document.addEventListener('input',e=>{if(typeof journalStudioInput==='function'&&journalStudioInput(e))return;if(workspaceInput(e)||taskToolsInput(e)||handleAgentInput(e))return;handleWorkflowInput(e);const el=e.target;if(el.id==='query'&&!e.isComposing){query=el.value.trim();refreshSearch()}if(el.id==='capture-text'){st.draft=el.value;save()}if(el.id==='reading-query'){readingQuery=el.value.trim();$('#reading-results').innerHTML=readingRows()}if(el.id==='star-query'){starQuery=el.value.trim();$('#star-results').innerHTML=favoriteRows()}if(el.id==='tag-query'){tagQuery=el.value.trim();$('#tag-results').innerHTML=tagRows()}if(el.id==='correction'){st.drafts['feedback-'+el.form.dataset.id]=el.value;save()}if(el.form?.id==='request-form'){st.drafts[el.form.dataset.target]=readRequest(el.form);save()}});
document.addEventListener('focusin',e=>{if(e.target.id==='query'){if(!workspaceSearchActive)workspaceSearchEntryQuery=query;workspaceSearchActive=true;refreshSearch();}});
document.addEventListener('compositionend',e=>{if(taskToolsInput(e))return;if(e.target.id==='query'){query=e.target.value.trim();refreshSearch()}});
document.addEventListener('change',e=>{if(typeof journalStudioInput==='function'&&journalStudioInput(e))return;if(widgetChange(e)||workspaceInput(e)||taskToolsInput(e)||handleAgentChange(e))return;handleWorkflowInput(e);const f=e.target.form;if(f?.id==='request-form'){st.drafts[f.dataset.target]=readRequest(f);save()}});
document.addEventListener('submit',e=>{
 const f=e.target;if(typeof journalStudioSubmit==='function'&&journalStudioSubmit(f)){e.preventDefault();return}if(f.id==='card-edit-form'){e.preventDefault();saveCardEdit(f);return}if(f.id==='reading-filter-form'){e.preventDefault();readingSource=f.querySelector('#reading-source').value;readingView=f.querySelector('#reading-view').value;if(readingView==='继续阅读'){readingFilter='阅读中';readingView='全部内容'}close();render();mobileRememberView();return}if(widgetSubmit(f)||workspaceSubmit(f)||taskToolsSubmit(f)||handleAgentSubmit(f)){e.preventDefault();return}if(f.id==='quick-capture-form'){e.preventDefault();handleWorkflowSubmit(f);return}if(!['search-form','capture-form','correction-form','request-form','search-scope-form','sync-settings-form'].includes(f.id))return;e.preventDefault();
 if(f.id==='search-form'){query=$('#query').value.trim();workspaceRememberQuery();refreshSearch();$('#query').blur();return}
 if(f.id==='capture-form'){const val=$('#capture-text').value.trim();if(!val){tell('请输入记录内容。');return}st.notes.unshift({id:'n'+Date.now(),text:val,date:new Date().toLocaleDateString('zh-CN')});const draft=st.draft;st.draft='';if(!save()){st.notes.shift();st.draft=draft;return}go('saved');tell('已保存到此浏览器');return}
 if(f.id==='request-form'){submitRequest(f);return}
 if(f.id==='sync-settings-form'){st.cloudEnabled=$('#sync-insight').checked;st.readingSync=$('#sync-reading').checked;st.reviewSync=$('#sync-review').checked;if(save()){close();render();tell('已保存本设备同步范围')}return}
 if(f.id==='correction-form'){const val=$('#correction').value.trim();if(!val){tell('请输入补充内容。');return}const key='feedback-'+f.dataset.id,prior=st.drafts[key];(st.feedback[f.dataset.id]??=[]).push({text:val,at:Date.now(),sent:false});delete st.drafts[key];if(!save()){st.feedback[f.dataset.id].pop();st.drafts[key]=prior||val;return}close();render();tell('补充已保存，等待示例同步');return}
 if(f.id==='search-scope-form'){source=$('#scope-source').value;searchFolder=$('#scope-folder').value;searchDate=$('#scope-date').value;searchType=$('#scope-type').value;close();render();return}

});
document.addEventListener('click',e=>{
 const el=e.target.closest('[data-act]');if(!el)return;
 const [a,k,v]=el.dataset.act.split(':');
 if(typeof voiceAction==='function'&&voiceAction(a,k))return;
 if(typeof journalStudioAction==='function'&&journalStudioAction(a,k))return;
 if(widgetAction(a,k)||workspaceAction(a,k,v)||taskToolsAction(a,k,v)||handleAgentAction(a,k,v)||mobileHandleAction(a,k,v)||handleWorkflowAction(a,k,v))return;
 if(a==='go'){go(k);return}
 if(a==='back'){back();return}
 if(a==='close'){close();return}
 switch(a){
 case 'query':query=query===k?'':k;render();break;
 case 'filter':filter=k;render();break;
 case 'readview':readingView=k;render();break;
 case 'log-month':logMonth=k;render();break;
 case 'reading-original':sheet('原文出处','<p class="prose">'+esc(reading.find(r=>r.id===k).src)+' · '+esc(reading.find(r=>r.id===k).t)+'</p><p class="info">这条内容为示例，未提供可打开的真实链接。</p>');break;
 case 'reading-manage':readingManagement(k);break;
 case 'reading-cache':st.cache[k]=!st.cache[k];close();changed(st.cache[k]?'已加入离线示例':'已移除离线示例');break;
 case 'readfilter':readingFilter=k;if(readingView==='继续阅读')readingView='全部内容';render();mobileRememberView();break;
 case 'read-source':readingFilterSheet();break;
 case 'read-clear':if(k==='source')readingSource='全部来源';else readingView='全部内容';render();mobileRememberView();break;
 case 'read-reset':$('#reading-source').value='全部来源';$('#reading-view').value='全部内容';snapshotMobileSheet();break;
 case 'readscope':readingSource=k;close();render();break;
 case 'taskdate':taskDate=k;render();break;
 case 'undo-task':if(undoTask){const prior=st.tasks[undoTask.id];st.tasks[undoTask.id]=undoTask.was;if(!save()){st.tasks[undoTask.id]=prior;tell('撤销尚未保存，请重试');break}undoTask=null;render();tell('已撤销任务状态')}break;
 case 'taskfilter':taskFilter=k;render();break;
 case 'search-scope':sheet('搜索筛选','<form id="search-scope-form">'+selectField('scope-source','资料库',['全部资料库','Craft','Obsidian','本地记录'],source)+selectField('scope-folder','资料分组',['全部分组',...allMobileLabels()],searchFolder)+selectField('scope-date','事件日期',['不限日期','11 月','10 月'],searchDate)+selectField('scope-type','内容类型',['全部类型','笔记','PDF','链接'],searchType)+'<div class="actions"><button class="btn">应用筛选</button>'+btn('清除筛选','clear-scope','outline')+'</div></form>');break;
 case 'clear-scope':source='全部资料库';searchFolder='全部分组';searchDate='不限日期';searchType='全部类型';close();render();break;
 case 'scope':source=k;close();render();tell('已切换搜索范围');break;
 case 'library':source=k;go('search');tell('已选择 '+k);break;
 case 'star':st.stars[k]=!(st.stars[k]??k==='d3');changed(st.stars[k]?'已收藏':'已取消收藏');break;
 case 'clear-history':st.history=[];changed('浏览记录已清除');break;
 case 'read':st.reading[k]=v;changed('阅读状态已更新');break;
 case 'task':{const t=allTasks().find(t=>t.id===k);if(!t)break;const prior=st.tasks[k],lastUndo=undoTask;undoTask={id:k,was:done(t)};st.tasks[k]=!undoTask.was;if(!save()){if(prior===undefined)delete st.tasks[k];else st.tasks[k]=prior;undoTask=lastUndo;render();tell('任务状态尚未保存，请重试');break}render();tell(st.tasks[k]?'已完成演示任务':'已恢复待办');break;}
 case 'start':st.studyDeck=k;face=false;cardIndex=0;save();go('study');break;
 case 'flip':face=!face;render();break;
 case 'grade':{const priorGrade=st.grades[k],priorReviewed=[...st.reviewed],priorIndex=cardIndex;st.grades[k]=v;if(v==='重来')cardIndex++;else{if(!st.reviewed.includes(k))st.reviewed.push(k);cardIndex=0}if(!save()){if(priorGrade===undefined)delete st.grades[k];else st.grades[k]=priorGrade;st.reviewed=priorReviewed;cardIndex=priorIndex;render();tell('评分尚未保存，请重试');break}face=false;render();tell(v==='重来'?'已留待本轮重来':'已记录本次复习');break;}
 case 'wrong-choice':face=true;render();tell('再核对一下答案');break;
 case 'next':face=false;cardIndex++;render();break;
 case 'ask':{const result=agentCreateThread({docId:k});if(result.ok)go('agent-chat/'+result.threadId);else tell(result.error||'暂时无法创建会话');break;}
 case 'ask-finding':{const f=findData(k);if(!f)break;const result=agentCreateThread({docIds:f.docs,title:f.t,draft:'请根据这些依据，帮我继续核对：'+f.t});if(result.ok)go('agent-chat/'+result.threadId);else tell(result.error||'暂时无法创建会话');break;}
 case 'status':st.find[k]={status:v,...(v==='稍后'?{until:new Date().setHours(24,0,0,0)}:{})};st.actions.push({id:k,status:v,at:Date.now(),sent:false});close();changed('已更新为'+v);break;
 case 'later':if(status(k)==='稍后'){st.find[k]={status:'待关注'};st.actions.push({id:k,status:'待关注',at:Date.now(),sent:false});changed('已恢复待关注')}else sheet('稍后查看','<p class="lede">明天到期后在再次打开时恢复关注；不发送提醒。</p><div class="actions">'+btn('明天再看','status:'+k+':稍后')+btn('取消','close','outline')+'</div>');break;
 case 'correct':sheet('补充或纠正','<form id="correction-form" data-id="'+k+'"><div class="field"><label for="correction">哪些地方需要重新核对？</label><textarea id="correction" required maxlength="1000">'+esc(st.drafts['feedback-'+k]||'')+'</textarea></div><p class="fine">补充将作为新记录保存，原结论和旧反馈保留。</p><button class="btn wide">保存补充</button></form>');break;
 case 'request':requestSheet(k);break;
 case 'cancel-job':{const j=st.jobs.find(x=>x.id===k);if(j&&['queued','waiting','ready'].includes(j.stage)){j.stage=j.stage==='queued'?'cancelled':'cancelPending';changed(j.stage==='cancelled'?'已撤销本地请求':'已记录撤销，等待同步')}break}
 case 'apply-job':applyJob(k);break;
 case 'mode':compare=k;render();break;
 case 'offline':st.offline=!st.offline;changed(st.offline?'手机离线，待同步操作保留':'手机已恢复在线');break;
 case 'desktop-online':st.desktopOnline=!st.desktopOnline;for(const j of st.jobs){if(st.desktopOnline&&j.stage==='waiting')j.stage='ready';if(!st.desktopOnline&&j.stage==='ready')j.stage='waiting'}changed(st.desktopOnline?'桌面已上线':'桌面已离线');break;
 case 'source-change':if(!st.desktopOnline){tell('请先模拟桌面上线');break}st.sourceChanged=true;changed('桌面已补录示例账目，原结论待复核');break;
 case 'desktop-step':desktopStep(k);break;
 case 'sync-error':st.syncError=!st.syncError;changed(st.syncError?'已模拟同步失败':'同步连接已恢复，可重试');break;
 case 'sync-settings':sheet('本设备同步设置','<form id="sync-settings-form"><fieldset><legend>同步范围</legend>'+[['insight','洞察成果与反馈',st.cloudEnabled],['reading','阅读',st.readingSync],['review','闪卡与复习记录',st.reviewSync]].map(([k,t,on])=>'<label class="choice"><input type="checkbox" id="sync-'+k+'" '+(on?'checked':'')+'>'+t+'</label>').join('')+'</fieldset><p class="info">这些开关只影响本设备。示例仅推进洞察同步，阅读和闪卡在此展示设置。</p><div class="actions"><button class="btn">保存设置</button></div></form>');break;

 case 'refresh-sync':if(st.syncError&&!st.offline&&st.cloudEnabled){st.syncError=false}syncNow();break;

 case 'reset':sheet('重置示例','<p class="prose">清除这台设备在本站的记录、收藏、任务与发现状态。</p><div class="actions">'+btn('确认重置','reset-confirm')+btn('取消','close','outline')+'</div>');break;
 case 'reset-confirm':{if(attachmentBusy){tell('附件正在保存，请稍后再重置。');break}const priorState=st;const preferences=structuredClone(mobilePreferences());st=structuredClone(initial);st.preferences=preferences;st.find.f3={status:'稍后',until:new Date().setHours(24,0,0,0)};if(save()){undoTask=null;initAgents();resumeAgents();close();render();applyAppearance();void clearPrototypeAttachments();tell('演示数据已重置，外观偏好保留')}else st=priorState;break;}
 }
});
addEventListener('popstate',()=>{if(typeof journalBeforePop==='function'&&journalBeforePop())return;mobileClosingSheet=false;const k=route().filter(Boolean).join('/');const state=history.state||{},sheetId=state.sheet;
 if(sheetId&&sheets.has(sheetId)){if(k!==activeRoute){scrolls[activeRoute]=pageScroll();render(true)}showSheet(...sheets.get(sheetId));return}
 // After a reload, old sheet entries have no recoverable view and should not trap Back.
 if(!$('#sheet').open&&k===activeRoute&&state.hubDepth>0){history.back();return}
 const wasOpen=$('#sheet').open;dismissMobileSheet(wasOpen);if(k!==activeRoute){scrolls[activeRoute]=pageScroll();render(true)}mobileRememberView();
});
initAgents();
setupMobile();
setupAgentUI();
render(true);
resumeAgents();
