'use strict';

let journalPicked = new Set(), journalAdvanced = {period:'all',start:'',end:'',tagMode:'all',tags:[],more:[]}, journalSearched = false;
const journalSortLabels = {'date-desc':'记录日期，从新到旧','date-asc':'记录日期，从旧到新','edit-desc':'编辑时间，从新到旧','edit-asc':'编辑时间，从旧到新'};
function journalCompare(a,b) {
  const key=journalStore().sort||'date-desc', direction=key.endsWith('asc')?1:-1;
  const av=key.startsWith('edit')?(a.modifiedAt||Date.parse(a.date)):(a.date||''), bv=key.startsWith('edit')?(b.modifiedAt||Date.parse(b.date)):(b.date||'');
  return Number(journalStore().pins.includes(b.id))-Number(journalStore().pins.includes(a.id)) || direction*(typeof av==='number'?av-bv:String(av).localeCompare(String(bv))) || a.id.localeCompare(b.id);
}
function journalAdvancedMatches(n) {
  const f=journalAdvanced,today=localDay(),d=new Date(today+'T12:00:00');d.setDate(d.getDate()-(d.getDay()+6)%7);
  const week=[d.getFullYear(),String(d.getMonth()+1).padStart(2,'0'),String(d.getDate()).padStart(2,'0')].join('-'),tags=journalTags(n.text),attachments=recordAttachments(n);
  return (f.period!=='week'||n.date>=week&&n.date<=today) && (f.period!=='month'||n.date.startsWith(today.slice(0,7))) && (f.period!=='custom'||(!f.start||n.date>=f.start)&&(!f.end||n.date<=f.end)) &&
    (f.period!=='anniversary'||n.date.slice(5)===today.slice(5)&&n.date<today) && (f.tagMode!=='untagged'||!tags.length) &&
    (f.tagMode!=='include'||f.tags.some(t=>tags.includes(t))) && (f.tagMode!=='exclude'||!f.tags.some(t=>tags.includes(t))) && f.more.every(key=>key==='images'?attachments.some(a=>a.image)||capturePhotos(n.photos).length:key==='links'?/https?:\/\//i.test(n.text):attachments.some(a=>/\.(mp3|wav|m4a|aac|ogg|opus|flac)$/i.test(a.name)));
}
function journalViews() {
  sheet('日志视图','<div class="journal-view-options">'+plain('选择笔记','journal-select-start','check')+'<details><summary>排序方式<span>'+esc(journalSortLabels[journalStore().sort||'date-desc'])+'</span></summary>'+Object.entries(journalSortLabels).map(([key,label])=>'<button type="button" data-act="journal-sort:'+key+'" aria-pressed="'+String((journalStore().sort||'date-desc')===key)+'">'+esc(label)+((journalStore().sort||'date-desc')===key?ico('check',16):'')+'</button>').join('')+'</details><p class="fine">未记录编辑时间的旧记录按记录日期排列。</p></div>');
}
function journalSearchHeader() {
  return '<form id="journal-search-form" class="journal-search-heading"><label>'+ico('search',19)+'<input id="journal-detail-query" type="search" aria-label="搜索日志正文" placeholder="搜索" value="'+esc(journalQuery)+'">'+iconBtn('展开日志筛选','journal-search-filters','filter')+'</label><button type="button" data-act="back">取消</button></form>';
}
function journalSearchPage() {
  const active=journalSearched||journalQuery||journalAdvanced.period!=='all'||journalAdvanced.tagMode!=='all'||journalAdvanced.more.length;
  return '<section class="journal-studio journal-search-page">'+(journalStore().searchFilters?'<div class="journal-search-filters">'+['日期','标签','更多'].map((label,i)=>'<button type="button" data-act="journal-search-filter:'+['date','tags','more'][i]+'">'+label+ico('chevronDown',13)+'</button>').join('')+'</div>':'')+'<div class="journal-quick-search"><p>快捷搜索</p><div>'+[['无标签','untagged','tag'],['有链接','links','link'],['有图片','images','image'],['有语音','audio','mic'],['那年今日','anniversary','calendar']].map(([label,key,icon])=>plain(label,'journal-search-quick:'+key,icon)).join('')+'</div></div><div id="journal-search-results">'+(active?journalSearchResults():'')+'</div></section>';
}
function journalSearchResults() {
  const q=journalQuery.toLocaleLowerCase(),found=journalStudioRecords().filter(n=>(n.text+' '+recordAttachments(n).map(a=>a.name).join(' ')).toLocaleLowerCase().includes(q)&&journalAdvancedMatches(n));
  return '<div class="journal-search-result-summary"><span>'+found.length+' 条记录</span>'+plain('清除条件','journal-search-reset')+'</div><div id="journal-search-feed">'+(found.map(journalStudioCard).join('')||'<p class="empty-state">没有符合条件的记录</p>')+'</div>';
}
function journalSearchFilter(kind) {
  const f=journalAdvanced, tags=[...new Set(journalStudioRecords().flatMap(n=>journalTags(n.text)))];
  let body='';
  if(kind==='date')body='<div class="journal-filter-choices">'+[['all','不限时间'],['week','本周'],['month','本月']].map(([key,label])=>'<label><input type="radio" name="period" value="'+key+'"'+(f.period===key?' checked':'')+'>'+label+'</label>').join('')+'</div><div class="journal-filter-dates"><label>开始日期<input type="date" name="start" value="'+esc(f.start)+'"></label><span>—</span><label>结束日期<input type="date" name="end" value="'+esc(f.end)+'"></label></div>';
  if(kind==='tags')body='<div class="journal-filter-choices">'+[['all','全部内容'],['untagged','无标签'],['include','包含指定标签'],['exclude','排除指定标签']].map(([key,label])=>'<label><input type="radio" name="tagMode" value="'+key+'"'+(f.tagMode===key?' checked':'')+'>'+label+'</label>').join('')+'</div><fieldset class="journal-filter-tags"><legend>指定标签</legend>'+tags.map(t=>'<label><input type="checkbox" name="tags" value="'+esc(t)+'"'+(f.tags.includes(t)?' checked':'')+'>#'+esc(t)+'</label>').join('')+'</fieldset>';
  if(kind==='more')body='<div class="journal-filter-more">'+[['images','有图片'],['links','有链接'],['audio','有语音']].map(([key,label])=>'<label>'+label+'<input type="checkbox" name="more" value="'+key+'"'+(f.more.includes(key)?' checked':'')+'></label>').join('')+'</div>';
  sheet({date:'日期范围',tags:'标签范围',more:'更多条件'}[kind],'<form id="journal-search-filter-form" data-kind="'+kind+'">'+body+'<p class="capture-error" role="alert"></p><button type="submit" class="btn journal-filter-confirm">确定</button></form>');
}
function journalSelectHeader() {return '<div class="journal-selection-heading"><strong>已选中 '+journalPicked.size+' 条笔记</strong>'+plain('完成','back')+'</div>';}
function journalSelectionDock() {
  return '<div class="journal-batch-dock">'+[['添加标签','tag','tag'],['复制全部','copy','copy'],['删除','delete','trash']].map(([label,key,icon])=>'<button type="button" data-act="journal-batch:'+key+'"'+(!journalPicked.size?' disabled':'')+'>'+ico(icon,20)+'<span>'+label+'</span></button>').join('')+'</div>';
}
function journalBatchUpdate(kind,text='') {
  const targets=journalStudioRecords().filter(n=>journalPicked.has(n.id));
  if(!targets.length)return false;
  const tags=[...new Set(text.trim().split(/\s+/u).filter(Boolean).map(t=>t.replace(/^#+/,'')))];
  if(kind==='tag'&&(!tags.length||tags.some(t=>journalTags('#'+t)[0]!==t))){tell('请输入有效标签，多个标签用空格分开');return false;}
  return journalTransaction(()=>{
    const j=journalStore();
    for(const n of targets){
      if(kind==='delete'){j.trash[n.id]={at:Date.now()};continue;}
      const missing=tags.filter(t=>!journalTags(n.text).includes(t));if(!missing.length)continue;
      (j.history[n.id]||=[]).push({...structuredClone(n),savedAt:Date.now()});
      const next={...n,text:n.text+'\n'+missing.map(t=>'#'+t).join(' '),revision:(n.revision||0)+1,modifiedAt:Date.now(),syncState:'pending'};
      if(n.demo)j.overrides[n.id]=next;else st.notes=st.notes.map(v=>v.id===n.id?next:v);
    }
  });
}
function journalFeedToolsAction(a,key) {
  if(a==='journal-filters'){journalViews();return true;}
  if(a==='journal-sort'){if(journalTransaction(()=>journalStore().sort=key)){close();render();}return true;}
  if(a==='journal-select-start'){journalPicked=new Set();go('journal-select');return true;}
  if(a==='journal-pick'){journalPicked.has(key)?journalPicked.delete(key):journalPicked.add(key);const y=pageScroll();render();window.scrollTo(0,y);return true;}
  if(a==='journal-search'){journalQuery='';journalAdvanced={period:'all',start:'',end:'',tagMode:'all',tags:[],more:[]};journalSearched=false;go('journal-search');requestAnimationFrame(()=>document.querySelector('#journal-detail-query')?.focus());return true;}
  if(a==='journal-search-filters'){journalStore().searchFilters=!journalStore().searchFilters;render();return true;}
  if(a==='journal-search-filter'){document.activeElement?.blur();journalSearchFilter(key);return true;}
  if(a==='journal-search-reset'){journalQuery='';journalAdvanced={period:'all',start:'',end:'',tagMode:'all',tags:[],more:[]};journalSearched=false;render();return true;}
  if(a==='journal-search-quick'){journalAdvanced={period:key==='anniversary'?'anniversary':'all',start:'',end:'',tagMode:key==='untagged'?'untagged':'all',tags:[],more:['images','links','audio'].includes(key)?[key]:[]};journalSearched=true;document.activeElement?.blur();render();return true;}
  if(a==='journal-batch'){
    if(!journalPicked.size)return true;
    if(key==='copy'){void journalCopy(journalStudioRecords().filter(n=>journalPicked.has(n.id)).map(n=>n.text).join('\n\n---\n\n'));return true;}
    if(key==='tag')sheet('添加标签','<form id="journal-batch-tag-form"><label>标签<input name="tags" required placeholder="#标签，可输入多个" maxlength="500"></label><button class="btn" type="submit">确定</button></form>');
    if(key==='delete')sheet('删除所选记录','<p>将 '+journalPicked.size+' 条记录移到回收站？正文、附件和历史均保留。</p>'+btn('移到回收站','journal-batch-delete','danger')+plain('取消','close'));
    return true;
  }
  if(a==='journal-batch-delete'){if(journalBatchUpdate('delete')){journalPicked.clear();go('logs');tell('已移到回收站');}return true;}
  return false;
}
document.addEventListener('input',event=>{if(event.target.id==='journal-detail-query'){journalQuery=event.target.value;journalSearched=Boolean(journalQuery);document.querySelector('#journal-search-results').innerHTML=journalSearched?journalSearchResults():'';void hydrateAttachmentImages();}});
document.addEventListener('click',event=>{const card=event.target.closest('.journal-studio-card');if(route()[0]==='journal-select'&&card){event.preventDefault();event.stopImmediatePropagation();journalFeedToolsAction('journal-pick',card.dataset.recordId);}},true);
document.addEventListener('change',event=>{
  const form=event.target.closest('#journal-search-filter-form');if(!form||form.dataset.kind!=='date')return;
  if(event.target.name==='period')for(const input of form.querySelectorAll('input[type=date]'))input.value='';
  if(['start','end'].includes(event.target.name))for(const input of form.querySelectorAll('input[name=period]'))input.checked=false;
});
document.addEventListener('submit',event=>{
  const form=event.target;if(!['journal-search-form','journal-search-filter-form','journal-batch-tag-form'].includes(form.id))return;
  event.preventDefault();event.stopImmediatePropagation();
  const data=new FormData(form);
  if(form.id==='journal-search-form'){journalSearched=true;document.activeElement?.blur();document.querySelector('#journal-search-results').innerHTML=journalSearchResults();return;}
  if(form.id==='journal-batch-tag-form'){if(journalBatchUpdate('tag',String(data.get('tags')))){close();render();journalQueueSync();}return;}
  const kind=form.dataset.kind,next=structuredClone(journalAdvanced);
  if(kind==='date'){next.start=String(data.get('start')||'');next.end=String(data.get('end')||'');if(next.start&&next.end&&next.start>next.end){form.querySelector('[role=alert]').textContent='结束日期不能早于开始日期';return;}next.period=next.start||next.end?'custom':String(data.get('period')||'all');}
  if(kind==='tags'){next.tagMode=String(data.get('tagMode')||'all');next.tags=data.getAll('tags');if(['include','exclude'].includes(next.tagMode)&&!next.tags.length){form.querySelector('[role=alert]').textContent='请选择至少一个标签';return;}}
  if(kind==='more')next.more=data.getAll('more');
  journalAdvanced=next;journalSearched=true;close();render();
},true);
