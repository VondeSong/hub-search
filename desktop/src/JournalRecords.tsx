import { invoke } from "@tauri-apps/api/core";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { userProfileStorage } from "./UserProfileStorage";
import { normalizeResults } from "./SearchResultNormalization";
import type { SearchResult } from "./SearchTypes";
import { QUICK_JOURNAL_UPDATED } from "./QuickJournalEvents";
import { useJournalViews, type JournalViewConfig } from "./JournalViews";

export type JournalRecordFilter = "all" | "pinned" | "attachments" | "untagged";
export const journalRecordFilters = { all: "全部记录", pinned: "置顶", attachments: "有附件", untagged: "无标签" };
export type QuickJournalItem = { record: {version:1;id:string;date:string;text:string;attachments:Array<{hash:string;name:string;size:number;image:boolean}>}; body:string; uploaded:boolean; applied:boolean; libraryId:string; path:string; namespace:string;sourceError?:string };
export type JournalRecordIndex = {id:string;date:string;libraryId:string;preview?:SearchResult;documentId?:string;path?:string;representedByQuick?:boolean;matchesQuery?:boolean;hasAttachments:boolean;hasTags:boolean};
export const journalDocumentKey=(library:string,id:string)=>JSON.stringify([library,id]);
const PIN_KEY="hub.journal.record-pins.v1";
export function journalRecordMatches(item:Pick<JournalRecordIndex,"id"|"hasAttachments"|"hasTags">,filter:JournalRecordFilter,pins:ReadonlySet<string>){return filter==="pinned"?pins.has(item.id):filter==="attachments"?item.hasAttachments:filter==="untagged"?!item.hasTags:true;}
export function journalHeatLevel(count:number){return !Number.isFinite(count)||count<=0?0:count===1?1:count===2?2:count<=4?3:4;}
export function journalIndexInView(item:JournalRecordIndex,view:JournalViewConfig,scope:string[]|null,includePeriod=true){return (scope===null||scope.includes(item.libraryId))&&(view.libraries===null||view.libraries.includes(item.libraryId))&&(!includePeriod||view.period==="all"||(view.period==="day"?item.date===view.day:item.date.startsWith(view.month)));}
function readPins(){try{const value=JSON.parse(userProfileStorage.getItem(PIN_KEY)||"[]");return new Set<string>(Array.isArray(value)?value.filter(v=>typeof v==="string"):[]);}catch{return new Set<string>();}}
const EMPTY={items:[] as QuickJournalItem[],index:[] as JournalRecordIndex[],pins:new Set<string>(),error:"",loading:false,refresh:()=>{},togglePin:(_id:string)=>{}};
const Context=createContext(EMPTY);
export function JournalRecordsProvider({enabled,dataVersion,scope,children}:{enabled:boolean;dataVersion:string;scope:string[]|null;children:ReactNode}){
 const view=useJournalViews(),query=view?.view.query||"";
 const [items,setItems]=useState<QuickJournalItem[]>([]),[index,setIndex]=useState<JournalRecordIndex[]>([]),[pins,setPins]=useState(readPins),[error,setError]=useState(""),[loading,setLoading]=useState(false),[revision,setRevision]=useState(0);
 const refresh=()=>setRevision(n=>n+1),scopeKey=JSON.stringify(scope);
 useEffect(()=>{if(!enabled)return;let live=true;setLoading(true);setError("");setItems([]);setIndex([]);
  void Promise.all([invoke<{items:QuickJournalItem[];error:string}>("list_quick_journal"),invoke<JournalRecordIndex[]>("journal_record_index",{spaceIds:scope,query}),invoke<{settings:{libraryId:string}}>("get_quick_journal_settings")]).then(([quick,docs,settings])=>{if(!live)return;const values=quick.items.map(item=>({...item,libraryId:item.libraryId||settings.settings.libraryId})).filter(item=>scope===null||scope.includes(item.libraryId));setItems(values);setIndex([...docs.map(item=>({...item,preview:item.preview?normalizeResults([item.preview])[0]:undefined})),...values.map(item=>({id:item.record.id,date:item.record.date,libraryId:item.libraryId,path:item.path,matchesQuery:`${item.body} ${item.record.attachments.map(a=>a.name).join(" ")}`.toLowerCase().includes(query.trim().toLowerCase()),hasAttachments:item.record.attachments.length>0,hasTags:/(?:^|\s)#[^\s#]+/u.test(item.body)}))]);setError(quick.error||"");}).catch(e=>{if(live)setError(String(e));}).finally(()=>{if(live)setLoading(false);});return()=>{live=false;};
 },[enabled,dataVersion,revision,scopeKey,query]);
 useEffect(()=>{if(!enabled)return;window.addEventListener(QUICK_JOURNAL_UPDATED,refresh);return()=>{window.removeEventListener(QUICK_JOURNAL_UPDATED,refresh);};},[enabled]);
 const togglePin=(id:string)=>{const next=new Set(pins);if(next.has(id))next.delete(id);else next.add(id);try{userProfileStorage.setItem(PIN_KEY,JSON.stringify([...next]));setPins(next);}catch(e){setError(`置顶保存失败：${String(e)}`);}};
 return <Context.Provider value={{items,index,pins,error,loading,refresh,togglePin}}>{children}</Context.Provider>;
}
export const useJournalRecords=()=>useContext(Context);
