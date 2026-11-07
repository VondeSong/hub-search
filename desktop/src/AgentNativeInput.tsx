import { useEffect, useId, useRef, useState } from "react";

export type NativeInput = {
  key: string; runId: string; state: "pending" | "answered" | "sent" | "resolved" | "closed";
  isBlocking: boolean;
  delivery?: "async";
  questions: {id:string;header:string;question:string;isOther?:boolean;options?:{label:string;description:string}[]|null}[];
};

export function AgentNativeInput({value,disabled,onAnswer}:{value:NativeInput;disabled:boolean;onAnswer:(answers:Record<string,string>,cancel:boolean)=>Promise<void>}) {
  const id = useId();
  const [choices,setChoices] = useState<Record<string,string>>({});
  const [written,setWritten] = useState<Record<string,string>>({});
  const [busy,setBusy] = useState(false);
  const [saved,setSaved] = useState(false);
  const [error,setError] = useState("");
  const inFlight = useRef(false);
  const form = useRef<HTMLFormElement>(null), history = useRef<HTMLElement>(null), returnFocus = useRef(false);
  useEffect(() => { if(saved && returnFocus.current) history.current?.focus(); }, [saved]);
  const pending = value.state === "pending" && !saved;
  const answers = Object.fromEntries(value.questions.map(q=>[q.id,q.options?.length && choices[q.id]!=="custom" ? q.options[Number(choices[q.id])]?.label || "" : written[q.id] || ""]));
  const complete = value.questions.every(q=>answers[q.id].trim());
  async function submit(cancel:boolean) {
    if(disabled || !pending || inFlight.current || (!cancel && !complete)) return;
    inFlight.current=true;setBusy(true);setError("");
    try { await onAnswer(cancel?{}:answers,cancel);returnFocus.current=document.activeElement===document.body || !!form.current?.contains(document.activeElement);setSaved(true); }
    catch(reason) {setError(String(reason));}
    finally {inFlight.current=false;setBusy(false);}
  }
  if(!pending) return <details className="agent-reasoning agent-native-input-history"><summary ref={history}>{value.state==="closed" ? "本轮问题已关闭" : value.state==="resolved" ? "问题已结束" : value.delivery==="async" ? "回复已保存" : value.state==="sent" ? "回复已发送，等待助手处理" : "回复已保存，等待发送"}</summary><div>{value.questions.map(q=><p key={q.id}>{q.question}</p>)}{value.state==="closed" && <p>已提交的回答会保留；需要补充时，请发送新消息。</p>}</div></details>;
  return <form ref={form} className="agent-native-input" aria-label="回答助手的问题" aria-busy={busy} onSubmit={event=>{event.preventDefault();void submit(false);}}>
    <h4>{value.isBlocking ? "需要你补充的信息" : "可补充的信息"}</h4>
    {value.questions.map((q,index)=><fieldset key={q.id} disabled={disabled||busy}>
      <legend>{q.question}</legend>
      {q.options?.length ? <>
        <label htmlFor={`${id}-${index}-choice`}>{q.header}</label>
        <select id={`${id}-${index}-choice`} aria-describedby={choices[q.id]!==undefined && choices[q.id]!=="custom" ? `${id}-${index}-description` : undefined} value={choices[q.id]??""} onChange={event=>setChoices(v=>({...v,[q.id]:event.target.value}))}>
          <option value="" disabled>请选择</option>
          {q.options.map((option,i)=><option key={i} value={String(i)}>{option.label}</option>)}
          {q.isOther && <option value="custom">自行填写</option>}
        </select>
        {choices[q.id]!==undefined && choices[q.id]!=="custom" && <p id={`${id}-${index}-description`} className="agent-note">{q.options[Number(choices[q.id])]?.description}</p>}
      </> : null}
      {(!q.options?.length || choices[q.id]==="custom") && <label htmlFor={`${id}-${index}-text`}>你的回答<textarea id={`${id}-${index}-text`} maxLength={700} rows={3} value={written[q.id]||""} onChange={event=>setWritten(v=>({...v,[q.id]:event.target.value}))}/></label>}
    </fieldset>)}
    <p className="agent-note">{value.delivery==="async" ? "助手可以继续处理；本轮结束后仍可回答，回答将作为后续消息。" : "本轮停止或结束后，问题会关闭。"}“暂不回答”会提交跳过本次问题的回复；稍后补充请发送新消息。请勿填写密码或密钥。</p>
    {error && <p role="alert" className="agent-notice">{error}</p>}
    <div className="agent-native-input-actions"><button type="submit" disabled={disabled||busy||!complete}>{busy?"正在提交…":"提交回答"}</button><button type="button" disabled={disabled||busy} onClick={()=>void submit(true)}>暂不回答</button></div>
  </form>;
}
