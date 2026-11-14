import {dailyLimits,demoCards,draftCards,reviewPlan,sessionLimits,type DemoCard} from './flashcard-demo';
export const FLASH_STORAGE_KEY='hub-flashcard-prototype-v1';
export type FlashSession={queue:string[];initialIds:string[];label:string;ratings:number[];revealed:boolean;responses?:Record<string,{choice:number|null;typed:string}>};
type Activity={reviews:number;newCards:number;elapsedMs:number};
export type FlashState={schemaVersion:2;date:string;scenario?:string;due:string[];studied:string[];learned:string[];reviewed:number;newToday:number;dailyLimit:number;sessionLimit:number;session:FlashSession|null;extraNew:number;simulated:boolean;empty:boolean;activity:Record<string,Activity>;dueAt:Record<string,string>;drafts:DemoCard[];acceptedCards:DemoCard[];edits:Record<string,{question:string;answer:string}>;suspended:string[];feedback:{cardId:string;note:string}[]};
export const flashDay=(now:Date)=>new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai'}).format(now);
export const offsetDay=(date:string,days:number)=>{const value=new Date(`${date}T00:00:00Z`);value.setUTCDate(value.getUTCDate()+days);return value.toISOString().slice(0,10);};
const unique=(ids:string[])=>[...new Set(ids)];
const record=(v:unknown):v is Record<string,unknown>=>typeof v==='object'&&v!==null&&!Array.isArray(v);
const count=(v:unknown):v is number=>Number.isSafeInteger(v)&&Number(v)>=0;
const dateKey=(v:unknown):v is string=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(v)&&!Number.isNaN(Date.parse(v+'T00:00:00Z'))&&new Date(v+'T00:00:00Z').toISOString().slice(0,10)===v;
const validCard=(v:unknown):v is DemoCard=>record(v)&&draftCards.some(c=>c.id===v.id)&&typeof v.question==='string'&&v.question.trim().length>0&&v.question.length<=5000&&typeof v.answer==='string'&&v.answer.trim().length>0&&v.answer.length<=10000&&['学习笔记','工程知识'].includes(String(v.deck));
export function cardsForState(state:FlashState):DemoCard[]{return state.empty?[]:[...demoCards,...state.acceptedCards].map(c=>({...c,...state.edits[c.id]}));}
export const effectiveNewLimit=(state:FlashState)=>state.dailyLimit===0?0:state.dailyLimit+state.extraNew;
export function planForState(state:FlashState,limit=state.sessionLimit,deck=''){return reviewPlan(state.due,state.learned,effectiveNewLimit(state),state.newToday,limit,deck,cardsForState(state).filter(c=>!state.suspended.includes(c.id)));}
export function makeFlashState(now=new Date()):FlashState{
 const date=flashDay(now);const activity:Record<string,Activity>={};
 [2,0,4,1,3,2,0].forEach((reviews,i)=>{activity[offsetDay(date,i-6)]={reviews,newCards:reviews?1:0,elapsedMs:reviews*23000};});
 return {schemaVersion:2,date,scenario:'normal',due:demoCards.map(c=>c.id),studied:[],learned:[],reviewed:0,newToday:0,dailyLimit:10,sessionLimit:20,session:null,extraNew:0,simulated:false,empty:false,activity,dueAt:{},drafts:draftCards.map(c=>({...c})),acceptedCards:[],edits:{},suspended:[],feedback:[]};
}
function readSession(value:unknown,state:FlashState):FlashSession|null{
 const ids=new Set(cardsForState(state).map(c=>c.id));const list=(v:unknown):v is string[]=>Array.isArray(v)&&v.every(id=>typeof id==='string'&&ids.has(id));
 if(!record(value)||!list(value.queue)||!list(value.initialIds)||typeof value.label!=='string'||!value.label.trim()||value.label.length>100||!Array.isArray(value.ratings)||!value.ratings.every(v=>Number.isInteger(v)&&v>=1&&v<=4)||typeof value.revealed!=='boolean')return null;
 const queue=unique(value.queue),initialIds=unique(value.initialIds);
 if(!initialIds.length||queue.some(id=>!initialIds.includes(id))||initialIds.some(id=>state.due.includes(id)&&!queue.includes(id)&&!state.suspended.includes(id)))return null;
 if(['学习笔记','工程知识'].includes(value.label)&&initialIds.some(id=>cardsForState(state).find(c=>c.id===id)?.deck!==value.label))return null;
 const responses:Record<string,{choice:number|null;typed:string}>={};if(record(value.responses))for(const[id,response]of Object.entries(value.responses)){const card=cardsForState(state).find(c=>c.id===id);if(card&&record(response))responses[id]={choice:Number.isInteger(response.choice)&&Number(response.choice)>=0&&Number(response.choice)<(card.choices?.length??0)?Number(response.choice):null,typed:typeof response.typed==='string'?response.typed.slice(0,1000):''};}
 return {queue,initialIds,label:value.label,ratings:value.ratings as number[],revealed:Boolean(queue.length&&value.revealed),responses};
}
export function loadFlashState(raw:string|null,now=new Date()):FlashState{
 const fallback=makeFlashState(now);if(!raw)return fallback;
 try{const value:unknown=JSON.parse(raw);if(!record(value)||(value.schemaVersion!==undefined&&value.schemaVersion!==2)||!dateKey(value.date)||!count(value.reviewed)||!count(value.newToday)||typeof value.dailyLimit!=='number'||!dailyLimits.includes(value.dailyLimit)||typeof value.sessionLimit!=='number'||!sessionLimits.includes(value.sessionLimit))return fallback;
  const cleanCards=(values:unknown[])=>[...new Map(values.filter(validCard).map(c=>[c.id,{...draftCards.find(seed=>seed.id===c.id)!,question:c.question,answer:c.answer,deck:c.deck}])).values()];const accepted=Array.isArray(value.acceptedCards)?cleanCards(value.acceptedCards):[];
  const state:FlashState={...makeFlashState(new Date(value.date+'T12:00:00+08:00')),date:value.date,reviewed:value.reviewed,newToday:value.newToday,dailyLimit:value.dailyLimit,sessionLimit:value.sessionLimit,acceptedCards:accepted,simulated:value.simulated===true,empty:value.empty===true};
  const ids=new Set(cardsForState(state).map(c=>c.id));const validIds=(v:unknown):v is string[]=>Array.isArray(v)&&v.every(id=>typeof id==='string'&&ids.has(id));
  if(!validIds(value.due)||!validIds(value.studied))return fallback;state.due=unique(value.due);if(value.schemaVersion===undefined)state.due=unique([...state.due,...demoCards.filter(c=>!['knowledge','hub','engineering','decision'].includes(c.id)).map(c=>c.id)]);state.studied=unique(value.studied);state.learned=validIds(value.learned)?unique(value.learned):state.studied;
  state.extraNew=count(value.extraNew)?Math.min(100,value.extraNew):0;state.suspended=validIds(value.suspended)?unique(value.suspended):[];
  state.drafts=Array.isArray(value.drafts)?cleanCards(value.drafts).filter(c=>!accepted.some(a=>a.id===c.id)):state.drafts;
  if(record(value.edits))for(const[id,edit]of Object.entries(value.edits))if(ids.has(id)&&record(edit)&&typeof edit.question==='string'&&edit.question.trim()&&edit.question.length<=5000&&typeof edit.answer==='string'&&edit.answer.trim()&&edit.answer.length<=10000)state.edits[id]={question:edit.question,answer:edit.answer};
  if(record(value.activity)){state.activity={};for(const[date,a]of Object.entries(value.activity))if(dateKey(date)&&record(a)&&count(a.reviews)&&count(a.newCards)&&count(a.elapsedMs))state.activity[date]={reviews:a.reviews,newCards:a.newCards,elapsedMs:a.elapsedMs};}
  if(state.reviewed||state.newToday||Object.hasOwn(state.activity,state.date))state.activity[state.date]={reviews:state.reviewed,newCards:state.newToday,elapsedMs:state.activity[state.date]?.elapsedMs??0};
  if(record(value.dueAt))for(const[id,date]of Object.entries(value.dueAt))if(ids.has(id)&&typeof date==='string'&&!Number.isNaN(Date.parse(date)))state.dueAt[id]=date;
  if(Array.isArray(value.feedback))state.feedback=value.feedback.filter((f):f is {cardId:string;note:string}=>record(f)&&typeof f.cardId==='string'&&ids.has(f.cardId)&&typeof f.note==='string'&&f.note.length<=1000).slice(-50);
  state.scenario=typeof value.scenario==='string'&&Object.keys(scenarios).includes(value.scenario)?value.scenario:'normal';state.session=readSession(value.session,state);return reconcileFlashSession(reconcileFlashDay(state,now));
 }catch{return fallback;}
}
export function reconcileFlashDay(state:FlashState,now=new Date(),force=false):FlashState{
 if(state.simulated&&!force)return state;const date=flashDay(now);if(date===state.date)return state;
 const due=cardsForState(state).filter(c=>!state.dueAt[c.id]||flashDay(new Date(state.dueAt[c.id]))<=date).map(c=>c.id);
 return {...state,date,due,studied:[],reviewed:state.activity[date]?.reviews??0,newToday:state.activity[date]?.newCards??0,extraNew:0,session:null,activity:{...state.activity,[date]:state.activity[date]??{reviews:0,newCards:0,elapsedMs:0}}};
}
export function buildFlashSession(state:FlashState,deck=''):FlashSession|null{
 const ids=planForState(state,state.sessionLimit,deck).session.map(c=>c.id);return ids.length?{queue:ids,initialIds:[...ids],label:deck||'今日待复习',ratings:[],revealed:false,responses:{}}:null;
}
export function reconcileFlashSession(state:FlashState):FlashState{
 const s=state.session;if(!s)return state;let allowance=state.dailyLimit===0?Infinity:Math.max(0,effectiveNewLimit(state)-state.newToday);const removed=new Set<string>();
 const cards=cardsForState(state);const queue=unique(s.queue).filter(id=>{const card=cards.find(c=>c.id===id);if(!card||state.suspended.includes(id)){removed.add(id);return false;}if(!state.due.includes(id))return false;if(!card.isNew||state.learned.includes(id))return true;if(allowance-->0)return true;removed.add(id);return false;});
 const initialIds=s.initialIds.filter(id=>!removed.has(id));if(!initialIds.length)return {...state,session:null};const revealed=Boolean(queue.length&&queue[0]===s.queue[0]&&s.revealed);
 return queue.length===s.queue.length&&queue.every((id,i)=>id===s.queue[i])&&initialIds.length===s.initialIds.length&&revealed===s.revealed?state:{...state,session:{...s,queue,initialIds,revealed}};
}
export const sampleIntervals=['不到1分钟','10分钟','1天','4天'];
export function applyFlashRating(state:FlashState,rating:number,elapsedMs=0):FlashState{
 if(!Number.isInteger(rating)||rating<1||rating>4)return state;const fresh=reconcileFlashSession(state),s=fresh.session,card=cardsForState(fresh).find(c=>c.id===s?.queue[0]);if(!s?.revealed||!card)return fresh;
 const newStudy=card.isNew&&!fresh.learned.includes(card.id),remaining=s.queue.slice(1);const reviews=fresh.reviewed+1,newCards=fresh.newToday+Number(newStudy);const base=new Date(`${state.date}T12:00:00+08:00`).getTime();
 return reconcileFlashSession({...fresh,due:rating===1?fresh.due:fresh.due.filter(id=>id!==card.id),studied:unique([...fresh.studied,card.id]),learned:unique([...fresh.learned,card.id]),reviewed:reviews,newToday:newCards,dueAt:{...fresh.dueAt,[card.id]:new Date(base+[30000,600000,86400000,345600000][rating-1]).toISOString()},activity:{...fresh.activity,[fresh.date]:{reviews,newCards,elapsedMs:(fresh.activity[fresh.date]?.elapsedMs??0)+Math.max(0,Math.min(300000,elapsedMs))}},session:{...s,queue:rating===1?[...remaining,card.id]:remaining,ratings:[...s.ratings,rating],revealed:false,responses:{...s.responses,[card.id]:{choice:null,typed:''}}}});
}
export function restoreFlashRating(current:FlashState,before:FlashState):FlashState{return current.date!==before.date?current:reconcileFlashSession({...before,dailyLimit:current.dailyLimit,sessionLimit:current.sessionLimit,extraNew:current.extraNew,drafts:current.drafts,acceptedCards:current.acceptedCards,edits:current.edits,suspended:current.suspended,feedback:current.feedback});}
export function getFlashCardStatus(card:DemoCard,state:FlashState):'new'|'due'|'done'|'suspended'{return state.suspended.includes(card.id)?'suspended':!state.due.includes(card.id)?'done':card.isNew&&!state.learned.includes(card.id)?'new':'due';}
export function nextDue(state:FlashState){return Object.entries(state.dueAt).filter(([id])=>!state.suspended.includes(id)&&!state.due.includes(id)).map(([,date])=>date).sort((a,b)=>Date.parse(a)-Date.parse(b))[0]??null;}
export function addExtraNew(state:FlashState,n:number){return reconcileFlashSession({...state,extraNew:Math.min(100,state.extraNew+Math.max(0,Math.floor(n)))});}
export function moveDraft(state:FlashState,id:string):FlashState{const card=state.drafts.find(c=>c.id===id);if(!card||state.acceptedCards.some(c=>c.id===id))return state;return {...state,drafts:state.drafts.filter(c=>c.id!==id),acceptedCards:[...state.acceptedCards,card],due:[...state.due,id]};}
export function activityDays(state:FlashState){return Array.from({length:7},(_,i)=>{const date=offsetDay(state.date,i-6);return {date,...(state.activity[date]??{reviews:0,newCards:0,elapsedMs:0})};});}
export function studyStreak(state:FlashState){let day=state.date;if(!(state.activity[day]?.reviews>0))day=offsetDay(day,-1);let total=0;while(state.activity[day]?.reviews>0&&total<366){total++;day=offsetDay(day,-1);}return {days:total,today:state.reviewed>0};}
export function estimateMinutes(state:FlashState,n:number){const samples=Object.values(state.activity).filter(a=>a.reviews>0&&a.elapsedMs>0);const total=samples.reduce((sum,a)=>sum+a.reviews,0);return total>=5&&n>0?Math.max(1,Math.ceil(samples.reduce((sum,a)=>sum+a.elapsedMs,0)/total*n/60000)):null;}
export function futureDue(state:FlashState){return Array.from({length:7},(_,i)=>{const date=offsetDay(state.date,i+1);return {date,count:cardsForState(state).filter(c=>state.learned.includes(c.id)&&!state.suspended.includes(c.id)&&state.dueAt[c.id]&&flashDay(new Date(state.dueAt[c.id]))===date).length};});}
export const scenarios={normal:'按日期生成',limit:'到期多于本轮上限',quota:'新卡额度用尽',gap:'连续学习断档',empty:'空牌库',sparse:'用时样本不足',future:'未来到期'};
export function makeScenario(name:keyof typeof scenarios,date=flashDay(new Date())):FlashState{
 const state={...makeFlashState(new Date(date+'T12:00:00+08:00')),simulated:true,scenario:name};
 if(name==='limit')state.sessionLimit=10;
 if(name==='quota'){const news=demoCards.filter(c=>c.isNew);state.dailyLimit=5;state.newToday=5;state.reviewed=5;state.studied=news.slice(0,5).map(c=>c.id);state.learned=[...state.studied];state.due=news.slice(5).map(c=>c.id);state.activity[date]={reviews:5,newCards:5,elapsedMs:90000};}
 if(name==='gap'){state.activity[offsetDay(date,-1)]={reviews:0,newCards:0,elapsedMs:0};state.activity[offsetDay(date,-3)]={reviews:320,newCards:3,elapsedMs:6400000};}
 if(name==='empty'){state.empty=true;state.due=[];state.drafts=[];state.activity={};}
 if(name==='sparse')state.activity={};
 if(name==='future'){const learned=demoCards.filter(c=>!c.isNew);state.learned=learned.map(c=>c.id);learned.forEach((c,i)=>{state.dueAt[c.id]=offsetDay(date,i+1)+'T12:00:00+08:00';});state.due=demoCards.filter(c=>c.isNew).map(c=>c.id);}
 return state;
}
