import {useEffect,useState} from "react";
import {Check,Copy} from "lucide-react";

export function AgentAnswerActions({text,label="回答",showLabel=false}:{text:string;label?:string;showLabel?:boolean}) {
 const [copied,setCopied]=useState(false),[error,setError]=useState(false);
 useEffect(()=>{setCopied(false);setError(false);},[text]);
 useEffect(()=>{if(!copied)return;const timer=setTimeout(()=>setCopied(false),2000);return()=>clearTimeout(timer);},[copied]);
 return <div className="agent-answer-actions"><button type="button" aria-label={copied?`已复制${label}`:`复制${label}`} title={copied?"已复制":`复制${label}`} onClick={async()=>{
  setError(false);try{await navigator.clipboard.writeText(text);setCopied(true);}catch{setError(true);}
 }}>{copied?<Check size={15} aria-hidden="true"/>:<Copy size={15} aria-hidden="true"/>}{showLabel&&<span>{copied?"已复制":"复制"}</span>}</button><span role="status" className={showLabel&&!error?"agent-visually-hidden":undefined}>{error?"复制失败，请重试或选择正文复制。":copied?"已复制":""}</span></div>;
}
