import { createContext, createRef, lazy, Suspense, useContext, useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Layers,MessageSquare } from "lucide-react";
import "./StandaloneAgentLauncher.css";
import { runtimeCapabilities } from "./RuntimePlatform";
import type { SearchResult } from "./SearchTypes";
import { AgentCitationPreview, type CitationLocation } from "./AgentCitationPreview";
export const AgentCitationContext=createContext<{value:CitationLocation|null;show:(value:CitationLocation|null)=>void}|null>(null);
export function AgentCitationBody(){
 const citation=useContext(AgentCitationContext);
 return citation?.value ? <div className="agent-body-citation"><AgentCitationPreview value={citation.value}/></div> : null;
}
const Source = lazy(() => import("./AgentInvestigation").then(m => ({ default:m.PersistentSourceInvestigation })));
const Standalone = lazy(() => import("./AgentInvestigation").then(m => ({ default:m.StandaloneInvestigation })));
const Reading = lazy(() => import("./AgentInvestigation").then(m => ({ default:m.PersistentReadingInvestigation })));
const Existing = lazy(() => import("./AgentInvestigation").then(m => ({ default:m.ExistingWorkInvestigation })));
const Extra = lazy(() => import("./AgentInvestigation").then(m => ({default:m.ExtraInvestigation})));
export type Entry = { result:SearchResult } | { itemKey:string; title?:string } | null;
export type AgentQuestion={id:string;text:string};
type PanelEntry=Entry|{workId:string;question?:AgentQuestion};
export type TextMaterial={kind:"text"|"flashcard"|"conversation";title:string;text:string;file?:boolean;conversationId?:string;selectedFromChat?:true};
export type ExtraAgentControls = {add: (entry: TextMaterial) => boolean; focus: () => void};
export type ExtraAgentEntry = {open: boolean; firstQuote?: TextMaterial; controls: RefObject<ExtraAgentControls | null>};
export type ExtraAgentPanelApi = {open: (entry?: TextMaterial) => boolean; focusMain: () => void; isExtraOpen: boolean};
export const AgentExtraPanelContext = createContext<ExtraAgentPanelApi | null>(null);
export const AgentTextMaterialContext=createContext<{selection:TextMaterial|null;clearSelection:()=>void;pending:TextMaterial|null;setPending:(value:TextMaterial|null)=>void}|null>(null);
export type AgentTagRequest={tagId:string;label:string;task:"definition"|"missing"|"relations"};
export const AgentTagRequestContext=createContext<{pending:AgentTagRequest|null;setPending:(v:AgentTagRequest|null)=>void}|null>(null);
export const AgentPanelContext = createContext<((entry:PanelEntry)=>void)|null>(null);
export const AgentAccountVisibleContext = createContext(true);
export const AgentBrowsingContext = createContext<{entry:Entry;setEntry:React.Dispatch<React.SetStateAction<Entry>>}|null>(null);
export function AgentPanelProvider({children}:{children:ReactNode}) {
 const [browsing,setBrowsing]=useState<Entry>(null);
 const [tagRequest,setTagRequest]=useState<AgentTagRequest|null>(null);
 const [citation,setCitation]=useState<CitationLocation|null>(null);
 const [owner,setOwner]=useState("initial");
 const [entries,setEntries]=useState<Record<string,PanelEntry|undefined>>({});
 const [extraEntries,setExtraEntries] = useState<Record<string, ExtraAgentEntry>>({});
 const routes=useRef(new Map<string,string>());
 const freshOwners=useRef(new Set<string>());
 const entry=entries[owner];
 const [request,setRequest]=useState(0);
 const [selection,setSelection]=useState<TextMaterial|null>(null),[pending,setPending]=useState<TextMaterial|null>(null);
 useEffect(()=>{setSelection(null);},[browsing]);
 useEffect(()=>{
  const capture=()=>{
   const value=window.getSelection();if(!value || value.isCollapsed)return;
   const node=value.anchorNode?.parentElement,root=node?.closest('.preview-card,.flashcards-card-modal,.flashcards-review-card');
   if(!root || !value.focusNode || !root.contains(value.focusNode) || node?.closest('.agent-panel,input,textarea,[contenteditable=true]'))return;
   const text=value.toString().trim();if(text)setSelection({kind:"text",text,title:root.querySelector('.preview-title,h1,h2')?.textContent?.trim()||"当前页面"});
  };
  document.addEventListener('selectionchange',capture);return()=>document.removeEventListener('selectionchange',capture);
 },[]);
 useEffect(()=>{
  const change=(event:Event)=>{
   const detail=(event as CustomEvent<{scopeId?:string;fromScopeId?:string;selected?:string;fromSelected?:string;newConversation:boolean}>).detail;
   if(!detail)return;
   const scope=detail.scopeId||detail.selected;
   if(!scope || !/^[a-zA-Z0-9_-]{1,80}$/.test(scope))return;
   const route=(detail.selected||"desktop")+":"+scope;
   if(detail.fromScopeId)routes.current.set((detail.fromSelected||"desktop")+":"+detail.fromScopeId,owner);
   if(!detail.newConversation){routes.current.set(route,owner);return;}
   const next=routes.current.get(route)||`account:${route}`;
   routes.current.set(route,next);
   if(next!=="initial")freshOwners.current.add(next);
   setEntries(current=>entry!==undefined && current[next]===undefined?{...current,[next]:null}:current);
   setOwner(next);setCitation(null);setSelection(null);setPending(null);setTagRequest(null);
  };
  window.addEventListener("hub:agent-account-changed",change);
  return()=>window.removeEventListener("hub:agent-account-changed",change);
 },[owner,entry]);
 const open=(next:PanelEntry)=>{setEntries(values=>{const current=values[owner];return {...values,[owner]:next&&'workId' in next?next:current===undefined?next:current&&next&&'result' in current&&'result' in next?next:current};});setRequest(n=>n+1);};
 const openExtra=(quote?: TextMaterial) => {
  const entry = extraEntries[owner];
  const accepted = quote ? (entry?.controls.current?.add(quote) ?? true) : true;
  setExtraEntries(current => ({...current,[owner]: entry ? {...entry,open:true} : {open:true,...(quote?{firstQuote:quote}:{}),controls:createRef<ExtraAgentControls>()}}));
  if (entry) requestAnimationFrame(() => entry.controls.current?.focus());
  return accepted;
 };
 const focusMain=()=>{
  open(null);
  requestAnimationFrame(() => {
   const primary = document.querySelector<HTMLElement>(".agent-panel:not([data-agent-extra]):not([hidden])");
   (primary?.querySelector<HTMLElement>(".agent-composer textarea:not(:disabled)") ?? primary?.querySelector<HTMLElement>(".agent-conversation"))?.focus({preventScroll:true});
  });
 };
 const closeExtra=(key: string) => {
  setExtraEntries(current => ({...current,[key]:{...current[key],open:false}}));
  requestAnimationFrame(() => document.querySelector<HTMLElement>(".agent-panel:not([data-agent-extra]):not([hidden]) .agent-conversation")?.focus({preventScroll:true}));
 };
 useEffect(()=>{
  if(!runtimeCapabilities.desktop)return;
  const hasBlockingDialog=(target:EventTarget|null)=>{
   if(target instanceof Element && target.closest('.shortcut-setting-control, dialog[open], [role="dialog"][aria-modal="true"], [role="alertdialog"]'))return true;
   if(document.querySelector('dialog[open], [role="alertdialog"]:not([hidden])'))return true;
   return Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"][aria-modal="true"]')).some(el=>{
    if(el.closest('[hidden]'))return false;
    const details=el.closest('details');
    return !details || details.open;
   });
  };
  const onKeyDown=(event:KeyboardEvent)=>{
   if(event.defaultPrevented||event.isComposing)return;
   if(!event.altKey||event.ctrlKey||event.metaKey||event.shiftKey)return;
   if(event.key.toLowerCase()!=="j"&&event.code!=="KeyJ")return;
   if(hasBlockingDialog(event.target))return;
   event.preventDefault();
   openExtra();
  };
  window.addEventListener("keydown",onKeyDown);
  return()=>window.removeEventListener("keydown",onKeyDown);
 },[owner,extraEntries]);
 useEffect(()=>{if(request)window.dispatchEvent(new Event('hub:show-agent'));},[request,owner]);
 const extraPanelApi: ExtraAgentPanelApi = { open: openExtra, focusMain, isExtraOpen: Boolean(extraEntries[owner]?.open) };
 return <AgentTagRequestContext.Provider value={{pending:tagRequest,setPending:setTagRequest}}><AgentCitationContext.Provider value={{value:citation,show:setCitation}}><AgentTextMaterialContext.Provider value={{selection,clearSelection:()=>setSelection(null),pending,setPending}}><AgentBrowsingContext.Provider value={{entry:browsing,setEntry:setBrowsing}}><AgentPanelContext.Provider value={open}>
  <AgentExtraPanelContext.Provider value={extraPanelApi}>
  {children}
  {runtimeCapabilities.desktop && entry===undefined && createPortal(<button type="button" className="agent-floating-launcher" aria-label="打开助手" aria-expanded={false} title="打开 Hub 助手" onClick={()=>open(null)}><span className="agent-launcher-orb" aria-hidden="true"/>助手</button>,document.body)}
  {runtimeCapabilities.desktop && Object.entries(entries).map(([key,value])=>value===undefined?null:<AgentAccountVisibleContext.Provider key={key} value={key===owner}><div hidden={key!==owner} className="agent-global-owner"><Suspense fallback={<p role="status">正在打开助手…</p>}>
   {value&&'result' in value?<Source result={value.result} initiallyOpen startFresh={freshOwners.current.has(key)}/>:value&&'itemKey' in value?<Reading itemKey={value.itemKey} initiallyOpen startFresh={freshOwners.current.has(key)}/>:value&&'workId' in value?<Existing key={value.workId} workId={value.workId} question={value.question}/>:<Standalone initiallyOpen startFresh={freshOwners.current.has(key)}/>}
  </Suspense></div></AgentAccountVisibleContext.Provider>)}
  {runtimeCapabilities.desktop && Object.entries(extraEntries).map(([key,value]) =>
    <AgentAccountVisibleContext.Provider key={key} value={key===owner}><AgentCitationContext.Provider value={null}>
      <Suspense fallback={key===owner && value.open ? <p role="status">正在打开第二个助手…</p> : null}>
        <Extra entry={value} onClose={()=>closeExtra(key)}/>
      </Suspense>
    </AgentCitationContext.Provider></AgentAccountVisibleContext.Provider>)}
 </AgentExtraPanelContext.Provider>
 </AgentPanelContext.Provider></AgentBrowsingContext.Provider></AgentTextMaterialContext.Provider></AgentCitationContext.Provider></AgentTagRequestContext.Provider>;
}
export function AgentFlashcardMaterial({title,text}:{title:string;text:string}){
 const context=useContext(AgentTextMaterialContext),open=useContext(AgentPanelContext);
 if(!runtimeCapabilities.desktop || !context || !open)return null;
 const material:TextMaterial={kind:"flashcard",title,text};
 return <button type="button" title="添加闪卡到助手（文字快照）" aria-label="添加闪卡到助手" disabled={!!context.pending} draggable onPointerDown={event=>event.stopPropagation()} onDragStart={event=>{event.stopPropagation();event.dataTransfer.effectAllowed="copy";event.dataTransfer.setData('application/x-hub-agent-source',JSON.stringify(material));}} onClick={()=>{context.setPending(material);open(null);}}><Layers size={16}/></button>;
}
export function StandaloneAgentLauncher() {
 const open=useContext(AgentPanelContext);
 if(!runtimeCapabilities.desktop)return null;
 return <button type="button" className="icon-button agent-launcher" aria-label="Hub 助手" title="打开 Hub 助手" onClick={()=>open?.(null)}><MessageSquare size={17}/></button>;
}
