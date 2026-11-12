export const SIDEBAR_MIN=200, SIDEBAR_MAX=420;
export const defaultSidebarWidth=(panel:string)=>panel==="libraries"?248:panel==="flashcards"?232:224;
export const clampSidebarWidth=(value:number)=>Math.max(SIDEBAR_MIN,Math.min(SIDEBAR_MAX,Math.round(value)));
export function parseSidebarWidths(raw:string|null):Record<string,number>{
 try{const value=JSON.parse(raw||"{}");if(!value||typeof value!=="object"||Array.isArray(value))return {};
 return Object.fromEntries(Object.entries(value).filter(([,n])=>typeof n==="number"&&Number.isFinite(n)).map(([key,n])=>[key,clampSidebarWidth(n as number)]));}catch{return {};}
}
export type JournalActivity={date:string;count:number;sources:number};
export function journalHeatLevel(count:number){return !Number.isFinite(count)||count<=0?0:count===1?1:count===2?2:count<=4?3:4;}
export function journalActivity(entries:Array<{id:string;date:string;library?:string}>):JournalActivity[]{
 const days=new Map<string,{ids:Set<string>;libraries:Set<string>}>();
 for(const entry of entries){if(!/^\d{4}-\d{2}-\d{2}$/.test(entry.date))continue;const day=days.get(entry.date)||{ids:new Set<string>(),libraries:new Set<string>()};if(!day.ids.has(entry.id)){day.ids.add(entry.id);day.libraries.add(entry.library||"OS");}days.set(entry.date,day);}
 return [...days].map(([date,day])=>({date,count:day.ids.size,sources:day.libraries.size}));
}
