'use strict';

// Shared search and cross-module actions. All data stays inside this demo browser.
const WORKSPACE_TYPES = ['全部类型', '资料', '笔记', '日志', 'PDF', '链接', '任务', '阅读', '对话', '洞察', '闪卡'];
const WORKSPACE_QUICK_TYPES = [['全部类型', '全部'], ['资料', '资料'], ['任务', '任务'], ['阅读', '阅读'], ['对话', '对话'], ['洞察', '洞察'], ['闪卡', '闪卡']];
const WORKSPACE_DOCUMENT_TYPES = ['笔记', '日志', 'PDF', '链接'];
const WORKSPACE_DATES = ['不限日期', '今天', '近 7 天', '11 月', '10 月'];
const WORKSPACE_SOURCES = ['全部资料库', 'Craft', 'Obsidian', '本地记录', '滴答清单', '阅读', 'Agents', '洞察', '闪卡'];
const WORKSPACE_LIBRARIES = [
  { id: 'craft', title: 'Craft', subtitle: 'main · 示例空间', leaves: [['craft-projects', 'Hub 项目'], ['craft-reading', '阅读笔记'], ['craft-finance', '账目']] },
  { id: 'obsidian', title: 'Obsidian', subtitle: 'main · 示例库', leaves: [['obsidian-journal', '生活日志']] },
  { id: 'ticktick', title: '滴答清单', subtitle: '示例清单', leaves: [['ticktick-life', '生活'], ['ticktick-inbox', '收件箱']] },
  { id: 'reading', title: '阅读', subtitle: '示例来源', leaves: [['reading-x', 'X 书签 / 喜欢'], ['reading-telegram', 'Telegram'], ['reading-ticktick', '滴答稍后读']] },
  { id: 'local', title: '本地记录', subtitle: '当前浏览器', leaves: [['local-notes', '速记、笔记与本地任务']] },
  { id: 'agents', title: 'Agents', subtitle: '当前浏览器 · 演示会话', leaves: [['agents-threads', '会话与已归档对话']] },
  { id: 'insights', title: '洞察', subtitle: '示例发现与处理记录', leaves: [['insights-findings', '有依据的发现']] },
  { id: 'review', title: '闪卡', subtitle: '示例牌库与本地采用', leaves: [['review-cards', '全部牌组']] },
];
let workspaceScopeDraft = null;
let workspaceTypeObserver = null, workspaceObservedStrip = null;
function workspaceLeaves() { return WORKSPACE_LIBRARIES.flatMap(group => group.leaves.map(([id]) => id)); }
function workspacePrefs() {
  const old = st.workspaceSearch;
  if (!old || typeof old !== 'object' || Array.isArray(old)) st.workspaceSearch = {};
  const p = st.workspaceSearch;
  if (Array.isArray(p.scope)) p.scope = [...new Set(p.scope.filter(id => workspaceLeaves().includes(id)))];
  else p.scope = null;
  if (!['相关优先', '最近优先'].includes(p.sort)) p.sort = '相关优先';
  return p;
}
function workspaceScope() { return workspacePrefs().scope ?? workspaceLeaves(); }
function workspaceLimited() { return workspaceScope().length !== workspaceLeaves().length; }
function workspaceDocumentLeaf(doc) {
  if (doc.s === 'Obsidian') return 'obsidian-journal';
  return doc.tag === '项目' ? 'craft-projects' : doc.tag === '账目' ? 'craft-finance' : 'craft-reading';
}
function workspaceDemoDay(text) {
  const m = String(text || '').match(/^(\d+) 月 (\d+) 日/);
  return m ? '2026-' + m[1].padStart(2, '0') + '-' + m[2].padStart(2, '0') : '';
}
function workspaceTimestampDay(at) {
  const d = new Date(at);
  return at && Number.isFinite(d.getTime()) ? `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}` : '';
}
function workspaceTaskDay(task) {
  if (validJournalDay(task.dueDate)) return task.dueDate;
  if (validJournalDay(task.date)) return task.date;
  if (['今天', '明天', '昨天'].includes(task.date)) {
    const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() + ({今天:0,明天:1,昨天:-1})[task.date]);
    return workspaceTimestampDay(d.getTime());
  }
  return '';
}
function workspaceIndex() {
  const list = [];
  for (const [id, d] of Object.entries(docs)) list.push({ key:'doc:'+id, id, kind:'doc', type:d.type || (d.tag==='生活日志'?'日志':'笔记'), title:d.t, body:d.body+' '+(d.k||''), source:d.s, leaf:workspaceDocumentLeaf(d), tags:[d.tag], date:workspaceDemoDay(d.date), dateLabel:d.date+' · 示例', route:'doc/'+id, icon:d.tag==='生活日志'?'calendar':'note', demo:true });
  for (const n of st.notes) list.push({ key:'note:'+n.id, id:n.id, kind:'note', type:n.kind==='link'?'链接':'笔记', title:n.title || n.text?.split('\n')[0].slice(0,60) || '附件记录', body:(n.text||'')+' '+(n.url||'')+' '+recordAttachments(n).map(a=>a.name).join(' '), source:'本地记录', leaf:'local-notes', tags:journalTags(n.text), date:recordDay(n), dateLabel:recordDay(n)||'日期未记录', route:'note/'+n.id, icon:'note', demo:false });
  for (const t of allTasks()) {
    const sourceName = t.src?.startsWith('Craft') ? 'Craft' : t.src?.startsWith('滴答') ? '滴答清单' : '本地记录';
    list.push({ key:'task:'+t.id, id:t.id, kind:'task', type:'任务', title:t.t, body:t.note||'', source:sourceName, leaf:sourceName==='Craft'?'craft-projects':sourceName==='滴答清单'?(t.src.includes('收件箱')?'ticktick-inbox':'ticktick-life'):'local-notes', tags:[], date:workspaceTaskDay(t), dateLabel:(t.date||'未安排')+' · '+(done(t)?'已完成':'待办'), route:'task/'+t.id, icon:'task', demo:true });
  }
  for (const r of reading) list.push({ key:'reading:'+r.id, id:r.id, kind:'reading', type:'阅读', title:r.t, body:r.blurb+' '+r.body, source:'阅读', leaf:r.src.startsWith('X')?'reading-x':r.src==='Telegram'?'reading-telegram':'reading-ticktick', tags:[], date:'', dateLabel:r.src+' · '+rstatus(r)+' · 示例', route:'article/'+r.id, icon:'book', demo:true });
  for (const t of agentState().threads) list.push({ key:'agent:'+t.id, id:t.id, kind:'agent', type:'对话', title:t.title, body:(t.messages||[]).map(m=>m.text||'').join('\n'), source:'Agents', leaf:'agents-threads', tags:[], date:workspaceTimestampDay(t.updatedAt||t.createdAt), dateLabel:workspaceTimestampDay(t.updatedAt||t.createdAt)+(t.archivedAt?' · 已归档':'')+' · 演示', route:'agent-chat/'+t.id, icon:'chat', demo:true });
  for (const id of Object.keys(findings)) {
    const f = findData(id);
    list.push({key:'finding:'+id,id,kind:'finding',type:'洞察',title:f.t,body:f.desc+' '+f.body,source:'洞察',leaf:'insights-findings',tags:[],date:'2026-11-09',dateLabel:status(id)+' · 示例',route:'finding/'+id,icon:'spark',demo:true});
  }
  for (const c of allReviewCards()) list.push({key:'card:'+c.id,id:c.id,kind:'card',type:'闪卡',title:c.q,body:c.a,source:'闪卡',leaf:'review-cards',tags:[c.deck],date:'',dateLabel:c.deck+' · '+(st.reviewed.includes(c.id)?'已复习':'待复习'),route:'card/'+c.id,icon:'cards',demo:true});
  return list;
}
function workspaceDateMatches(item) {
  if (searchDate === '不限日期') return true;
  if (!item.date) return false;
  if (searchDate === '今天') return item.date === localDay();
  if (searchDate === '近 7 天') { const days = (new Date(localDay()+'T12:00:00')-new Date(item.date+'T12:00:00'))/86400000; return days>=0 && days<7; }
  return item.date.startsWith('2026-') && Number(item.date.slice(5,7)) === Number(searchDate.split(' ')[0]);
}
function workspaceMatches() {
  const selected = workspaceScope(), terms = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return workspaceIndex().filter(item => selected.includes(item.leaf) && (source==='全部资料库'||item.source===source) && workspaceTypeMatches(item) && (searchFolder==='全部分组'||item.tags.includes(searchFolder)) && workspaceDateMatches(item) && terms.every(term=>(item.title+' '+item.body+' '+item.source+' '+item.tags.join(' ')).toLocaleLowerCase().includes(term))).map(item => ({...item,score:terms.reduce((sum,t)=>sum+(item.title.toLocaleLowerCase().startsWith(t)?12:item.title.toLocaleLowerCase().includes(t)?7:1),0)})).sort((a,b)=>(workspacePrefs().sort==='相关优先'?b.score-a.score:0)||b.date.localeCompare(a.date)||a.key.localeCompare(b.key));
}
function workspaceTypeMatches(item) {
  return searchType==='全部类型' || (searchType==='资料' ? ['doc','note'].includes(item.kind) : item.type===searchType);
}
function workspaceRevealActiveType() {
  const strip=document.querySelector('.search-kind-tabs'),selected=strip?.querySelector('[aria-pressed="true"]');
  if(typeof ResizeObserver==='function'&&strip!==workspaceObservedStrip){
    workspaceTypeObserver?.disconnect();workspaceObservedStrip=strip;
    if(strip){workspaceTypeObserver ||= new ResizeObserver(workspaceRevealActiveType);workspaceTypeObserver.observe(strip);}
  }
  if(!strip||!selected)return;
  const outer=strip.getBoundingClientRect(),inner=selected.getBoundingClientRect();
  if(inner.left<outer.left)strip.scrollLeft-=outer.left-inner.left;
  else if(inner.right>outer.right)strip.scrollLeft+=inner.right-outer.right;
}
function workspaceScopeLabel(selected = workspaceScope()) {
  if(selected.length===workspaceLeaves().length)return '全部资料库';
  if(!selected.length)return '未选择资料';
  const groups=WORKSPACE_LIBRARIES.map(g=>({group:g,leaves:g.leaves.filter(([id])=>selected.includes(id))})).filter(g=>g.leaves.length);
  if(groups.length===1){const {group,leaves}=groups[0];return group.title+(leaves.length===group.leaves.length?'':leaves.length===1?' · '+leaves[0][1]:' · '+leaves.length+' 个分组');}
  return groups.slice(0,2).map(g=>g.group.title).join('、')+(groups.length>2?'等 '+groups.length+' 个资料库':'');
}
function workspaceFilterItems() {
  const items=[];
  if(workspaceLimited())items.push({key:'scope',label:'范围：'+workspaceScopeLabel(),clear:'清除资料范围'});
  if(source!=='全部资料库')items.push({key:'source',label:'来源：'+source,clear:'清除来源筛选'});
  if(searchFolder!=='全部分组')items.push({key:'folder',label:'标签：'+searchFolder,clear:'清除标签筛选'});
  if(searchDate!=='不限日期')items.push({key:'date',label:searchDate,clear:'清除日期筛选'});
  if(searchType!=='全部类型')items.push({key:'type',label:'类型：'+searchType,clear:'清除内容类型筛选'});
  return items;
}
function workspaceFacets() {
  return workspaceFilterItems().map(item=>item.label);
}
function workspaceSearchPage() {
  const facets = workspaceFilterItems(), quickType=WORKSPACE_DOCUMENT_TYPES.includes(searchType)?'资料':searchType;
  const visibleFacets=facets.filter(item=>item.key!=='type'||WORKSPACE_DOCUMENT_TYPES.includes(searchType));
  const scopeStatus=!workspaceLimited()&&source==='全部资料库'?'<span class="search-range-status">范围：全部资料库</span>':'';
  const filterButton='<button type="button" class="icon-btn search-filter-button" data-act="search-scope" aria-label="筛选搜索'+(facets.length?'，已启用 '+facets.length+' 项':'')+'">'+ico('tune',20)+(facets.length?'<span class="search-filter-badge" aria-hidden="true">'+facets.length+'</span>':'')+'</button>';
  return intro('搜索','笔记、任务、阅读和对话，在同一个地方找回。')+
    '<form class="searchbox" id="search-form" role="search"><div class="search-input-wrap"><span class="search-icon">'+ico('search',20)+'</span><input type="search" id="query" aria-label="搜索内容" placeholder="搜索笔记、任务、阅读、对话" autocomplete="off" enterkeyhint="search" value="'+esc(query)+'"><button type="button" class="search-clear icon-btn" data-act="clear-query" aria-label="清除搜索" '+(!query?'hidden':'')+'>'+ico('close',16)+'</button></div>'+filterButton+'</form>'+
    '<div class="filter search-kind-tabs" role="group" aria-label="内容类型">'+WORKSPACE_QUICK_TYPES.map(([key,label])=>chip(label,'workspace-type:'+key,quickType===key)).join('')+'</div>'+
    '<div class="search-active-filters" aria-label="当前搜索范围与筛选">'+scopeStatus+visibleFacets.map(item=>'<button type="button" class="search-filter-chip" data-act="workspace-clear-filter:'+item.key+'" aria-label="'+esc(item.clear+'：'+item.label)+'"><span>'+esc(item.label)+'</span>'+ico('close',14)+'</button>').join('')+'</div>'+
    '<div id="workspace-suggestions" class="search-suggestions" '+(query||facets.length?'hidden':'')+'><span class="search-suggestion-label">试试搜索</span><div class="filter">'+['复盘','项目','线束固定点'].map(t=>chip(t,'query:'+t,false)).join('')+'</div></div>'+
    '<div id="results" aria-live="polite" aria-atomic="false">'+workspaceSearchResults()+'</div><div id="search-extra" '+(query||facets.length?'hidden':'')+'>'+workspaceInsightsCard()+section('接着看',group(row('留出可回看的记录','上次的想法，值得再读一遍','book','go:doc/d3','purple')+row('日志与随手记录','按天回看，随时记下一点想法','calendar','go:logs')))+'</div>';
}
function workspaceSearchResults() {
  const results = workspaceMatches(), active = query || workspaceFacets().length;
  if (!results.length) return '<section class="empty-state">'+ico('search',30)+'<h2>还没有找到</h2><p>当前仅搜索本原型的示例和本机内容。试着换个关键词，或放宽资料范围。</p>'+btn('清除搜索与筛选','clear-search','secondary')+'</section>';
  const visible = active ? results : ['task:t1','reading:r2','agent:ag-seed-harness'].map(key=>results.find(x=>x.key===key)).filter(Boolean);
  const renderItem = item => {
    const term = query.split(/\s+/).find(t=>t&&match(item.body,t)), pos = term?item.body.toLocaleLowerCase().indexOf(term.toLocaleLowerCase()):-1;
    const excerpt = pos>=0 ? (pos>20?'…':'')+item.body.slice(Math.max(0,pos-20),pos+65) : item.body.slice(0,65);
    return '<button type="button" class="row search-result" data-act="go:'+esc(item.route)+'"><span class="tile '+(item.kind==='reading'?'purple':'')+'">'+ico(item.icon,18)+'</span><span class="copy"><strong>'+marked(item.title,query.split(/\s+/).find(Boolean))+'</strong>'+(query?'<small class="result-excerpt">'+marked(excerpt,term)+'</small>':'')+'<small>'+esc(item.type+' · '+(item.type===item.source?'':item.source+' · ')+item.dateLabel)+'</small></span><span class="tail">'+ico('chev',16)+'</span></button>';
  };
  const summary = active ? '<p class="search-count">'+results.length+' 条结果 · '+workspacePrefs().sort+'</p>' : '';
  if (!active) return section('跨模块找回',group(visible.map(renderItem).join('')));
  return summary + [...new Set(visible.map(x=>x.type))].map(type=>section(type+' · '+visible.filter(x=>x.type===type).length,group(visible.filter(x=>x.type===type).map(renderItem).join('')))).join('');
}
function workspaceScopeTree(selected) {
  const all = workspaceIndex();
  return WORKSPACE_LIBRARIES.map(g=>'<details class="scope-library" data-scope-library="'+g.id+'"><summary><span>'+esc(g.title)+'<small>'+esc(g.subtitle)+'</small></span><span class="scope-count" data-scope-count="'+g.id+'">'+g.leaves.filter(([id])=>selected.includes(id)).length+'/'+g.leaves.length+'</span></summary><label class="choice scope-parent"><input type="checkbox" data-scope-group="'+g.id+'" '+(g.leaves.every(([id])=>selected.includes(id))?'checked':'')+'><span>全部 '+esc(g.title)+'</span></label>'+g.leaves.map(([id,title])=>'<label class="choice scope-leaf"><input type="checkbox" name="workspace-scope" value="'+id+'" '+(selected.includes(id)?'checked':'')+'><span>'+esc(title)+'</span><small>'+all.filter(item=>item.leaf===id).length+'</small></label>').join('')+'</details>').join('');
}
function workspaceScopeSheet() {
  const legacySource=WORKSPACE_LIBRARIES.find(g=>g.title===source);
  workspaceScopeDraft = workspaceScope().filter(id=>!legacySource||legacySource.leaves.some(([leaf])=>leaf===id));
  sheet('搜索筛选','<form id="workspace-scope-form" class="workspace-filter-form"><div class="workspace-filter-scroll"><p class="fine workspace-filter-intro">设置会保留，搜索时无需再次确认。仅筛选本机内容，不会授权给 Agents。</p><div class="workspace-filter-fields">'+selectField('workspace-type','内容类型',WORKSPACE_TYPES,searchType)+selectField('workspace-date','日期范围',WORKSPACE_DATES,searchDate)+selectField('workspace-sort','排序',['相关优先','最近优先'],workspacePrefs().sort)+(searchFolder!=='全部分组'?selectField('workspace-folder','资料标签',['全部分组',...allMobileLabels()],searchFolder):'')+'</div><details class="workspace-scope-picker"><summary><span class="scope-summary-copy"><strong>资料范围</strong><small id="workspace-scope-summary">'+esc(workspaceScopeLabel(workspaceScopeDraft))+'</small></span>'+ico('chev',18)+'</summary><div class="scope-toolbar">'+plain('全选','workspace-scope-all:yes')+plain('全不选','workspace-scope-all:no')+'</div><fieldset class="scope-tree" aria-label="选择资料库和分组">'+workspaceScopeTree(workspaceScopeDraft)+'</fieldset></details><p class="fine">任务按截止日，对话按更新日，资料按记录日；没有日期的阅读与闪卡在日期筛选后不显示。月份示例属于 2026 年。</p></div><div class="workspace-filter-footer"><p id="workspace-filter-summary" class="fine" aria-live="polite"></p><p id="workspace-filter-error" class="capture-error" role="alert"></p><div class="actions">'+btn('重置','workspace-scope-reset','outline')+'<button type="submit" class="btn">应用筛选</button></div></div></form>');
  workspaceSyncScopeParents();
}
function workspaceSyncScopeParents() {
  const form = document.querySelector('#workspace-scope-form'); if(!form)return;
  const selected = [...form.querySelectorAll('[name="workspace-scope"]:checked')].map(input=>input.value);
  workspaceScopeDraft = selected;
  form.querySelectorAll('[data-scope-group]').forEach(input=>{const g=WORKSPACE_LIBRARIES.find(x=>x.id===input.dataset.scopeGroup), count=g.leaves.filter(([id])=>selected.includes(id)).length;input.checked=count===g.leaves.length;input.indeterminate=count>0&&count<g.leaves.length;const label=form.querySelector('[data-scope-count="'+g.id+'"]');if(label)label.textContent=count+'/'+g.leaves.length;});
  const summary=form.querySelector('#workspace-scope-summary'),footer=form.querySelector('#workspace-filter-summary');
  if(summary)summary.textContent=workspaceScopeLabel(selected);
  if(footer)footer.textContent=(selected.length?'已选 '+selected.length+' 个资料分组':'未选择资料，应用后将没有结果')+' · 应用后生效';
}
function workspacePersistFilters() {
  st.workspaceSearch={...workspacePrefs(),type:searchType,date:searchDate,source,folder:searchFolder};
  return save();
}
function workspaceUpdateFilter(change) {
  const old=structuredClone(st.workspaceSearch),previous=[source,searchFolder,searchDate,searchType];
  change();
  if(!workspacePersistFilters()){st.workspaceSearch=old;[source,searchFolder,searchDate,searchType]=previous;return false;}
  render();mobileRememberView();return true;
}
function workspaceResetScopeDraft() {
  const form=document.querySelector('#workspace-scope-form');if(!form)return;
  form.querySelectorAll('[name="workspace-scope"]').forEach(input=>input.checked=true);
  for(const [id,value] of [['workspace-type','全部类型'],['workspace-date','不限日期'],['workspace-sort','相关优先'],['workspace-folder','全部分组']]){const field=form.querySelector('#'+id);if(field)field.value=value;}
  const error=form.querySelector('#workspace-filter-error');if(error)error.textContent='';
  workspaceSyncScopeParents();snapshotMobileSheet();
}
function workspaceClearSearch(clearQuery) {
  const old = structuredClone(st.workspaceSearch), previous=[source,searchFolder,searchDate,searchType,query];
  st.workspaceSearch={scope:null,sort:'相关优先'}; source='全部资料库'; searchFolder='全部分组'; searchDate='不限日期'; searchType='全部类型'; if(clearQuery)query='';
  if(!save()){st.workspaceSearch=old;[source,searchFolder,searchDate,searchType,query]=previous;return false;}
  if($('#sheet').open)close(); render();mobileRememberView();return true;
}
function workspaceLibrariesPage() {
  const scope = workspaceScope(), index=workspaceIndex();
  return intro('资料库','查看可搜索内容，选择自己的资料范围。')+'<p class="info">以下为示例分组和本机记录，不代表你的真实账号已连接。Notion、飞书等真实资料不会自动出现在此站。</p>'+btn('选择多个资料范围','search-scope','wide outline','tune')+WORKSPACE_LIBRARIES.map(g=>section(g.title+' · '+g.subtitle,group(g.leaves.map(([id,title])=>row(title,index.filter(x=>x.leaf===id).length+' 条 · '+(scope.includes(id)?'已纳入搜索':'未纳入搜索'),'folder','workspace-library:'+id)).join('')))).join('');
}
function workspaceInsightsCard() {
  const count=Object.keys(findings).filter(id=>status(id)==='待关注'||pending(id)).length;
  return '<button type="button" class="continue-card workspace-insights" data-act="go:insights"><span class="tile purple">'+ico('spark',21)+'</span><span class="copy"><strong>值得留意 · '+count+' 条示例发现</strong><small>回看依据，决定处理、核对或暂时忽略</small></span>'+ico('chev',18)+'</button>';
}
function workspaceConnectionsPage() {
  const sync=syncPreferences(), c=agentState().connection;
  const contentStatus=!sync.enabled?'演示已暂停':st.offline?'模拟离线':st.syncError?'模拟上传失败':'可演示同步';
  const agentStatus=c.network!=='online'?'模拟手机离线':c.server!=='online'?'模拟服务不可达':c.device==='revoked'?'模拟设备撤销':c.auth!=='valid'?'模拟登录失效':c.quota==='exhausted'?'模拟额度不足':'演示连接就绪';
  return intro('连接总览','内容同步和 Agents 会话，是两条独立通道。')+'<p class="info">本站不探测实际 OSS、VPS 或登录状态。下列均为可操作的本地演示状态。</p>'+section('内容同步 · OSS',group(row(contentStatus,'速记、阅读与闪卡；电脑'+(st.desktopOnline?'在线':'离线')+'只影响最终写入演示','sync','go:sync')))+section('Agents 会话 · VPS',group(row(agentStatus,'文字 / 图片会话；不依赖 Windows 在线','chat','go:agent-connection')))+'<p class="fine">一个通道恢复，不会把另一个通道也标记为已恢复。真实设备的鉴权、联网与后台任务仍需独立验收。</p>';
}
function workspaceRecord(kind,id) {
  return workspaceIndex().find(item=>item.id===id && item.kind===kind);
}
function workspaceSendToAgent(kind,id) {
  const item=workspaceRecord(kind,id);if(!item){tell('原内容已不可用，请返回重新选择。');return;}
  agentStartWithMaterial({id:item.id,type:kind,title:item.title,body:item.body,source:item.source,route:item.route,demo:item.demo});
}
function workspaceTaskFromAgent(threadId,messageId) {
  const thread=agentState().threads.find(t=>t.id===threadId),message=thread?.messages.find(m=>m.id===messageId&&m.role==='assistant');
  if(!thread||!message){tell('这条回答暂不可用。');return;}
  taskToolsOpenEditor({kind:'agent',id:threadId+'/'+messageId,title:thread.title,route:'agent-chat/'+threadId,text:message.text});
}
function workspaceOriginMarkup(origin) {
  if(!origin||!['doc','note','article','task','finding','agent-chat'].includes(String(origin.route).split('/')[0]))return '';
  return section('关联来源',group(row(origin.title||'原内容','回到创建这条记录的上下文','link','go:'+esc(origin.route))));
}
function workspaceNoteSheet(kind,id) {
  const item=workspaceRecord(kind,id);if(!item)return;
  if(!st.contextNotes||typeof st.contextNotes!=='object'||Array.isArray(st.contextNotes))st.contextNotes={};
  const key=kind+':'+id,draft=st.contextNotes[key]||{text:'',quote:''};
  sheet('记下阅读想法','<form id="workspace-note-form" data-kind="'+esc(kind)+'" data-id="'+esc(id)+'"><p class="fine">来源：'+esc(item.title)+'。使用独立草稿，不会覆盖全局加号里的速记。</p><div class="field"><label for="workspace-note-text">我的想法</label><textarea id="workspace-note-text" maxlength="10000" placeholder="这段内容与我现在的问题有什么关系？">'+esc(draft.text)+'</textarea></div><div class="field"><label for="workspace-note-quote">原文摘录（可选）</label><textarea id="workspace-note-quote" rows="3" maxlength="10000" placeholder="粘贴需要保留的原文片段">'+esc(draft.quote)+'</textarea></div><p class="capture-error" role="alert"></p><div class="actions"><button class="btn" type="submit">保存为本地笔记</button></div><p class="fine">仅保存到当前浏览器，保留返回原文的链接。</p></form>');
}
function workspaceNoteDraft(form) {
  const key=form.dataset.kind+':'+form.dataset.id;
  st.contextNotes ||= {};
  return st.contextNotes[key]={text:form.querySelector('#workspace-note-text').value,quote:form.querySelector('#workspace-note-quote').value};
}
function workspaceCardPage(id) {
  const c=allReviewCards().find(item=>item.id===id);if(!c)return missing();
  return detail(c.q,tag('闪卡')+' '+tag(c.deck),'<div class="reader-body"><p>'+esc(c.a)+'</p></div>'+group(docs[c.doc]?sourceRow(c.doc):'')+'<div class="actions">'+btn('复习这个牌组','start:'+c.deck,'','cards')+'</div>');
}
function workspaceInput(event) {
  const el=event.target,form=el.form;
  if(form?.id==='workspace-note-form') { workspaceNoteDraft(form);const ok=save();form.querySelector('.capture-error').textContent=ok?'':'草稿暂未保存，请保留当前页面后重试。';return true; }
  if(form?.id!=='workspace-scope-form')return false;
  if(el.dataset.scopeGroup){const group=WORKSPACE_LIBRARIES.find(g=>g.id===el.dataset.scopeGroup);form.querySelectorAll('[name="workspace-scope"]').forEach(input=>{if(group.leaves.some(([id])=>id===input.value))input.checked=el.checked;});}
  workspaceSyncScopeParents();return true;
}
function workspaceSubmit(form) {
  if(form.id==='workspace-scope-form') {
    const selected=[...form.querySelectorAll('[name="workspace-scope"]:checked')].map(el=>el.value),old=structuredClone(st.workspaceSearch),previous=[source,searchFolder,searchDate,searchType];
    st.workspaceSearch={scope:selected.length===workspaceLeaves().length?null:selected,sort:form.querySelector('#workspace-sort').value};source='全部资料库';searchFolder=form.querySelector('#workspace-folder')?.value||'全部分组';searchDate=form.querySelector('#workspace-date').value;searchType=form.querySelector('#workspace-type').value;
    if(!workspacePersistFilters()){st.workspaceSearch=old;[source,searchFolder,searchDate,searchType]=previous;const error=form.querySelector('#workspace-filter-error');if(error)error.textContent='筛选尚未保存，原条件未改变。请保留当前选择后重试。';return true;}
    if(route()[0]==='libraries')go('search');else{close();render();}mobileRememberView();tell('筛选已应用，之后搜索将沿用');return true;
  }
  if(form.id!=='workspace-note-form')return false;
  const kind=form.dataset.kind,id=form.dataset.id,item=workspaceRecord(kind,id),draft=workspaceNoteDraft(form),key=kind+':'+id;
  if(!item||(!draft.text.trim()&&!draft.quote.trim())){form.querySelector('.capture-error').textContent='先写下一点想法，或保留一段摘录。';return true;}
  const noteId='n-'+crypto.randomUUID(),note={id:noteId,kind:'note',title:'读后记：'+item.title,text:(draft.quote.trim()?'原文摘录：\n'+draft.quote.trim()+'\n\n':'')+draft.text.trim(),date:localDay(),journalDate:localDay(),createdAt:Date.now(),attachments:[],syncState:'pending',origin:{kind,id,title:item.title,route:item.route}};
  st.notes.unshift(note);delete st.contextNotes[key];
  if(!save()){st.notes.shift();st.contextNotes[key]=draft;form.querySelector('.capture-error').textContent='尚未保存，输入与原速记草稿都保留，请重试。';return true;}
  go('note/'+noteId);tell('笔记已保存，原速记草稿未改变');return true;
}
function workspaceAction(action,key,value) {
  if(action==='workspace-type'){
    if(!WORKSPACE_QUICK_TYPES.some(([type])=>type===key))return true;
    if(workspaceUpdateFilter(()=>searchType=key))requestAnimationFrame(()=>document.querySelector('[data-act="workspace-type:'+key+'"]')?.focus({preventScroll:true}));
    return true;
  }
  if(action==='workspace-clear-filter'){
    if(!['scope','source','folder','date','type'].includes(key))return true;
    workspaceUpdateFilter(()=>{if(key==='scope')workspacePrefs().scope=null;else if(key==='source')source='全部资料库';else if(key==='folder')searchFolder='全部分组';else if(key==='date')searchDate='不限日期';else searchType='全部类型';});
    return true;
  }
  if(action==='search-scope'){workspaceScopeSheet();return true;}
  if(action==='workspace-scope-reset'){workspaceResetScopeDraft();return true;}
  if(action==='clear-scope'||action==='clear-search'){workspaceClearSearch(action==='clear-search');return true;}
  if(action==='workspace-scope-all'){const form=document.querySelector('#workspace-scope-form');form?.querySelectorAll('[name="workspace-scope"]').forEach(el=>el.checked=key==='yes');workspaceSyncScopeParents();snapshotMobileSheet();return true;}
  if(action==='workspace-library'||action==='library'){
    const old=structuredClone(st.workspaceSearch),previous=[source,searchFolder];
    const selected=action==='workspace-library'?[key]:key==='全部资料库'?null:WORKSPACE_LIBRARIES.find(g=>g.title===key)?.leaves.map(([id])=>id);
    if(!selected&&key!=='全部资料库')return true;
    st.workspaceSearch={...workspacePrefs(),scope:selected};source='全部资料库';searchFolder='全部分组';
    if(!workspacePersistFilters()){st.workspaceSearch=old;[source,searchFolder]=previous;return true;}go('search');tell('已切换资料范围；可在筛选中多选');return true;
  }
  if(action==='workspace-agent'){workspaceSendToAgent(key,value);return true;}
  if(action==='workspace-task'){const item=workspaceRecord(key,value);if(item)taskToolsOpenEditor({kind:key,id:value,title:item.title,route:item.route,text:item.body});return true;}
  if(action==='workspace-note'){workspaceNoteSheet(key,value);return true;}
  if(action==='ask'){workspaceSendToAgent(route()[0]==='note'||!docs[key]?'note':'doc',key);return true;}
  if(action==='doc-tools'){
    const kind=route()[0]==='note'||!docs[key]?'note':'doc',starKey=kind==='note'?'note/'+key:key,starred=st.stars[starKey]??(kind==='note'&&!docs[key]?st.stars[key]:undefined)??(kind==='doc'&&key==='d3');
    sheet('这篇资料',group(row(starred?'取消收藏':'收藏','保存在当前浏览器','star','reader-star:'+starKey)+row('复制文字','复制这篇资料的正文','note','copy-doc:'+starKey)+row('记下想法','独立草稿，保留原文关联','note','workspace-note:'+kind+':'+key)+row('带着资料提问','只附上此内容；回复为本地演示','chat','workspace-agent:'+kind+':'+key)+row('转成任务','明确下一步，保留来源','task','workspace-task:'+kind+':'+key)));return true;
  }
  return false;
}
