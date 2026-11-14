"use client";
import {useEffect,useState} from "react";
const KEY="hub-dida-task-demo-v1", EVENT="hub-dida-task-demo-change";
type State={checks:Record<string,boolean>;status:Record<string,string>;dates:Record<string,string>;completed:Record<string,string>;descriptions:Record<string,string>};
const empty=():State=>({checks:{},status:{},dates:{},descriptions:{},completed:{"d-version":"2026-11-08","d-routing":"2026-11-07"}});
function read():State{
  try{const s=JSON.parse(localStorage.getItem(KEY)||"null");if(s)return {checks:s.checks||{},status:s.status||{},dates:s.dates||{},completed:s.completed||empty().completed,descriptions:s.descriptions&&typeof s.descriptions==='object'&&!Array.isArray(s.descriptions)?Object.fromEntries(Object.entries(s.descriptions).filter((entry):entry is [string,string]=>typeof entry[1]==='string')):{}};
    const old=JSON.parse(localStorage.getItem("hub-library-browser-v1")||"null");return {...empty(),checks:old?.checks||{}};
  }catch{return empty();}
}
// Both the task workspace and source browser observe this same local demo state.
export function useDidaTasks(){
  const [state,setState]=useState<State>(empty),[ready,setReady]=useState(false);
  useEffect(()=>{setState(read());setReady(true);const sync=()=>setState(read());window.addEventListener(EVENT,sync);window.addEventListener("storage",sync);return()=>{window.removeEventListener(EVENT,sync);window.removeEventListener("storage",sync);};},[]);
  function commit(change:(s:State)=>State){const before=read(),next=change(before);for(const [key,value] of Object.entries(next.checks)){if(key.startsWith("task:")&&value!==before.checks[key]){const id=key.slice(5);next.completed={...next.completed,[id]:value?"2026-11-08":""};}}try{localStorage.setItem(KEY,JSON.stringify(next));}catch{}setState(next);window.dispatchEvent(new Event(EVENT));}
  const setChecks=(value:Record<string,boolean>|((old:Record<string,boolean>)=>Record<string,boolean>))=>commit(s=>({...s,checks:typeof value==="function"?value(s.checks):value}));
  const setStatus=(id:string,status:string)=>commit(s=>({...s,status:{...s.status,[id]:status},checks:{...s.checks,["task:"+id]:status==="done"}}));
  const setDate=(id:string,date:string)=>commit(s=>({...s,dates:{...s.dates,[id]:date}}));
  function setDescription(id:string,value:string){const before=read(),next={...before,descriptions:{...before.descriptions,[id]:value}};try{localStorage.setItem(KEY,JSON.stringify(next));}catch{return false;}setState(next);window.dispatchEvent(new Event(EVENT));return true;}
  return {...state,setChecks,setStatus,setDate,setDescription,ready};
}
