import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

export type ToolResultRef = { recordId: string; sha256: string; utf8Bytes?: number };
export type ToolResultScope = { workId: string; currentWorkRevision: number; authorizationVersion: number };
type Preview = {title?:string;content:string;totalChars:number;truncated:boolean};
type Page = { methodPreview?: Preview|null; sourcePreview?: {title?:string;content:string;totalChars:number;truncated:boolean}|null; kind: "historicalToolResult"; recordId: string; sha256: string; content: string; startChar: number; endChar: number; totalChars: number; nextStartChar: number | null; historical: true; currentEvidence: false };

export function AgentToolResult({ value, scope }: { value: ToolResultRef; scope: ToolResultScope }) {
  const identity=JSON.stringify([scope.workId,scope.currentWorkRevision,scope.authorizationVersion,value.recordId,value.sha256]);
  const current=useRef(identity); current.current=identity;
  const job=useRef(0), opener=useRef<HTMLButtonElement>(null);
  const [shown,setShown]=useState<string|null>(null);
  const [result,setResult]=useState<{identity:string;page:Page}|null>(null);
  const [busy,setBusy]=useState(false), [error,setError]=useState("");
  useEffect(()=>{job.current++;setShown(null);setResult(null);setBusy(false);setError("");},[identity]);
  useEffect(()=>()=>{job.current++;},[]);
  async function read(startChar:number) {
    const sequence=++job.current, expected=identity;
    setShown(expected);setResult(null);setError("");setBusy(true);
    try {
      const page=await invoke<Page>("agent_investigation",{args:{action:"readToolResult",id:scope.workId,
        expectedWorkRevision:scope.currentWorkRevision,expectedAuthorizationVersion:scope.authorizationVersion,
        recordId:value.recordId,expectedSha256:value.sha256,startChar,maxChars:4000}});
      if (job.current!==sequence || current.current!==expected) return;
      if (page.kind!=="historicalToolResult" || page.recordId!==value.recordId || page.sha256!==value.sha256 || page.startChar!==startChar || !Number.isSafeInteger(page.endChar) || !Number.isSafeInteger(page.totalChars) || page.endChar<startChar || page.totalChars<page.endChar || page.endChar-startChar>4000 || typeof page.content!=="string" || Array.from(page.content).length!==page.endChar-startChar || (page.nextStartChar===null ? page.endChar!==page.totalChars : page.nextStartChar!==page.endChar || page.endChar>=page.totalChars || page.endChar<=page.startChar) || page.historical!==true || page.currentEvidence!==false) throw new Error("记录身份或读取范围不一致，请重新核对");
      setResult({identity:expected,page});
    } catch (failure) {if(job.current===sequence && current.current===expected){setResult(null);setError(String(failure));}}
    finally {if(job.current===sequence && current.current===expected)setBusy(false);}
  }
  const page=result?.identity===identity?result.page:null;
  const open=shown===identity;
  return <div className="agent-tool-result">
    <button type="button" ref={opener} aria-expanded={open} onClick={()=>{if(open){job.current++;setShown(null);setResult(null);setBusy(false);setError("");}else void read(0);}}>查看完整工具记录</button>
    {open && <section aria-label="完整工具记录" aria-busy={busy}>
      <p className="agent-note">这是当时的工具记录，查看不会重新执行操作。</p>
      {busy && <p role="status">正在核对记录与授权…</p>}
      {error && <p role="alert">{error}</p>}
      {page?.sourcePreview && <div aria-label="读取的原文片段"><strong>{page.sourcePreview.title || "原文片段"}</strong><p style={{whiteSpace:"pre-wrap"}}>{page.sourcePreview.content}</p><p className="agent-note">本次读取片段 {page.sourcePreview.totalChars} 字符{page.sourcePreview.truncated ? "，预览前 4000 字符；完整记录见技术详情" : ""}</p></div>}
      {page?.methodPreview && <div aria-label="读取的技能说明"><strong>{page.methodPreview.title || "技能说明"}</strong><p className="agent-note">本次读取的方法说明，不是资料来源，也不代表已核对事实。</p><ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={{img:()=>null,a:({children})=><span>{children}</span>}}>{page.methodPreview.content}</ReactMarkdown>{page.methodPreview.truncated && <p className="agent-note">预览前 4000 字符；完整说明见技术详情。</p>}</div>}
      {page && <details open={!page.sourcePreview && !page.methodPreview}><summary>技术详情 · 原始工具记录</summary><pre tabIndex={0} aria-label="记录原文">{page.content}</pre><p className="agent-note">工具记录 JSON：第 {page.startChar+1}–{page.endChar} 字符，共 {page.totalChars} 字符（含元数据，不是文章字数）</p>
        <div><button type="button" disabled={busy || page.startChar===0} onClick={()=>void read(Math.max(0,page.startChar-4000))}>上一段</button>
        <button type="button" disabled={busy || page.nextStartChar===null} onClick={()=>{if(page.nextStartChar!==null)void read(page.nextStartChar);}}>下一段</button></div></details>}
      {error && <button type="button" disabled={busy} onClick={()=>void read(0)}>重新核对记录</button>}
      <button type="button" onClick={()=>{job.current++;setShown(null);setResult(null);setBusy(false);setError("");opener.current?.focus();}}>返回工作过程</button>
    </section>}
  </div>;
}
