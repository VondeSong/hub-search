import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

export type ToolResultRef = { recordId: string; sha256: string; utf8Bytes?: number };
export type ToolResultScope = { workId: string; currentWorkRevision: number; authorizationVersion: number };
type Preview = {title?:string;content:string;totalChars:number;truncated:boolean};
type ScriptText = {content:string;truncated:boolean};
type ScriptPreview = {language:string;script:ScriptText|null;output:ScriptText|null;exitCode:number|null};
type Page = { methodPreview?: Preview|null; sourcePreview?: Preview|null; scriptPreview?: ScriptPreview; kind: "historicalToolResult"; recordId: string; sha256: string; content: string; startChar: number; endChar: number; totalChars: number; nextStartChar: number | null; historical: true; currentEvidence: false };

function ScriptBlock({title,text,output}: {title:string;text:ScriptText;output?:boolean}) {
  return <div className={output ? "agent-script-block agent-script-output" : "agent-script-block"}>
    <p>{title}{text.truncated && " · 截断预览"}</p>
    <pre role="region" aria-label={title} tabIndex={0}><code>{text.content}</code></pre>
  </div>;
}

export function AgentToolResult({ value, scope, scriptState }: { value: ToolResultRef; scope: ToolResultScope; scriptState?:string }) {
  const inlineScript=scriptState!==undefined;
  const identity=JSON.stringify([scope.workId,scope.currentWorkRevision,scope.authorizationVersion,value.recordId,value.sha256]);
  const current=useRef(identity); current.current=identity;
  const job=useRef(0), opener=useRef<HTMLButtonElement>(null);
  const [shown,setShown]=useState<string|null>(null);
  const [result,setResult]=useState<{identity:string;page:Page}|null>(null);
  const [scriptResult,setScriptResult]=useState<{identity:string;preview?:ScriptPreview}|null>(null);
  const [busy,setBusy]=useState(false), [error,setError]=useState("");
  const [technical,setTechnical]=useState(false);
  useEffect(()=>{
    job.current++;
    setShown(null);setResult(null);setScriptResult(null);setBusy(false);setError("");setTechnical(false);
    if(inlineScript) void read(0);
  },[identity,inlineScript]);
  useEffect(()=>()=>{job.current++;},[]);
  async function read(startChar:number) {
    const sequence=++job.current, expected=identity;
    setShown(expected);setResult(null);setError("");setBusy(true);
    try {
      const page=await invoke<Page>("agent_investigation",{args:{action:"readToolResult",id:scope.workId,
        expectedWorkRevision:scope.currentWorkRevision,expectedAuthorizationVersion:scope.authorizationVersion,
        recordId:value.recordId,expectedSha256:value.sha256,startChar,maxChars:4000,
        ...(inlineScript && startChar===0 ? {includeScriptPreview:true} : {})}});
      if (job.current!==sequence || current.current!==expected) return;
      if (page.kind!=="historicalToolResult" || page.recordId!==value.recordId || page.sha256!==value.sha256 || page.startChar!==startChar || !Number.isSafeInteger(page.endChar) || !Number.isSafeInteger(page.totalChars) || page.endChar<startChar || page.totalChars<page.endChar || page.endChar-startChar>4000 || typeof page.content!=="string" || Array.from(page.content).length!==page.endChar-startChar || (page.nextStartChar===null ? page.endChar!==page.totalChars : page.nextStartChar!==page.endChar || page.endChar>=page.totalChars || page.endChar<=page.startChar) || page.historical!==true || page.currentEvidence!==false) throw new Error("记录身份或读取范围不一致，请重新核对");
      setResult({identity:expected,page});
      if(inlineScript && startChar===0) setScriptResult({identity:expected,preview:page.scriptPreview});
    } catch (failure) {if(job.current===sequence && current.current===expected){setResult(null);setScriptResult(null);setError(String(failure));}}
    finally {if(job.current===sequence && current.current===expected)setBusy(false);}
  }
  const page=result?.identity===identity?result.page:null;
  const open=shown===identity;
  const scriptLoaded=scriptResult?.identity===identity;
  const script=scriptLoaded ? scriptResult.preview : undefined;
  const scriptStatus=scriptState==="failed" || (script?.exitCode!=null && script.exitCode!==0) ? "执行失败"
    : scriptState==="interrupted" ? "已中断" : scriptState==="completed" ? "执行成功" : "";
  function close() {
    job.current++;
    setShown(null);
    setResult(null);
    setBusy(false);
    setError("");
    setTechnical(false);
  }
  return <div className="agent-tool-result">
    {!inlineScript && <button type="button" ref={opener} aria-expanded={open} onClick={()=>{if(open)close();else void read(0);}}>查看完整工具记录</button>}
    {open && <section className={inlineScript ? "agent-script-details" : undefined} aria-label={inlineScript ? "脚本运行记录" : "完整工具记录"} aria-busy={busy}>
      {busy && !scriptLoaded && <p role="status">正在核对记录与授权…</p>}
      {error && <p role="alert">{error}</p>}
      {inlineScript && scriptLoaded && <div className="agent-script-result">
        {script?.script ? <ScriptBlock title={script.language} text={script.script}/> : <p>这条记录没有可显示的脚本正文。</p>}
        {script?.output && <ScriptBlock title="输出" text={script.output} output/>}
        {scriptStatus && <p className="agent-script-status">{scriptStatus}{script?.exitCode!=null ? ` · 退出码 ${script.exitCode}` : ""}</p>}
      </div>}
      {page?.sourcePreview && <div aria-label="读取的原文片段"><strong>{page.sourcePreview.title || "原文片段"}</strong><p style={{whiteSpace:"pre-wrap"}}>{page.sourcePreview.content}</p><p className="agent-note">本次读取片段 {page.sourcePreview.totalChars} 字符{page.sourcePreview.truncated ? "，预览前 4000 字符；完整记录见技术详情" : ""}</p></div>}
      {page?.methodPreview && <div aria-label="读取的技能说明"><strong>{page.methodPreview.title || "技能说明"}</strong><p className="agent-note">本次读取的方法说明，不是资料来源，也不代表已核对事实。</p><ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={{img:()=>null,a:({children})=><span>{children}</span>}}>{page.methodPreview.content}</ReactMarkdown>{page.methodPreview.truncated && <p className="agent-note">预览前 4000 字符；完整说明见技术详情。</p>}</div>}
      {(page || technical && busy) && <details className="agent-technical-record" open={technical} onToggle={event=>setTechnical(event.currentTarget.open)}><summary>技术记录</summary>{page && technical && <><pre tabIndex={0} aria-label="记录原文">{page.content}</pre><p className="agent-note">记录字符 {page.startChar+1}–{page.endChar} / {page.totalChars}（含元数据）</p>
        {(!inlineScript || page.startChar>0 || page.nextStartChar!==null) && <div><button type="button" disabled={busy || page.startChar===0} onClick={()=>void read(Math.max(0,page.startChar-4000))}>上一段</button>
        <button type="button" disabled={busy || page.nextStartChar===null} onClick={()=>{if(page.nextStartChar!==null)void read(page.nextStartChar);}}>下一段</button></div>}</>}</details>}
      {error && <button type="button" disabled={busy} onClick={()=>void read(0)}>重新核对记录</button>}
      {!inlineScript && <button type="button" onClick={()=>{close();opener.current?.focus();}}>返回工作过程</button>}
    </section>}
  </div>;
}
