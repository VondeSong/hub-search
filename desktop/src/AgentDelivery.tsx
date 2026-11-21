import { PencilLine } from "lucide-react";
import { type MaterialKind } from "./AgentMaterialCard";
import {AgentRequestContent, requestPresentation, type MessageSkill} from "./AgentRequestContent";
import type {InvestigationLocator} from "./AgentInvestigation";
import { AgentWebSources, type WebSource } from "./AgentWebSources";
import { AgentAnswerActions } from "./AgentAnswerActions";
import { AgentArtifactRevision } from "./AgentArtifactRevision";
import { createContext, Fragment, memo, useContext, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Element, Root, Text } from "hast";
import { AgentMarkdownCode } from "./AgentMarkdownCode";
import { AgentActivity, type ActivityRun } from "./AgentActivity";
import type { ImageGrant } from "./AgentImages";
export type Citation = { evidenceId: string; quote: string };
export type Evidence = { title: string; sourcePath: string; content: string; startChar: number; endChar: number; totalChars: number; truncated: boolean };
export type Report = { status: string; summary: string; findings: { text: string; citations: Citation[] }[]; nextSteps: { action: string; reason: string; citations: Citation[] }[]; questions: string[]; limitations: string[]; waitCondition: string; prose?: { markdown: string; citations: Citation[]; webSources?:WebSource[] } };
export type Progress = { runId: string; state: string; evidence: { evidenceId: string; excerpt: Evidence }[]; candidates: { title: string; snippet: string }[]; intents: { turn: number; message: string }[]; searches: { query: string; count: number }[]; withheld: number; validity: string };
export type ArtifactReference = { artifactId: string; revision: number; currentRevision: number; contentHash: string; datasetRevision: string };
type Reopening = { workId?: string; recordVersion?: number };
type ArtifactBinding = { artifactRefs?: ArtifactReference[]; artifactState?: "current" | "stale" | "unavailable" };
export type HistoricalDelivery = ArtifactBinding & { runId: string; createdAt: number; report: Report | null; evidence: Evidence[]; validity: string };
export type MessageMaterial = {kind:MaterialKind;title:string;sourcePath?:string|null;locator?:InvestigationLocator;available:boolean};
export type ConversationMessage = ArtifactBinding & { displayText?:string;skills?:MessageSkill[];materials?: MessageMaterial[]; images?: ImageGrant[]; revision?: number; id: string; role: "user" | "assistant"; text?: string; kind?: "request" | "decision" | "scope"; runId?: string; report?: Report | null; evidence?: Evidence[]; validity?: string; createdAt: number };
export type Conversation = { messages: ConversationMessage[]; hasEarlier: boolean; nextCursor?: string | null };
export function prependConversation(current: Conversation, older: Conversation): Conversation {
  const known = new Set(current.messages.map(message => message.id));
  const additional = older.messages.filter(message => !known.has(message.id));
  return { ...current, messages: current.messages.length ? [current.messages[0], ...additional, ...current.messages.slice(1)] : additional, hasEarlier: older.hasEarlier, nextCursor: older.nextCursor };
}
export type CitationOpening = (runId: string, evidenceIndex: number, quote: string) => void;

const ReportCitationContext = createContext<{ citations: Citation[]; evidence: Evidence[]; runId?: string; onOpenCitation?: CitationOpening }>({ citations: [], evidence: [] });
function ReportLink({ href, children }: { href?: string; children?: ReactNode }) {
  const { citations, evidence, runId, onOpenCitation } = useContext(ReportCitationContext);
  const index = href?.match(/^#hub-citation-(\d+)$/)?.[1];
  if (index) {
    const citation = citations[Number(index) - 1];
    const sourceIndex = Number(citation?.evidenceId.slice(1)) - 1;
    const source = evidence[sourceIndex];
    return citation ? <button type="button" className="agent-inline-citation" title={source?.title || "查看引用原文"} aria-label={"查看引用 " + index + "：" + (source?.title || citation.evidenceId)} disabled={!source || !runId || !onOpenCitation} onClick={() => runId && onOpenCitation?.(runId, sourceIndex, citation.quote)}>{children}</button> : <span>{children}</span>;
  }
  return <a href={href} target="_blank" rel="noreferrer">{children}</a>;
}
const reportMarkdownComponents = {
  a: ReportLink,
  img: ({ alt }: { alt?: string }) => <span>{alt}</span>,
  pre: AgentMarkdownCode,
  table: ({ children }: { children?: ReactNode }) => <div className="agent-table-scroll" role="region" aria-label="回答表格，可横向滚动" tabIndex={0}><table>{children}</table></div>,
};
const reportRemarkPlugins = [remarkGfm];
function reportCitations(citationCount: number) {
  return (tree: Root) => {
    function replaceIn(parent: Root | Element) {
      for (let index = 0; index < parent.children.length; index++) {
        const child = parent.children[index];
        if (child.type === "element" && !["a", "code", "pre"].includes(child.tagName)) replaceIn(child);
        if (child.type !== "text") continue;
        const parts: (Text | Element)[] = [];
        let start = 0;
        for (const match of child.value.matchAll(/\[(\d+)\](?!\()/g)) {
          const citation = Number(match[1]);
          if (citation < 1 || citation > citationCount) continue;
          const offset = match.index!;
          if (offset > start) parts.push({ type: "text", value: child.value.slice(start, offset) });
          parts.push({ type: "element", tagName: "a", properties: { href: "#hub-citation-" + citation }, children: [{ type: "text", value: match[1] }] });
          start = offset + match[0].length;
        }
        if (parts.length === 0) continue;
        if (start < child.value.length) parts.push({ type: "text", value: child.value.slice(start) });
        parent.children.splice(index, 1, ...parts);
        index += parts.length - 1;
      }
    }
    replaceIn(tree);
  };
}
// Keep unchanged parsed markup and table nodes. Citation consumers still receive
// the latest source eligibility and opening handler through their local context.
const ReportMarkdown = memo(function ReportMarkdown({ markdown, citationCount }: { markdown: string; citationCount: number }) {
  return <ReactMarkdown remarkPlugins={reportRemarkPlugins} rehypePlugins={citationCount ? [[reportCitations, citationCount]] : []} skipHtml components={reportMarkdownComponents}>{markdown}</ReactMarkdown>;
});

function SourceExcerpt({ value }: { value: Evidence }) {
  return <details className="agent-citation"><summary>{value.title}</summary><blockquote>{value.content}</blockquote><small>{value.sourcePath} · 第 {value.startChar + 1}–{value.endChar} 字符{value.truncated ? "（节选）" : ""}</small></details>;
}

function ReportContent({ value, evidence, runId, onOpenCitation, actions }: { value: Report; evidence: Evidence[]; runId?: string; onOpenCitation?: CitationOpening; actions?:ReactNode }) {
  if (value.prose) {
    const prose=value.prose;
    const copySources=prose.citations.map((citation,index)=>{
      const source=evidence[Number(citation.evidenceId.slice(1))-1];
      return `[${index+1}] ${source?.title || "引用原文"}${source?.sourcePath ? `（${source.sourcePath}）` : ""}：${citation.quote}`;
    });
    return <div className="agent-report agent-answer">
      <ReportCitationContext.Provider value={{ citations: prose.citations, evidence, runId, onOpenCitation }}><ReportMarkdown markdown={prose.markdown} citationCount={prose.citations.length} /></ReportCitationContext.Provider>
      <AgentWebSources sources={prose.webSources??[]}/>
      {!!value.limitations.length && <p className="agent-note">{value.limitations.join("；")}</p>}
      <div className="agent-answer-toolbar"><AgentAnswerActions text={[prose.markdown,...value.limitations,copySources.length ? "来源：\n"+copySources.join("\n") : ""].filter(Boolean).join("\n\n")}/>{actions}</div>
    </div>;
  }
  const citations = (items: Citation[]) => items.map((citation, index) => {
    const source = evidence[Number(citation.evidenceId.slice(1)) - 1];
    const evidenceIndex = Number(citation.evidenceId.slice(1)) - 1;
    return <details className="agent-citation" key={`${citation.evidenceId}-${index}`}><summary>依据：{source?.title || citation.evidenceId}</summary><blockquote>{citation.quote}</blockquote>{source && <small>{source.sourcePath} · 已核对第 {source.startChar + 1}–{source.endChar} 字符{source.truncated ? "（节选）" : ""}</small>}{source && runId && onOpenCitation && <button type="button" onClick={() => onOpenCitation(runId, evidenceIndex, citation.quote)}>查看引用原文</button>}</details>;
  });
  return <div className="agent-report">
    <p>{value.summary}</p>
    {!!value.findings.length && <><h3>查明的情况</h3><ul>{value.findings.map((finding, index) => <li key={index}>{finding.text}{citations(finding.citations)}</li>)}</ul></>}
    {!!value.nextSteps.length && <><h3>建议下一步</h3><ol>{value.nextSteps.map((step, index) => <li key={index}><strong>{step.action}</strong><p>{step.reason}</p>{citations(step.citations)}</li>)}</ol></>}
    {!!value.questions.length && <><h3>需要你决定</h3><ul>{value.questions.map((question, index) => <li key={index}>{question}</li>)}</ul></>}
    {value.waitCondition && <p>等待条件：{value.waitCondition}。可手动继续，或在下方明确设置可核对的复查条件。</p>}
    {!!value.limitations.length && <details><summary>证据范围与局限</summary><ul>{value.limitations.map((limit, index) => <li key={index}>{limit}</li>)}</ul></details>}
    {actions&&<div className="agent-answer-toolbar">{actions}</div>}
  </div>;
}

function BoundReport({ value, report, evidence, runId, onOpenCitation, workId, recordVersion, keepHistoricalTextVisible=false, actions }: Reopening & {
  value: ArtifactBinding; report: Report; evidence: Evidence[]; runId?: string; onOpenCitation?: CitationOpening;
  keepHistoricalTextVisible?: boolean; actions?:ReactNode;
}) {
  if (value.artifactState === "unavailable") return null;
  const body = <ReportContent value={report} evidence={evidence} runId={runId} onOpenCitation={onOpenCitation} actions={actions}/>;
  const references = !!value.artifactRefs?.length && <p className="agent-note" aria-label="回答使用的图表版本">
    {value.artifactRefs.map((ref, index) => <span key={ref.artifactId}>{index > 0 ? "；" : ""}图表 {index + 1} · 第 {ref.revision} 版{ref.currentRevision !== ref.revision ? `（当前第 ${ref.currentRevision} 版）` : ""}</span>)}
  </p>;
  const previews = workId && value.artifactRefs?.map(ref => <AgentArtifactRevision key={`${workId}:${ref.artifactId}:${ref.revision}:${ref.currentRevision}:${recordVersion}`} workId={workId} reference={ref} />);
  return value.artifactState === "stale" && !keepHistoricalTextVisible
    ? <details className="agent-history"><summary>查看旧版回答（要求或图表已更新）</summary>{references}{previews}{body}</details>
    : <>{references}{previews}{body}</>;
}

export function AgentDelivery({ report, evidence, progress, history = [], running, revoked, runId, onOpenCitation, workId, recordVersion }: Reopening & {
  report: Report | null; evidence: Evidence[]; progress?: Progress | null;
  history?: HistoricalDelivery[]; running: boolean; revoked: boolean; runId?: string; onOpenCitation?: CitationOpening;
}) {
  if (revoked) return null;
  return <>
    {report && <ReportContent value={report} evidence={evidence} runId={runId} onOpenCitation={onOpenCitation} />}
    {!report && progress && <section className="agent-progress" aria-label="已取得的材料">
      <h3>已取得的材料</h3>
      <p className="agent-note">{running ? "调查仍在进行，以下材料已保存。" : "本轮尚未形成完整结论，已有材料可继续核对。"} 检索候选尚未证明关联成立。</p>
      {!!progress.candidates.length && <details open><summary>检索候选（{progress.candidates.length}）</summary><ul>{progress.candidates.map((candidate, index) => <li key={index}><strong>{candidate.title}</strong><p>{candidate.snippet}</p></li>)}</ul></details>}
      {!!progress.evidence.length && <details open><summary>已读取的来源（{progress.evidence.length}）</summary>{progress.evidence.map(({ evidenceId, excerpt }) => <SourceExcerpt key={evidenceId} value={excerpt} />)}</details>}
      {!!progress.searches.length && <details><summary>已核对的检索</summary><ul>{progress.searches.map((search, index) => <li key={index}>“{search.query}”：{search.count ? `${search.count} 个候选` : "未命中"}</li>)}</ul></details>}
      {!!progress.intents.length && <details><summary>调查进展</summary><ul>{progress.intents.map((intent, index) => <li key={index}>{intent.message}</li>)}</ul></details>}
      {progress.validity && <p className="agent-notice">{progress.validity}</p>}
    </section>}
    {!!history.length && <details className="agent-history"><summary>历史交付（{history.length}）</summary>{history.map(item => <section key={item.runId}><p className="agent-note">{new Date(item.createdAt).toLocaleString()} · {item.validity}</p>{item.report && <BoundReport workId={workId} recordVersion={recordVersion} value={item} report={item.report} evidence={item.evidence} runId={item.runId} onOpenCitation={onOpenCitation} />}</section>)}</details>}
  </>;
}

export function AgentConversation({ conversation, revoked, onOpenCitation, onOpenMaterial, onEdit, onRecheck, renderAfter, renderActions, activity=[], workId, recordVersion, onLoadEarlier, earlierLoading=false, earlierError="" }: Reopening & { conversation: Conversation; revoked: boolean; onOpenCitation: CitationOpening; onOpenMaterial?:(item:MessageMaterial)=>void; onEdit?:(message:ConversationMessage)=>void; onRecheck?:()=>void; onLoadEarlier?: () => void; earlierLoading?: boolean; earlierError?: string; renderAfter?: (message: ConversationMessage) => ReactNode; renderActions?: (message:ConversationMessage)=>ReactNode; activity?:ActivityRun[] }) {
  if (revoked) return null;
  return <div className="agent-messages" aria-label="对话记录">
    {conversation.hasEarlier && (onLoadEarlier && conversation.nextCursor ? <button type="button" disabled={earlierLoading} onClick={onLoadEarlier}>{earlierLoading ? "正在读取更早记录…" : "查看更早记录"}</button> : <p className="agent-note">这里只显示最近的对话，较早记录仍已保存。</p>)}
    {earlierError && <p role="alert">{earlierError}</p>}
    {conversation.messages.flatMap((message, index) => {
      // A follow-up revises the task, not the words previously spoken. Keep plain
      // native answers in chronology; source/authorization and chart invalidation
      // must still use the existing hidden or collapsed presentation.
      const revisedText = message.artifactState === "stale" && !!message.report?.prose && !message.artifactRefs?.length
        && message.validity === "用户要求已更新；新增或纠正的要求需要重新核对，旧回答仅供历史查阅。";
      // Runs stay keyed siblings of messages when a streamed answer is published.
      // Moving them between message subtrees would discard every open disclosure.
      const messageRuns = activity.filter(run => message.role === "assistant" ? run.runId === message.runId
        : run.revision === message.revision && !conversation.messages.some(item => item.runId === run.runId)
          && !conversation.messages.slice(index + 1).some(item => item.revision === message.revision));
      const combinedValidity = message.artifactState === "unavailable" && messageRuns.some(run=>run.validity) ? message.validity : undefined;
      const runs = messageRuns.map(run => {
        const request=conversation.messages.slice(0,index+1).reverse().find(item=>item.role==="user" && item.kind!=="decision" && item.kind!=="scope" && item.revision===run.revision);
        return <AgentActivity key={`run:${run.runId}`} value={combinedValidity && run.validity ? {...run,validity:combinedValidity} : run} onRecheck={onRecheck} requestText={request?.displayText ?? request?.text}/>;
      });
      const body = <section key={`message:${message.id}`} className={`agent-message agent-message-${message.role}`} aria-label={message.role === "user" ? "你的消息" : "助手回答"}>
      {message.role === "user" ? <><div className="agent-user-message-content"><AgentRequestContent message={message} onOpenMaterial={onOpenMaterial}/></div><div className="agent-user-message-actions">
        {Number.isFinite(message.createdAt)&&message.createdAt>0&&!Number.isNaN(new Date(message.createdAt).getTime())&&<time dateTime={new Date(message.createdAt).toISOString()} title={new Date(message.createdAt).toLocaleString("zh-CN",{hour12:false})}>{new Date(message.createdAt).toLocaleTimeString("zh-CN",{hour:"2-digit",minute:"2-digit",hour12:false})}</time>}
        <AgentAnswerActions text={requestPresentation(message).body || requestPresentation(message).skills.map(skill=>skill.title).join("、")} label="消息"/>
        {onEdit&&message.kind!=="scope"&&<button type="button" className="agent-edit-message" title="恢复正文和引用为新消息，不修改历史记录" disabled={message.materials?.some(item=>!item.available)} onClick={()=>onEdit(message)}><PencilLine size={13}/>编辑</button>}
      </div></> : <>
        {message.validity && !combinedValidity && <p className="agent-note">{revisedText ? "此前回答" : message.validity}</p>}
        {message.report && <BoundReport workId={workId} recordVersion={recordVersion} value={message} report={message.report} evidence={message.evidence || []} runId={message.runId} onOpenCitation={onOpenCitation} keepHistoricalTextVisible={revisedText} actions={renderActions?.(message)}/>}
      </>}
      {message.role === "assistant" && renderAfter?.(message)}
    </section>;
      return message.role === "assistant" ? [...runs, body]
        : [body, ...runs, <Fragment key={`outcome:${message.id}`}>{renderAfter?.(message)}</Fragment>];
    })}
  </div>;
}
