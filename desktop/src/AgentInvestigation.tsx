import {AgentFollowups,type Followup} from "./AgentFollowups";
import { loadAgentPreferences, rememberAgentPreferences, loadCodexWebSearchPreference, loadMemoryPreference, rememberMemoryPreference } from "./AgentPreferences";
import { AgentTagRequestContext, AgentCitationContext, AgentBrowsingContext, AgentPanelContext,AgentAccountVisibleContext,AgentTextMaterialContext,type TextMaterial,type AgentQuestion } from "./StandaloneAgentLauncher";
import {AgentMaterialCard} from "./AgentMaterialCard";
import {AgentConversationHistory,type WorkSummary,type HistoryChange} from "./AgentConversationHistory";
import { AgentAnswerSave, type AnswerSave } from "./AgentAnswerSave";
import { AgentTaskMode } from "./AgentTaskMode";
import { AgentDetailSummary } from "./AgentDetailSummary";
import { Activity, Brain, Globe2, FolderBookmark, Layers, Library, NotebookPen, SlidersHorizontal, Tags } from "lucide-react";
import { AgentScopeTrigger } from "./AgentScopeTrigger";
import { useAgentLibraryRegistry, resolveAgentLibraries } from "./useAgentLibraryRegistry";
import type { CitationLocation } from "./AgentCitationPreview";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { AgentActivity, type ActivityRun } from "./AgentActivity";
import { AgentNativeInput, type NativeInput } from "./AgentNativeInput";
import { AgentSkills, skillTitle } from "./AgentSkills";
import { AgentTopics, type TopicWorkSource } from "./AgentTopics";
import { useAgentPopover } from "./useAgentPopover";
import { useAgentPanelResize } from "./useAgentPanelResize";
import {useInsightWork} from "./useInsights";
import { CodexAccountBadge } from "./CodexAccountsSettings";
import { authorizeCodexConversation, getCodexAccountSnapshot, refreshCodexAccounts } from "./CodexAccounts";
import { isInsideKeyboardDialog } from "./AppKeyboardScope";
import { AgentActiveTopic, AgentResearchPolicy, AgentResearchTopics, policyNames, researchGrant, useResearchSelection, type ResearchGrant, type ResearchTopic } from "./AgentResearch";
import { AgentTagWorkspace, suggestedTagTask, AgentTagReferences, AgentTagRelated, AgentTagResult, useTagPreparation, tagTaskNames, type TagTaskRecord } from "./AgentTagWorkspace";
import { userProfileStorage } from "./UserProfileStorage";
import {AgentNativeContext,type NativeContext} from "./AgentNativeContext";
import {AgentImageCards,AgentTextFileCard,isTextAttachment,agentFileAccept,prepareImage,readTextFile} from "./AgentFileInputs";
import {AgentImages,type ImageGrant,type ImageChange} from "./AgentImages";
import { AgentMaterials, materialKey, type AgentMaterial } from "./AgentMaterials";
import {AgentLibraryScope,libraryDragType,readLibraryDrop,type AgentLibrary} from "./AgentLibraryScope";
import { AgentSourceScope, type SourceSelection } from "./AgentSourceScope";
import { AgentScopeCoverage } from "./AgentScopeCoverage";
import { useContext, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowDown, ArrowLeft, ArrowUp, Square, ChevronDown, ChevronRight, WandSparkles, FileText, ListChecks, Maximize2, Menu, MessageSquare, Minimize2, PanelRight, PanelsTopLeft, MoreHorizontal, Quote, Plus, Search, X } from "lucide-react";
import type { SearchResult } from "./SearchTypes";
import { isTaskPreviewResult } from "./TaskResultIdentity";
import { runtimeCapabilities } from "./RuntimePlatform";
import { useDocumentVisible } from "./WindowVisibility";
import { useAgentUiTiming, type TimedEvent } from "./useAgentUiTiming";
import { AgentTagAction, type AgentActions } from "./AgentTagAction";
import { AgentAssistantOptions, defaultAssistantOptions, type AssistantOptions } from "./AgentAssistantOptions";
import { AgentBusinessActions, ArchiveRecord, FlashcardRecord } from "./AgentBusinessActions";
import { AgentObsidianEdit, AgentObsidianTarget, AgentReportSave } from "./AgentObsidianEdit";
import { AgentConditions, type AgentCondition } from "./AgentConditions";
import { codexSelectionLabel, useCodexSuite, type CodexSettings, type ModelExecution } from "./CodexSuite";
import { SharedMemory, type MemorySelection, type MemoryUse } from "./SharedMemory";
import { AgentCharts, type AnalysisChart } from "./AgentCharts";
import { AgentSleepDatasets, type SleepDatasetItem } from "./AgentSleepDatasets";
import { AgentConversation, AgentDelivery, prependConversation, type Conversation, type Evidence, type Report, type Progress, type HistoricalDelivery } from "./AgentDelivery";
import "./AgentInvestigation.css";
import "./AgentAssistantRefinement.css";

import { AgentGoalAssessment, type GoalAssessment } from "./AgentGoalAssessment";
import { AgentTaskTree, type TaskTree } from "./AgentTaskTree";
import { AgentGoalRevision, type GoalRevision } from "./AgentGoalRevision";
import { AgentLifecycle, lifecycleRequest, acceptLifecycleSnapshot, canRunMode, type Lifecycle } from "./AgentLifecycle";
import type { ConversationMessage } from "./AgentDelivery";
import type { ArchiveAction, FlashcardAction } from "./AgentActionTypes";
import { AgentMaterialBudget, type MaterialBudget } from "./AgentMaterialBudget";
import { AgentContextCompaction, type NativeCompaction } from "./AgentContextCompaction";
import { AgentWorkingState, type WorkingState } from "./AgentWorkingState";
import { AgentExternalReport } from "./AgentExternalReport";
import { useAgentConversationScroll } from "./useAgentConversationScroll";

type NoteLocator = { kind: "note"; libraryId: string; documentId: string; pageId: string | null };
type ReadingLocator = { kind: "reading"; itemKey: string };
type TaskLocator = { kind: "task"; libraryId: string; sourceId: string };
type AttachmentLocator = { kind: "attachment"; libraryId: string; documentId: string; sourceItemId: string; chunkId: string; pageNumber: number };
export type InvestigationLocator = NoteLocator | ReadingLocator | TaskLocator | AttachmentLocator;
type ReportContinuation = { expectedWorkRevision:number; expectedAuthorizationVersion:number; artifactId:string; artifactRevision:number; expectedContentHash:string };
type View = { answerSaves?:AnswerSave[];tagTasks?:TagTaskRecord[]; followups?:Followup[]; codexAccountBinding?:{scopeId:string;historyShared?:boolean}|null; nativeContext?:NativeContext|null; nativeInputs?: NativeInput[]; contextCompaction?:NativeCompaction; materialBudget?:MaterialBudget|null; workingState?: WorkingState; lifecycle?: Lifecycle; goalRevision?: GoalRevision; taskTree?: TaskTree; goalAssessment?: GoalAssessment; analysisArtifacts?: AnalysisChart[]; sleepDatasets?: SleepDatasetItem[]; activity?:ActivityRun[]; recordVersion?:number; assistantOptions?: AssistantOptions; draftRequest?: {runId:string;kind:string} | null; work: { id: string; anchor?:InvestigationLocator|null; actionTarget?:NoteLocator|null; actionTargetIdentity?:string; goal: string; revision?: number; authorizationVersion?: number; state: string; report: Report | null; grant: { images?:ImageGrant[]; libraryIds: string[]; notes?: NoteLocator[]; sources?:InvestigationLocator[]; readingItemKeys?:string[]; manifest?: {members:NoteLocator[];selection:SourceSelection;snapshot:string} } }; evidence: Evidence[]; decisions: { text: string; author: string }[]; run: { id?: string; error?: string; usage: { agentSessions?: number; modelCalls?: number; modelRetries?: number; outputRepairs?: number; entitiesRead?: number; bodyChars?: number; localScanDocuments?: number; localScanBytes?: number } } | null; validity: string; conversation?: Conversation; progress?: Progress | null; history?: HistoricalDelivery[]; runActive?: boolean; actionActive?: boolean; actions?: AgentActions; watch?: AgentCondition | null; memoryUse?: MemoryUse | null; modelSelection?: CodexSettings | null; modelExecutions?: ModelExecution[] };
function historyViewScope(view: View | null) {
  return view ? JSON.stringify([view.work.id,view.work.revision,view.work.authorizationVersion,view.work.grant,view.work.state,view.recordVersion]) : "";
}
function sameNoteAnchor(a:InvestigationLocator|null|undefined,b:InvestigationLocator|null|undefined){
  return a?.kind==="note"&&b?.kind==="note"&&a.libraryId===b.libraryId&&a.documentId===b.documentId&&a.pageId===b.pageId;
}
function sameWorkAnchor(a:InvestigationLocator|null|undefined,b:InvestigationLocator|null|undefined){
 if(!a||!b)return !a&&!b;
 if(a.kind==="note")return sameNoteAnchor(a,b);
 if(a.kind==="reading")return b.kind==="reading"&&a.itemKey===b.itemKey;
 if(a.kind==="task")return b.kind==="task"&&a.libraryId===b.libraryId&&a.sourceId===b.sourceId;
 return b.kind==="attachment"&&a.libraryId===b.libraryId&&a.documentId===b.documentId&&a.sourceItemId===b.sourceItemId&&a.chunkId===b.chunkId&&a.pageNumber===b.pageNumber;
}
type WorkListCursor = { updatedAt: number; id: string; pinned?:boolean; anchor: InvestigationLocator | null; query?:string; archived?:boolean };
type WorkListPage = { works: WorkSummary[]; nextCursor?: WorkListCursor | null };
const states: Record<string, string> = { paused: "本轮已停止", cancelled: "目标已取消", ready: "可以开始", investigating: "正在处理", completed: "本轮已完成", needsDecision: "需要你的决定", waiting: "等待条件满足", insufficientEvidence: "证据不足", interrupted: "已中断，可继续", failed: "本次调查失败", expired: "需要重新核对来源", revoked: "授权已撤回" };
const call = <T,>(args: Record<string, unknown>) => invoke<T>("agent_investigation", { args });

export function investigationAnchor(result: SearchResult): Exclude<InvestigationLocator, ReadingLocator> | null {
  if (!runtimeCapabilities.desktop || !result.documentId) return null;
  const libraryId = result.libraryId || result.spaceId;
  if (result.sourceItemId) return ["pdf_page", "pdf_ocr", "image_ocr"].includes(result.contentType) && result.id && Number.isSafeInteger(result.pageNumber) && result.pageNumber! > 0
    ? { kind: "attachment", libraryId, documentId: result.documentId, sourceItemId: result.sourceItemId, chunkId: result.id, pageNumber: result.pageNumber! } : null;
  // Preview lookup admits ordinary Craft blocks as possible task matches. An
  // investigation needs an explicit task identity before choosing task scope.
  const explicitTask = !!result.taskSourceId || result.contentType === "task" || ["craft_task", "obsidian_task"].includes(result.sourceType) || result.provider === "dida365";
  if (explicitTask && isTaskPreviewResult(result)) {
    const sourceId = result.taskSourceId || (result.provider === "dida365" ? result.documentId : result.sourceType === "craft_task" ? result.blockId : undefined);
    return sourceId ? { kind: "task", libraryId, sourceId } : null;
  }
  if (!["craft", "obsidian"].includes(result.provider)) return null;
  return { kind: "note", libraryId: result.libraryId || result.spaceId, documentId: result.documentId, pageId: result.provider === "craft" ? result.pageId || result.blockId || result.documentId : null };
}

export function AgentInvestigation(props: { result: SearchResult; compact?: boolean; onPreviewCitation?: (value: CitationLocation | null) => void }) {
 const open=useContext(AgentPanelContext);
 const browsing=useContext(AgentBrowsingContext);
 useEffect(()=>{const entry={result:props.result};browsing?.setEntry(entry);return()=>browsing?.setEntry(current=>current===entry?null:current);},[props.result,browsing?.setEntry]);
 return open ? <button type="button" className="agent-launcher agent-launcher-compact" aria-label="询问助手" title="打开 Hub 助手" onClick={()=>open({result:props.result})}><MessageSquare size={18}/></button> : <PersistentSourceInvestigation {...props}/>;
}
export function PersistentSourceInvestigation({ result, compact = false, onPreviewCitation, initiallyOpen=false, startFresh=false }: { result: SearchResult; compact?: boolean; onPreviewCitation?: (value: CitationLocation | null) => void; initiallyOpen?:boolean; startFresh?:boolean }) {
  const [pinned, setPinned] = useState<SearchResult | null>(initiallyOpen?result:null);
  const [newChat, setNewChat] = useState(0);
  const [topicWork,setTopicWork]=useState<{id:string;source:SearchResult;draft?:string;back?:{id?:string;source:SearchResult}}|null>(null);
  const context = topicWork?.source || pinned || result;
  const openTopicWork=(id:string,source:TopicWorkSource,originId?:string,draft?:string)=>{
    const a=source.anchor;
    if(a.kind!=="note"||a.pageId!==null)throw new Error("本期导航只支持 Obsidian 笔记");
    const selected:SearchResult={id:`topic-work:${id}`,entityKey:`page:${a.libraryId}:${a.documentId}`,provider:"obsidian",libraryId:a.libraryId,libraryName:source.libraryName,spaceId:a.libraryId,spaceName:source.libraryName,documentId:a.documentId,title:source.title,documentTitle:source.title,path:source.path,contentType:"markdown",sourceType:"note",snippet:"",matchTerms:[],matchField:"",matchCount:0,subMatches:[]};
    setTopicWork({id,source:selected,draft,back:{id:originId,source:context}});
  };
  const backToTopic=()=>{const back=topicWork?.back;if(back){setPinned(back.source);setTopicWork(back.id?{id:back.id,source:back.source}:null);}};
  const anchor = investigationAnchor(context);
  const changed = !!pinned && JSON.stringify(investigationAnchor(result)) !== JSON.stringify(anchor);
  const startNew = () => { setTopicWork(null); setPinned(result); setNewChat(value=>value+1); };
  return anchor ? <Investigation onPreviewCitation={onPreviewCitation} key={JSON.stringify(anchor)+":"+(topicWork?.id||"")+":"+newChat} anchor={anchor} initialWorkId={topicWork?.id} initialDraft={topicWork?.draft} startNew={startFresh||newChat>0} onNewConversation={startNew} onOpenTopicWork={openTopicWork} onTopicBack={topicWork?.back?backToTopic:undefined} libraryName={context.libraryName || context.spaceName} sourceTitle={context.documentTitle || context.title} canEditNote={runtimeCapabilities.localVault && context.provider === "obsidian" && anchor?.kind === "note"} compact={compact} initialOpen={!!pinned||!!topicWork} onPin={() => setPinned(context)} newSource={changed && investigationAnchor(result) ? { title: result.documentTitle || result.title, use: startNew } : undefined} /> : null;
}
export function StandaloneInvestigation({ initiallyOpen=false, startFresh=false }: { initiallyOpen?:boolean; startFresh?:boolean } = {}) {
  const [generation,setGeneration]=useState(0);
  return runtimeCapabilities.desktop ? <Investigation key={generation} anchor={null} libraryName="" initialOpen={initiallyOpen || generation>0} startNew={startFresh||generation>0} onNewConversation={()=>setGeneration(value=>value+1)}/> : null;
}
export function ExistingWorkInvestigation({workId,question}:{workId:string;question?:AgentQuestion}){
 const {source,error}=useInsightWork(workId);
 return error?<p role="alert">{error}</p>:source?<Investigation key={source.id} anchor={source.anchor} libraryName="" initialOpen initialWorkId={source.id} suggestedQuestion={question}/>:<p role="status">正在打开原事项…</p>;
}
export function ReadingInvestigation({itemKey,title}:{itemKey:string;title?:string}) {
 const open=useContext(AgentPanelContext);
 const browsing=useContext(AgentBrowsingContext);
 useEffect(()=>{const entry={itemKey,title};browsing?.setEntry(entry);return()=>browsing?.setEntry(current=>current===entry?null:current);},[itemKey,title,browsing?.setEntry]);
 return open ? <button type="button" className="agent-launcher" onClick={()=>open({itemKey})}><MessageSquare size={18}/>询问助手</button> : <PersistentReadingInvestigation itemKey={itemKey}/>;
}
export function PersistentReadingInvestigation({ itemKey, initiallyOpen=false, startFresh=false }: { itemKey: string; initiallyOpen?:boolean; startFresh?:boolean }) {
  const [pinned, setPinned] = useState<string | null>(initiallyOpen?itemKey:null);
  const [newChat,setNewChat]=useState(0);
  const context=pinned || itemKey;
  const startNew=()=>{setPinned(itemKey);setNewChat(value=>value+1);};
  return runtimeCapabilities.desktop && context ? <Investigation key={context+":"+newChat} anchor={{ kind: "reading", itemKey: context }} libraryName="当前阅读条目" initialOpen={!!pinned} startNew={startFresh||newChat>0} onNewConversation={startNew} onPin={() => setPinned(context)} newSource={pinned && pinned!==itemKey ? {title:"当前阅读条目",use:startNew} : undefined} /> : null;
}

function Investigation({ onPreviewCitation, anchor: pageAnchor, libraryName: pageLibraryName, sourceTitle: pageTitle, canEditNote: pageCanEditNote = false, compact = false, initialOpen = false, initialWorkId, initialDraft, suggestedQuestion, startNew=false, onNewConversation, onOpenTopicWork, onTopicBack, onPin, newSource }: { onPreviewCitation?: (value: CitationLocation | null) => void; anchor: InvestigationLocator|null; libraryName: string; sourceTitle?: string; canEditNote?: boolean; compact?: boolean; initialOpen?: boolean; initialWorkId?:string; initialDraft?:string; suggestedQuestion?:AgentQuestion; startNew?:boolean; onNewConversation?:()=>void; onOpenTopicWork?:(id:string,source:TopicWorkSource,originId?:string,draft?:string)=>void; onTopicBack?:()=>void; onPin?: () => void; newSource?: { title: string; use: () => void } }) {
  const browsing=useContext(AgentBrowsingContext);
  const tagRequest=useContext(AgentTagRequestContext);
  const textMaterials=useContext(AgentTextMaterialContext);
  const [snippets,setSnippets]=useState<TextMaterial[]>([]);
  const [imageDraft,setImageDraft]=useState<ImageGrant[]|null>(null);
  const fileInput=useRef<HTMLInputElement>(null);
  const importingFiles=useRef(false);
  const [dropped,setDropped]=useState<{locator:InvestigationLocator;title:string}[]>([]);
  const accountVisible = useContext(AgentAccountVisibleContext);
  const globalPanel = useContext(AgentPanelContext);
  const [requestedOpen, setOpen] = useState(initialOpen);
  const open = requestedOpen && accountVisible;
  useEffect(()=>{const show=()=>{if(accountVisible)setOpen(true);};window.addEventListener('hub:show-agent',show);return()=>window.removeEventListener('hub:show-agent',show);},[accountVisible]);
  const detailsTrigger=useRef<HTMLButtonElement>(null);
  const detailsReturn=useRef<HTMLElement|null>(null);
  const detailsPopover=useAgentPopover({triggerRef:detailsTrigger,returnFocusRef:detailsReturn,deferEscapeSelector:".agent-history-search input, .agent-history-action-menu, .agent-details-sections .agent-popover[open]"});
  const detailsMenu=detailsPopover.ref;
  const [historyExpanded,setHistoryExpanded]=useState(true);
  const [taskStatusOnly,setTaskStatusOnly]=useState(false);
  const workControls=useRef<HTMLDetailsElement>(null);
  const materialPopover=useAgentPopover();
  const [addMenuOpen,setAddMenuOpen]=useState(false);
  const [addPage,setAddPage]=useState<"home"|"materials"|"scope"|"skills"|"web"|"images"|"pages">("home");
  const addBack=useRef<HTMLButtonElement>(null);
  useEffect(()=>{if(addMenuOpen){if(["scope","materials","skills"].includes(addPage))materialPopover.ref.current?.querySelector<HTMLButtonElement>(".agent-popover-header>button:last-child")?.focus();else if(addPage!=="home")addBack.current?.focus();else materialPopover.ref.current?.querySelector<HTMLButtonElement>(".agent-add-choices button")?.focus();}},[addPage,addMenuOpen]);
  const panelId = useId();
  const launcher = useRef<HTMLButtonElement>(null);
  const floatingLauncher = useRef<HTMLButtonElement>(null);
  const loaded = useRef(initialOpen);

  const [draftRevision, setDraftRevision] = useState(0);
  const [draftSession,setDraftSession]=useState(()=>crypto.randomUUID());
  const [view, setView] = useState<View | null>(null);
  const selectionScope=useRef("");
  selectionScope.current=`${accountVisible}:${view?.work.id||draftSession}`;
  const [research,setResearch]=useResearchSelection(view?.work.id||draftSession);
  const historyJob=useRef<{scope:string} | null>(null);
  const historyScope=useRef("");
  historyScope.current=historyViewScope(view);
  const [historyLoadingScope,setHistoryLoadingScope]=useState<string | null>(null);
  const [historyNotice,setHistoryNotice]=useState<{scope:string;text:string} | null>(null);
  const [works, setWorks] = useState<WorkSummary[]>([]);
  const [worksCursor, setWorksCursor] = useState<WorkListCursor | null>(null);
  const [worksLoading, setWorksLoading] = useState(initialOpen);
  const worksJob = useRef(0);
  const worksRequest = useRef(0);
  const [historyQuery,setHistoryQuery] = useState("");
  const [historyArchived,setHistoryArchived] = useState(false);
  const historyFilter = useRef({query:"",archived:false});
  const libraryRegistry = useAgentLibraryRegistry(open);
  const [worksError, setWorksError] = useState("");
  const [goal, setGoal] = useState(initialDraft||"");
  const [usedQuestion,setUsedQuestion]=useState("");
  const skillPrefix = goal.match(/^(?:\$[a-z0-9]+(?:-[a-z0-9]+)*\s+)+/)?.[0] || "";
  const selectedSkills = [...new Set(skillPrefix.match(/\$[a-z0-9]+(?:-[a-z0-9]+)*/g) || [])];
  const questionText = goal.slice(skillPrefix.length);
  const [wholeLibrary, setWholeLibrary] = useState(false);
  const [libraryDraft,setLibraryDraft]=useState<AgentLibrary[]|null>(null);
  const selectedLibraries = resolveAgentLibraries(libraryDraft ?? (research?.manual.libraryIds||view?.work.grant.libraryIds||[]).map(id=>({id,name:""})),libraryRegistry);
  const changeLibraries=(items:AgentLibrary[])=>{
    setLibraryDraft(items);setWholeLibrary(false);
  };
  const [materials, setMaterials] = useState<AgentMaterial[]>([]);
  const [pageAttached,setPageAttached]=useState(!!pageAnchor);
  const boundMaterial=useRef<AgentMaterial|null>(null);
  const anchor=view ? (view.work.anchor===undefined ? pageAnchor : view.work.anchor) : (pageAttached ? pageAnchor : materials[0]?.locator ?? dropped[0]?.locator ?? null);
  const primaryMaterial=materials.find(item=>sameNoteAnchor(item.locator,anchor)) || (sameNoteAnchor(boundMaterial.current?.locator,anchor) ? boundMaterial.current : null);
  const sourceTitle=primaryMaterial?.title || (view?.work.anchor && pageAnchor?.kind==="note" && !sameNoteAnchor(view.work.anchor,pageAnchor) ? view.evidence[0]?.title || "对话资料" : pageTitle);
  const libraryName=primaryMaterial?.libraryName || pageLibraryName;
  const composerLibraries = !view && wholeLibrary && anchor?.kind==="note" ? resolveAgentLibraries([{id:anchor.libraryId,name:libraryName}],libraryRegistry) : selectedLibraries;
  const canEditNote=pageCanEditNote && sameNoteAnchor(anchor,pageAnchor) && (pageAttached || !!view);
  const hasDraftSources=selectedLibraries.length>0 || pageAttached || materials.length>0 || dropped.length>0 || snippets.length>0;
  const [removals, setRemovals] = useState<NoteLocator[]>([]);
  const coreMaterialCount=new Set([...(view?.work.grant.notes||[]).filter(note=>!removals.some(removed=>materialKey(removed)===materialKey(note))).map(materialKey),...materials.map(item=>materialKey(item.locator)),...dropped.map(item=>item.locator.kind==="note"?materialKey(item.locator):JSON.stringify(item.locator)),...(!view&&pageAttached&&anchor?[anchor.kind==="note"?materialKey(anchor):JSON.stringify(anchor)]:[])]).size;

  const [memorySelection, setMemorySelection] = useState<MemorySelection>(loadMemoryPreference);
  const mode = view?.lifecycle?.executionModes?.deep ? "deep" : "quick";
  const researchPending=useRef<typeof research>(null);
  const [topicsOpen,setTopicsOpen]=useState(false),[topicSave,setTopicSave]=useState(false);
  const [requestedTopic,setRequestedTopic]=useState<string>();
  const [tagPreparation,setTagPreparation]=useTagPreparation(view?.work.id||draftSession);
  const tagMode=!!tagPreparation.active;
  const setTagMode=(active:boolean)=>setTagPreparation({...tagPreparation,active});
  const prepareTagTask=(task=tagPreparation.task)=>setTagPreparation({...tagPreparation,active:true,task,tag:tagPreparation.tag||tagPreparation.references[0],compare:tagPreparation.compare||tagPreparation.references.find(t=>t.tagId!==(tagPreparation.tag||tagPreparation.references[0])?.tagId)});
  const enableTagMode=()=>prepareTagTask();
  const tagSuggestion=!tagMode?suggestedTagTask(questionText):null;
  const tagPending=useRef<typeof tagPreparation|null>(null);
  const [tagSearchOpen,setTagSearchOpen]=useState(false);
  useEffect(()=>{if(view&&tagPending.current){setTagPreparation(tagPending.current);tagPending.current=null;}},[view?.work.id]);
  const [pinnedSkills,setPinnedSkills]=useState<string[]>(()=>{try{const v=JSON.parse(userProfileStorage.getItem("hub.agent.pinned-skills.v1")||"[]");return Array.isArray(v)?v.filter((x:unknown)=>typeof x==="string"):[];}catch{return [];}});
  const toggleSkillPin=(name:string)=>setPinnedSkills(current=>{const next=current.includes(name)?current.filter(x=>x!==name):[...current,name];userProfileStorage.setItem("hub.agent.pinned-skills.v1",JSON.stringify(next));return next;});
  const [draftOptions,setAssistantOptions]=useState<AssistantOptions>(loadAgentPreferences);
  const runtime = useCodexSuite();
  const assistantOptions = (draftOptions.model ?? runtime.settings)?.provider === "deepseek" ? {...draftOptions, webSearch: "disabled" as const} : draftOptions;
  const cancelResponse=useRef(false);
  const pendingAccountHistory=useRef<{id:string;scopeId:string}|null>(null);
  const [confirmMessage, setConfirmMessage] = useState(false);
  const [sourceVisible, setSourceVisible] = useState(false);
  const [reportReading, setReportReading] = useState(false);
  const readingOrigin=useRef<{scope:string;scrollTop:number;focus:HTMLElement|null}|null>(null);
  const [sourcePreview, setSourcePreview] = useState<{excerpt: Evidence; quote: string} | null>(null);
  const [sourceError, setSourceError] = useState("");
  const [sourceLoading, setSourceLoading] = useState(false);
  const globalCitation=useContext(AgentCitationContext);
  onPreviewCitation = onPreviewCitation ?? globalCitation?.show;
  const citationOpen = sourceVisible || !!sourcePreview || !!sourceError || sourceLoading;
  const sourcePreviewElement = useRef<HTMLElement>(null);
  const sourceSequence = useRef(0);
  const sourceScope = useRef("");
  const citationReturn = useRef<{scope:string;ticket:number;reading:boolean;scrollTop:number;focus:HTMLElement|null;pending:boolean}|null>(null);
  const sourceScopeKey = view ? JSON.stringify([view.work.id,view.work.revision,view.work.authorizationVersion,view.work.grant,view.work.state==="revoked"]) : "";
  function clearSourcePreview() {
    onPreviewCitation?.(null);
    sourceSequence.current++; sourceScope.current=""; citationReturn.current=null;
    setSourceVisible(false);
    setSourcePreview(null); setSourceError(""); setSourceLoading(false);
  }
  useEffect(()=>{ clearSourcePreview(); return ()=>onPreviewCitation?.(null); },[sourceScopeKey]);
  function returnFromCitation() {
    onPreviewCitation?.(null);
    setSourceVisible(false);
    setSourcePreview(null); setSourceError(""); setSourceLoading(false);
    const origin=citationReturn.current;
    const ticket=sourceSequence.current++;
    if(origin && origin.scope===sourceScope.current && origin.ticket===ticket) {
      origin.ticket=sourceSequence.current;
      origin.pending=true;
      setReportReading(origin.reading);
    } else {
      citationReturn.current=null;
      conversationScroll.element.current?.focus({preventScroll:true});
    }
  }
  const panelResize = useAgentPanelResize(open, launcher);
  const [docked, setDocked] = useState(() => sessionStorage.getItem("hub-agent-docked") === "true");
  const panelHeightResize = useAgentPanelResize(open && !docked, launcher, "height");
  useEffect(() => { sessionStorage.setItem("hub-agent-docked", String(docked)); }, [docked]);
  const titleQuestion=(view?.work.goal||questionText).replace(/^(?:\$[a-z0-9]+(?:-[a-z0-9]+)*(?:\s+|$))+/g, "").trim();
  const chatTitle = research?.topic.title || (titleQuestion || "新聊天").replace(/\s+/g, " ");
  useEffect(() => {
    if (!accountVisible) return;
    document.body.classList.toggle("agent-sidebar-open", open && docked);
    return () => document.body.classList.remove("agent-sidebar-open");
  }, [open, docked, accountVisible]);
  const { width: panelWidth } = panelResize;
  const messageIdentity = useRef<{ text: string; id: string } | null>(null);
  const manifestIdentity = useRef<{key:string;id:string}|null>(null);
  const scopeIdentity = useRef<{ key: string; id: string } | null>(null);
  useEffect(()=>{
    if (!view) return;
    setRemovals(current=>{
      const pending=current.filter(note=>view.work.grant.notes?.some(n=>n.libraryId===note.libraryId && n.documentId===note.documentId && n.pageId===note.pageId));
      return pending.length===current.length ? current : pending;
    });
  },[view]);
  const [busy, setBusy] = useState(false);
  const [loadingConversation, setLoadingConversation] = useState(false);
  const [filePreparing,setFilePreparing]=useState(false);
  const [pendingRun, setPendingRun] = useState(false);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const businessInFlight = useRef<object | null>(null);
  const businessChecks = useRef(new Map<string, { actionId?: string; afterSequence: number; uncertain: boolean; checking: boolean; scopeChanging: boolean }>());
  const observedVersions = useRef(new Map<string, number>());
  const [, redrawBusinessCheck] = useState(0);
  if (view?.recordVersion !== undefined) observedVersions.current.set(view.work.id, Math.max(observedVersions.current.get(view.work.id) ?? -Infinity, view.recordVersion));
  const businessCheck = view ? businessChecks.current.get(view.work.id) : undefined;
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState("");
  const alive = useRef(true);
  const sequence = useRef(0);
  const refreshJob = useRef<{ id: string; ticket: number; requested: number; promise: Promise<View> } | null>(null);
  const goalInput = useRef<HTMLTextAreaElement>(null);
  const statusElement = useRef<HTMLParagraphElement>(null);
  const conversationScroll = useAgentConversationScroll(open, view?.work.id, JSON.stringify([view?.recordVersion,view?.conversation?.messages.length,view?.work.state]));
  const visible = useDocumentVisible();
  const uiTiming = useAgentUiTiming(view, open && visible, busy || pendingRun);
  const running = pendingRun || view?.runActive || view?.work.state === "investigating";
  const acting = !!pendingAction || view?.actionActive;
  const active = running || acting;
  useEffect(()=>{if(!open||!accountVisible||!tagRequest?.pending||active||busy)return;const selected=tagRequest.pending;setTagPreparation({...tagPreparation,active:true,task:selected.task,tag:{tagId:selected.tagId,label:selected.label},resume:false});tagRequest.setPending(null);},[open,accountVisible,tagRequest?.pending,active,busy]);
  const controlsNeedAttention = !!(view?.materialBudget?.preflight?.allowed===false || view?.materialBudget?.overrunBytes || view?.lifecycle?.requiresExplicitResume || view?.lifecycle?.unresolvedActions || view?.lifecycle?.reason || view?.lifecycle?.usageCompleteness==="incomplete");
  const reportChart=view?.analysisArtifacts?.length===1 ? view.analysisArtifacts[0] : undefined;
  const reportHash=reportChart?.content?.contentHash;
  const reportContinuation:ReportContinuation|null=view && !view.work.report &&
    ["ready","interrupted","failed","expired","paused","cancelled"].includes(view.work.state) &&
    view.work.revision!==undefined && Number.isSafeInteger(view.work.revision) && view.work.revision>0 &&
    view.work.authorizationVersion!==undefined && Number.isSafeInteger(view.work.authorizationVersion) && view.work.authorizationVersion>0 &&
    reportChart?.state==="checked" && typeof reportHash==="string" && /^[a-f0-9]{64}$/.test(reportHash)
    ? {expectedWorkRevision:view.work.revision,expectedAuthorizationVersion:view.work.authorizationVersion,artifactId:reportChart.artifactId,artifactRevision:reportChart.revision,expectedContentHash:reportHash} : null;
  const reportProvider=(view?.assistantOptions?.model || view?.modelSelection)?.provider;
  const reportDisabled=busy || !!active || !!businessCheck || reportProvider!=="codex" ||
    view?.lifecycle?.executionModes?.[mode]!==true || (!!view.lifecycle?.requiresExplicitResume && !view.lifecycle.canResume);
  const businessDisabled = busy || !!active || !!businessCheck;
  const steerable=!view?.lifecycle?.requiresExplicitResume && view?.activity?.find(run=>run.running && run.canSteer);
  const saveOnly=!!view && (!!view.lifecycle?.requiresExplicitResume || !canRunMode(view.lifecycle,mode));
  const isReading = anchor?.kind === "reading";
  const currentObjectLabel = !anchor ? "未添加资料" : isReading ? "这一阅读条目" : anchor?.kind === "task" ? "当前任务" : anchor?.kind === "attachment" ? "当前附件文字片段" : "当前笔记页面";
  const entryLabel = !anchor ? "Hub 助手" : isReading ? "调查这篇阅读材料" : anchor?.kind === "task" ? "调查这项任务" : anchor?.kind === "attachment" ? "调查这个附件片段" : "调查这篇笔记";
  const closePanel = () => { clearSourcePreview(); setSourceVisible(false); setOpen(false); };
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing || event.defaultPrevented || isInsideKeyboardDialog(event.target)) return;
      event.preventDefault();
      event.stopPropagation();
      closePanel();
    };
    document.addEventListener("keydown", dismiss, true);
    return () => document.removeEventListener("keydown", dismiss, true);
  }, [open, onPreviewCitation]);
  useEffect(() => { setReportReading(false); }, [view?.work.id, open]);
  useEffect(() => { if (active || view?.work.state==="revoked") {citationReturn.current=null;setReportReading(false);} }, [active, view?.work.state]);
  useEffect(() => {
    const element=conversationScroll.element.current;
    if (citationOpen || !element || detailsMenu.current?.open) return;
    const origin=citationReturn.current;
    if(origin?.pending) {
      citationReturn.current=null;
      if(origin.scope===sourceScope.current && origin.ticket===sourceSequence.current) {
        conversationScroll.holdPosition();
        element.scrollTop=origin.scrollTop;
        (origin.focus?.isConnected && element.contains(origin.focus) ? origin.focus : element).focus({preventScroll:true});
      }
      return;
    }
    if (!reportReading) {
      const origin=readingOrigin.current;readingOrigin.current=null;
      if(origin?.scope===sourceScopeKey){conversationScroll.holdPosition();element.scrollTop=origin.scrollTop;origin.focus?.isConnected&&origin.focus.focus({preventScroll:true});}
      return;
    }
    conversationScroll.holdPosition();
    const answers=element.querySelectorAll<HTMLElement>(".agent-message-assistant");
    const latest=answers[answers.length-1] || element.querySelector<HTMLElement>(".agent-report");
    if(latest)element.scrollTop+=latest.getBoundingClientRect().top-element.getBoundingClientRect().top;
    element.focus();
  },[reportReading,citationOpen]);
  useLayoutEffect(() => { if(sourcePreview || sourceError || sourceLoading) sourcePreviewElement.current?.querySelector<HTMLButtonElement>("button")?.focus({preventScroll:true}); },[sourcePreview,sourceError,sourceLoading]);
  useEffect(() => { if (!open && loaded.current && accountVisible) floatingLauncher.current?.focus(); }, [open, accountVisible]);
  useEffect(() => { if (open && (!view || initialDraft) && !busy && !detailsMenu.current?.open) goalInput.current?.focus(); }, [open, view?.work.id, busy, initialDraft]);
  const latestAction = view?.actions?.items[0];
  const actionLabel = latestAction?.kind === "obsidianEdit" ? "笔记修改" : latestAction?.kind === "archiveCopy" ? "归档" : latestAction?.kind === "flashcardDrafts" ? "闪卡提交" : "补标提交";
  const pendingLabel = pendingAction?.includes("ObsidianEdit") || (!pendingAction && latestAction?.kind === "obsidianEdit") ? "正在处理笔记修改…" : pendingAction?.includes("Archive") || (!pendingAction && latestAction?.kind === "archiveCopy") ? "正在处理归档动作…" : pendingAction?.includes("Flashcards") || (!pendingAction && latestAction?.kind === "flashcardDrafts") ? "正在处理闪卡草稿…" : "正在处理补标建议…";
  useEffect(() => {
    if (open && view && document.activeElement === document.body) statusElement.current?.focus();
  }, [open, view?.work.id, view?.work.state, view?.actions?.items[0]?.state]);
  useEffect(() => { alive.current = true; return () => { alive.current = false; sequence.current++; }; }, []);
  const refresh = (id: string): Promise<View> => {
    const current = refreshJob.current;
    if (current?.id === id && current.ticket === sequence.current) {
      current.requested++;
      return current.promise;
    }
    const job = { id, ticket: ++sequence.current, requested: 1, promise: null as unknown as Promise<View> };
    refreshJob.current = job;
    job.promise = Promise.resolve().then(async () => {
      for (;;) {
        const requested = job.requested;
        const requestedAt = performance.timeOrigin + performance.now();
        const value = await call<View>({ action: "status", id });
        if (!alive.current || job.ticket !== sequence.current) return value;
        if (value.work.id !== id) throw new Error("返回的事项状态不匹配，请重新核对");
        if(id===initialWorkId&&!sameWorkAnchor(value.work.anchor,anchor))throw new Error("本期工作与实际笔记锚点不一致，未显示内容");
        const knownVersion = observedVersions.current.get(id);
        const currentEnough = knownVersion === undefined || (value.recordVersion !== undefined && value.recordVersion >= knownVersion);
        if (currentEnough) {
          if (value.recordVersion !== undefined) observedVersions.current.set(id, value.recordVersion);
          uiTiming.snapshotReceived(value, requestedAt);
          setView(current=>current?.work.id===value.work.id && current.recordVersion!==undefined && value.recordVersion!==undefined && current.recordVersion>value.recordVersion ? current : acceptLifecycleSnapshot(current,value));
          const check = businessChecks.current.get(id);
          if (check && job.ticket >= check.afterSequence && job.requested === requested) {
            businessChecks.current.delete(id);
            if (check.uncertain || value.actions?.items.some(item => item.id === check.actionId && item.state === "verified")) setError("");
            redrawBusinessCheck(value => value + 1);
          }
        }
        // Events received during this read require one fresh snapshot. They
        // share this job rather than starting overlapping native projections.
        if (job.requested === requested) return value;
      }
    }).finally(() => { if (refreshJob.current === job) refreshJob.current = null; });
    void job.promise.catch(reason => { if (alive.current && job.ticket === sequence.current) setError(String(reason)); });
    return job.promise;
  };
  const loadEarlier = async () => {
    const current=view;
    if (!current?.conversation?.nextCursor || businessDisabled || current.work.state==="revoked" || historyJob.current?.scope===historyScope.current) return;
    const cursor=current.conversation.nextCursor, scope=historyScope.current, ticket=sequence.current;
    const job={scope}; historyJob.current=job;
    setHistoryLoadingScope(scope); setHistoryNotice(null);
    const eligible=()=>alive.current && historyJob.current===job && sequence.current===ticket && historyScope.current===scope;
    try {
      if (current.work.revision===undefined || current.work.authorizationVersion===undefined) throw new Error("历史状态需要刷新后再查看");
      const page=await call<{workId:string;workRevision:number;authorizationVersion:number;conversation:Conversation}>({action:"historyPage",id:current.work.id,before:cursor,expectedRevision:current.work.revision,expectedAuthorizationVersion:current.work.authorizationVersion});
      if (!eligible()) return;
      if (page.workId!==current.work.id || page.workRevision!==current.work.revision || page.authorizationVersion!==current.work.authorizationVersion) throw new Error("历史返回的事项或授权状态不匹配，请刷新后重试");
      setView(latest=>alive.current && sequence.current===ticket && historyViewScope(latest)===scope && latest?.conversation?.nextCursor===cursor && latest.work.state!=="revoked" ? {...latest,conversation:prependConversation(latest.conversation,page.conversation)} : latest);
    } catch(reason) {if (eligible()) setHistoryNotice({scope,text:String(reason)});}
    finally {if (historyJob.current===job) {historyJob.current=null;if(alive.current) setHistoryLoadingScope(null);}}
  };
  const revalidate = async (id: string) => {
    // A previously displayed answer stays hidden until the host has checked
    // its dependencies again. A failed check must not restore the old answer.
    setSourcePreview(null); setSourceLoading(false); setSourceError(""); sourceSequence.current++;
    sequence.current++;
    setView(current => current?.work.id === id ? { ...current, work: current.work.report ? { ...current.work, report: null, state: "expired" } : current.work, evidence: [], analysisArtifacts: [], progress: null, history: [], conversation: undefined, goalAssessment: undefined, taskTree: undefined, goalRevision: undefined, workingState: undefined } : current);
    return refresh(id);
  };
  useEffect(() => {
    if (open && visible && view) void revalidate(view.work.id).catch(reason => { if (alive.current) setError(String(reason)); });
  }, [open, visible]);
  const reloadWorks = async ():Promise<WorkListPage|null> => {
    const ticket=++worksRequest.current;
    worksJob.current=0;setWorksLoading(true);setWorksError("");
    try {
      const value = await call<WorkListPage>({action:"list",anchor:null,...historyFilter.current});
      if(!alive.current || ticket!==worksRequest.current)return null;
      setWorks(value.works);
      setWorksCursor(value.nextCursor??null);
      return value;
    }catch(reason){if(alive.current && ticket===worksRequest.current)setWorksError(String(reason));return null;}
    finally{if(alive.current && ticket===worksRequest.current)setWorksLoading(false);}
  };
  const filterHistory = (query:string,archived:boolean) => {
    const next={query:query.slice(0,200),archived};
    historyFilter.current=next;setHistoryQuery(next.query);setHistoryArchived(archived);
    setWorks([]);setWorksCursor(null);
    void reloadWorks();
  };
  const load = async () => {
    setError("");
    const history = reloadWorks();
    if (startNew && !initialWorkId) return;
    setBusy(true); setLoadingConversation(true);
    try {
      if(initialWorkId) await refresh(initialWorkId);
      else {
        const contextual=pageAnchor?await call<WorkListPage>({action:"list",anchor:pageAnchor}):await history;
        if(alive.current && contextual?.works[0])await refresh(contextual.works[0].id);
      }
    } catch (reason) { if (alive.current) setError(String(reason)); }
    finally { if (alive.current) { setBusy(false); setLoadingConversation(false); } }
  };
  useEffect(() => { if (initialOpen) void load(); }, []);
  const loadEarlierWorks = async () => {
    if (!worksCursor || worksJob.current || worksLoading || busy || active) return;
    const ticket=++worksRequest.current;
    worksJob.current=ticket;setWorksLoading(true);setWorksError("");
    try {
      const value=await call<WorkListPage>({action:"list",anchor:null,...historyFilter.current,before:worksCursor});
      if (!alive.current || ticket!==worksRequest.current) return;
      setWorks(current=>[...current,...value.works.filter(work=>!current.some(existing=>existing.id===work.id))]);
      setWorksCursor(value.nextCursor ?? null);
    } catch(reason) { if(alive.current && ticket===worksRequest.current) setWorksError(String(reason)); }
    finally { if(worksJob.current===ticket)worksJob.current=0;if(alive.current && ticket===worksRequest.current)setWorksLoading(false); }
  };
  const changeHistory=async(work:WorkSummary,change:HistoryChange)=>{
    if(busy || active)throw new Error("请等待当前操作结束后再修改对话历史");setBusy(true);setWorksError("");
    try{
      await call({action:"setHistoryPreference",id:work.id,...change});
      const updated={...work,...change};
      if(change.deleted===true || !!updated.archived!==historyFilter.current.archived)setWorks(current=>current.filter(item=>item.id!==work.id));
      else setWorks(current=>current.some(item=>item.id===work.id)?current.map(item=>item.id===work.id?updated:item):[updated,...current]);
      if(!alive.current)return;
      if(change.deleted && view?.work.id===work.id)newInvestigation(true);
      void reloadWorks();
    }catch(reason){if(alive.current)setWorksError(String(reason));throw reason;}finally{if(alive.current)setBusy(false);}
  };
  const openHistoryWork = async (work: WorkSummary) => {
    if(detailsMenu.current)detailsMenu.current.open=false;
    if(work.id===view?.work.id)return;
    setLibraryDraft(null);setError("");setGoal("");setMaterials([]);setDropped([]);setSnippets([]);setImageDraft(null);setRemovals([]);clearSourcePreview();
    setBusy(true);setLoadingConversation(true);
    try { await refresh(work.id); }
    catch(reason) { if(alive.current)setError(String(reason)); }
    finally { if(alive.current){setBusy(false);setLoadingConversation(false);} }
  };
  const openCitation = async (runId: string, evidenceIndex: number, quote: string, inline = false) => {
    if (!view || view.work.state === "revoked" || businessInFlight.current || businessChecks.current.has(view.work.id)) return;
    const ticket=++sourceSequence.current;
    const requestScope=sourceScopeKey; sourceScope.current=requestScope;
    const element=conversationScroll.element.current;
    const previous=citationOpen && citationReturn.current?.scope===requestScope ? citationReturn.current : null;
    citationReturn.current={scope:requestScope,ticket,reading:previous?.reading ?? reportReading,scrollTop:previous?.scrollTop ?? element?.scrollTop ?? 0,
      focus:previous?.focus ?? (document.activeElement instanceof HTMLElement && element?.contains(document.activeElement) ? document.activeElement : null),pending:false};
    onPreviewCitation?.(null);
    setSourcePreview(null); setSourceError(""); setSourceLoading(true);
    try {
      const value=await call<{excerpt:Evidence}>({action:"source",id:view.work.id,runId,evidenceIndex,quote});
      if(alive.current && ticket===sourceSequence.current && sourceScope.current===requestScope) {
        if (onPreviewCitation && !inline) {
          setReportReading(false); setSourceVisible(true);
          onPreviewCitation({...value,quote,onReturn:()=>{if(alive.current && ticket===sourceSequence.current && sourceScope.current===requestScope)returnFromCitation();}});
        } else setSourcePreview({...value,quote});
      }
    } catch(reason) { if(alive.current && ticket===sourceSequence.current) setSourceError(String(reason)); }
    finally { if(alive.current && ticket===sourceSequence.current) setSourceLoading(false); }
  };
  useEffect(() => {
    if (!open || !visible || (!active && !view?.watch?.enabled) || !view) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try { await refresh(view.work.id); }
      catch (reason) { if (!cancelled && alive.current) setError(String(reason)); }
      if (!cancelled) timer = setTimeout(poll, active ? 1500 : 30_000);
    };
    timer = setTimeout(poll, active ? 1500 : 30_000);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [open, visible, active, view?.work.id, view?.watch?.enabled]);

  useEffect(()=>{
    if(!open || !visible || !view) return;
    let disposed=false; let detach:(()=>void)|undefined; let timer:ReturnType<typeof setTimeout>|undefined;
    void listen<TimedEvent>("agent-work-updated",event=>{
      if(disposed || event.payload.workId!==view.work.id) return;
      uiTiming.observeEvent(event.payload);
      if(event.payload.eventCategory==="publicStream" && event.payload.publicHasText) {
        if(timer) { clearTimeout(timer); timer=undefined; }
        void refresh(view.work.id);
      } else if(!timer) {
        timer=setTimeout(()=>{timer=undefined;void refresh(view.work.id);},60);
      }
    }).then(value=>{if(disposed)value();else detach=value;}).catch(()=>{/* Snapshot polling remains available when the event bridge is absent. */});
    return ()=>{disposed=true;detach?.();if(timer)clearTimeout(timer);};
  },[open,visible,view?.work.id]);
  useEffect(()=>{const input=goalInput.current;if(input){input.style.height="auto";input.style.height=Math.min(160,Math.max(44,input.scrollHeight))+"px";}},[goal,open]);
  const changeCompaction = async (cancel=false) => {
    if(!view || busy || active || view.work.revision===undefined || view.work.authorizationVersion===undefined)return;
    const id=view.work.id;const ticket=sequence.current;
    setBusy(true);setError("");
    try {
      const value=await call<View>({action:cancel?"cancelContextCompaction":"requestContextCompaction",id,operationId:cancel?view.contextCompaction?.operationId:crypto.randomUUID(),expectedWorkRevision:view.work.revision,expectedAuthorizationVersion:view.work.authorizationVersion});
      if(alive.current && ticket===sequence.current)setView(current=>current?.work.id===id?acceptLifecycleSnapshot(current,value):current);
    }catch(reason){if(alive.current && ticket===sequence.current)setError(String(reason));}
    finally{if(alive.current)setBusy(false);}
  };
  const buildDraftGrant=()=>{
      const grant: {libraryIds:string[];notes:InvestigationLocator[];readingItemKeys:string[];sources?:InvestigationLocator[];attachmentLibraryIds?:string[]} = !anchor ? {libraryIds:[],notes:[],readingItemKeys:[]} : anchor.kind === "reading" ? { libraryIds: [], notes: materials.map(m=>m.locator), readingItemKeys: [anchor.itemKey] } : { libraryIds: wholeLibrary ? [anchor.libraryId] : [], ...(wholeLibrary ? { attachmentLibraryIds: [anchor.libraryId] } : {}), notes: [...(anchor?.kind === "note" && pageAttached && pageAnchor ? [pageAnchor] : []),...materials.map(m=>m.locator)], ...(anchor?.kind !== "note" ? { sources: [anchor] } : {}), readingItemKeys: [] };
      if(!anchor)return grant;
      for(const item of dropped){const loc=item.locator;if(loc.kind==="note"){if(!grant.notes.some(n=>JSON.stringify(n)===JSON.stringify(loc)))grant.notes.push(loc);}else if(loc.kind==="reading"){if(!grant.readingItemKeys.includes(loc.itemKey))grant.readingItemKeys.push(loc.itemKey);}else{const extended=grant as typeof grant & {sources:InvestigationLocator[]};extended.sources??=[];if(!extended.sources.some(n=>JSON.stringify(n)===JSON.stringify(loc)))extended.sources.push(loc);}}
    return grant;
  };
  const manualResearchGrant=():ResearchGrant=>{
    const base=research?.manual || (view?{libraryIds:view.work.grant.libraryIds,notes:view.work.grant.notes||[],sources:view.work.grant.sources||[],readingItemKeys:view.work.grant.readingItemKeys||[]}:buildDraftGrant() as ResearchGrant);
    const additions={libraryIds:libraryDraft?.map(l=>l.id)??base.libraryIds,notes:materials.map(m=>m.locator),sources:dropped.filter(m=>m.locator.kind!=="note"&&m.locator.kind!=="reading").map(m=>m.locator),readingItemKeys:dropped.flatMap(m=>m.locator.kind==="reading"?[m.locator.itemKey]:[])};
    additions.notes.push(...dropped.flatMap(m=>m.locator.kind==="note"?[m.locator]:[]));
    return {...researchGrant({...base,libraryIds:additions.libraryIds},additions,true),images:imageDraft??research?.manual.images??view?.work.grant.images??[]};
  };
  useEffect(()=>{if(view&&researchPending.current){setResearch(researchPending.current);researchPending.current=null;}},[view?.work.id]);
  const applyResearch=async(topic:ResearchTopic)=>{
    if(active||busy)throw Error("请在本轮结束后切换专题");
    const scope=selectionScope.current;
    const manual=manualResearchGrant();
    const previous=(view?.assistantOptions||assistantOptions).researchPolicy||"material-first";
    await saveAssistantOptions({...view?.assistantOptions||assistantOptions,researchPolicy:topic.policy},false);
    if(!alive.current||selectionScope.current!==scope)throw Error("对话已切换，请在当前对话重新选择专题");
    setResearch({topic,manual,manualPolicy:research?.manualPolicy||previous,includeManual:false});
    setLibraryDraft(manual.libraryIds.map(id=>({id,name:""})));setPublicUrl("");
  };
  const cancelResearch=async()=>{
    if(!research||busy||active)return;
    const manual=manualResearchGrant();
    setBusy(true);setError("");
    try{if(view){const next=await call<View>({action:"replaceResearchScope",id:view.work.id,grant:manual,expectedRevision:view.work.revision,expectedAuthorizationVersion:view.work.authorizationVersion});setView(next);await call({action:"configureAssistant",id:view.work.id,options:{...view.assistantOptions||assistantOptions,researchPolicy:research.manualPolicy},confirmedAutoInbox:assistantOptions.autoFlashcardInbox});await refresh(view.work.id);}else setAssistantOptions({...assistantOptions,researchPolicy:research.manualPolicy});setResearch(null);setImageDraft(manual.images||[]);setLibraryDraft(manual.libraryIds.map(id=>({id,name:""})));}catch(reason){setError(String(reason));}finally{setBusy(false);}
  };
  const currentImages=view?.work.grant.images || [];
  const selectedImages=imageDraft ?? currentImages;
  const sameImage=(a:ImageGrant,b:ImageGrant)=>JSON.stringify(a)===JSON.stringify(b);
  const imageChanges={addImages:selectedImages.filter(g=>!currentImages.some(c=>sameImage(c,g))),removeImages:currentImages.filter(g=>!selectedImages.some(c=>sameImage(c,g)))};
  const imagesChanged=!!(imageChanges.addImages.length||imageChanges.removeImages.length);
  const updateImages=async (changes:ImageChange)=>{
    setImageDraft([...selectedImages.filter(g=>!changes.removeImages.some(r=>sameImage(r,g))),...changes.addImages]);
    materialPopover.close(false);goalInput.current?.focus();
  };
  const addFiles=async(files:File[])=>{
    if(busy||importingFiles.current||businessCheck||confirmMessage||view?.work.grant.manifest||publicUrl){setError("请先完成当前操作，再添加图片或文件。");return;}
    importingFiles.current=true;setFilePreparing(true);setError("");
    const ticket=sequence.current;const images=[...selectedImages];const notes=[...materials];const errors:string[]=[];
    try{
      for(const file of files.slice(0,8)){
        try{
          if(/^image\//.test(file.type)){
            if(images.length>=2)throw new Error("每个对话最多2张图片，请先移除已有图片。");
            const prepared=await prepareImage(file);
            const staged=await call<{grant:ImageGrant}>({action:"stageImage",title:(file.name||"粘贴的图片").slice(0,200),...prepared});
            if(!images.some(g=>sameImage(g,staged.grant)))images.push(staged.grant);
          }else{
            const text=await readTextFile(file);
            if(notes.length+(view?.work.grant.notes?.length||0)>=31)throw new Error("本次对话材料数量已满，请先移除部分资料。");
            const staged=await call<AgentMaterial>({action:"stageTextFile",title:file.name.slice(0,200),text});
            if(!notes.some(n=>materialKey(n.locator)===materialKey(staged.locator))&&!view?.work.grant.notes?.some(n=>materialKey(n as AgentMaterial["locator"])===materialKey(staged.locator)))notes.push(staged);
          }
        }catch(reason){errors.push(file.name+"："+String(reason));}
      }
      if(files.length>8)errors.push("一次最多添加8份文件，请分批选择。");
      if(alive.current&&ticket===sequence.current){setImageDraft(images);setMaterials(notes);setError(errors.join("\n"));materialPopover.close(false);goalInput.current?.focus();}
    }finally{importingFiles.current=false;if(alive.current)setFilePreparing(false);}
  };
  useEffect(()=>{
    const changed=(event:Event)=>{
      const detail=(event as CustomEvent<{newConversation:boolean;scopeId?:string}>).detail;
      if(!accountVisible||detail?.newConversation||!detail?.scopeId||!view?.work.id)return;
      const consent={id:view.work.id,scopeId:detail.scopeId};
      pendingAccountHistory.current=consent;
      if(active||pendingRun)return;
      void authorizeCodexConversation(consent.id,consent.scopeId).then(()=>{if(pendingAccountHistory.current===consent)pendingAccountHistory.current=null;setError("");}).catch(reason=>setError(String(reason)));
    };
    window.addEventListener("hub:agent-account-changed",changed);
    return()=>window.removeEventListener("hub:agent-account-changed",changed);
  },[accountVisible,view?.work.id,active,pendingRun]);
  const showRunError = async (id:string, reason:unknown) => {
    try {
      const latest=await refresh(id);
      if(cancelResponse.current && ["paused","cancelled"].includes(latest.work.state)) return;
    } catch { /* Preserve the original run error when its state cannot be verified. */ }
    if(alive.current) setError(String(reason));
  };
  const run = async (id: string, recovery?: Lifecycle, admission = view?.lifecycle, reportContinuation?:ReportContinuation) => {
    const executionMode=admission?.executionModes?.deep?"deep":mode;
    if (!canRunMode(admission,executionMode)) { setError("当前不能开始新分析；补充与历史保留，请先核对事项额度和待核验结果。"); return; }
    let codexScopeId:string|undefined;
    if(globalPanel && (assistantOptions.model?.provider ?? runtime.settings.provider ?? "codex")==="codex"){
      if(!getCodexAccountSnapshot().loaded||getCodexAccountSnapshot().loading)await refreshCodexAccounts();
      codexScopeId=getCodexAccountSnapshot().current?.scopeId;
      if(!codexScopeId){setError("当前 Codex 账号不可用，请先管理账号或刷新登录状态。");return;}
    }
    setError(""); setStopping(false); setPendingRun(true); cancelResponse.current=false;
    setView(current => current?.work.id === id ? { ...current, goalAssessment: undefined, taskTree: undefined, goalRevision: undefined, workingState: undefined, work: { ...current.work, state: "investigating", report: null } } : current);
    try {
      const consent=pendingAccountHistory.current;
      if(consent?.id===id&&consent.scopeId===codexScopeId){
        await authorizeCodexConversation(id,codexScopeId);
        if(pendingAccountHistory.current===consent)pendingAccountHistory.current=null;
      }
      const value=await call<View>({action:recovery ? "resume" : "respond",id,mode:executionMode,...(codexScopeId?{codexScopeId}:{}),...(recovery ? lifecycleRequest(recovery,crypto.randomUUID()) : {}),...(reportContinuation ? {reportContinuation} : {})});
      if(alive.current) { uiTiming.snapshotReceived(value); setView(current=>acceptLifecycleSnapshot(current,value)); }

    }
    catch (reason) { await showRunError(id,reason); }
    finally {
      if (alive.current) {
        setStopping(false); setPendingRun(false); setPendingAction(null);
        try { await refresh(id); } catch (reason) { setError(String(reason)); }
      }
    }
  };
  const [publicUrl,setPublicUrl] = useState("");
  const resumeQueue=async(selectedMessageId?:string)=>{if(!view)return;cancelResponse.current=false;setPendingRun(true);setError("");try{const next=await call<View>({action:"resumeQueue",id:view.work.id,mode,selectedMessageId,expectedRunId:view.lifecycle?.activeRunId??null,...(view.lifecycle?lifecycleRequest(view.lifecycle,crypto.randomUUID()):{})});if(alive.current)setView(current=>acceptLifecycleSnapshot(current,next));}catch(reason){await showRunError(view.work.id,reason);}finally{if(alive.current){setPendingRun(false);void refresh(view.work.id);}}};
  const submitInFlight=useRef(false);
  const createRequest = async (event: React.FormEvent, preparedView = view) => {
    let view=preparedView;
    event.preventDefault();
    if (busy || filePreparing || stopping) return;
    if (!goal.trim() && !materials.length && !dropped.length && !snippets.length && !imageChanges.addImages.length && !(tagMode&&tagPreparation.tag)) { setError("请输入问题或添加附件。"); goalInput.current?.focus(); return; }
    if(research&&!active){
      const scope=selectionScope.current;setBusy(true);
      try{
        const checked=await call<{unavailable:unknown[];changed?:unknown[]}>({action:"checkResearchTopic",topic:research.topic});
        if(!alive.current||selectionScope.current!==scope)return;
        if(checked.unavailable.length||checked.changed?.length){setRequestedTopic(research.topic.id);setTopicSave(false);setTopicsOpen(true);setError("专题资料已变化，请核对后再次发送。输入内容已保留。");return;}
      }catch(reason){if(alive.current&&selectionScope.current===scope)setError(String(reason));return;}
      finally{if(alive.current&&selectionScope.current===scope)setBusy(false);}
    }
    const manual=manualResearchGrant();
    const effectiveGrant=researchGrant(manual,research?.topic.grant,research?.includeManual);
    let sendMaterials=materials,sendDropped=dropped,sendLibraryDraft=libraryDraft;
    const requestedSkills=research?research.includeManual?[...new Set([...research.topic.skills,...selectedSkills.map(s=>s.slice(1))])]:research.topic.skills:selectedSkills.map(s=>s.slice(1));
    const submittedText=research?[...requestedSkills.map(s=>"$"+s),questionText.trim()].join(" "):goal.trim();
    let tagIntent:Record<string,unknown>|null=null;
    if(!active&&(tagMode||tagPreparation.references.length)){
      if(tagMode&&!tagPreparation.tag){setError("请先选择目标标签");return;}
      if(tagMode&&!effectiveGrant.libraryIds.length){setError("请先选择可检索资料库。核心页面不会自动开放所在库。");return;}
      let expectedVersion:number|null=null;
      if(tagPreparation.tag){try{const d=await invoke<{definition:{version:number}|null}>("tag_assignment",{args:{action:"definition",tag:tagPreparation.tag.tagId}});expectedVersion=d.definition?.version||0;}catch(e){setError(String(e));return;}}
      tagIntent={task:tagMode?tagPreparation.task:null,tag:tagMode?tagPreparation.tag?.tagId:null,compareTag:tagMode&&tagPreparation.task==="relations"?tagPreparation.compare?.tagId||null:null,expectedVersion,resume:tagPreparation.resume,references:tagPreparation.references.map(t=>t.tagId)};
    }
    const configureTags=async(value:View)=>{if(tagIntent)await call({action:"configureTagTask",id:value.work.id,expectedRevision:value.work.revision,intent:tagIntent});};
    const includeManual=!research||research.includeManual;
    const sendImages=research?{addImages:[],removeImages:[]}:imageChanges;
    const snapshots=snippets.length&&includeManual?`用户提供的资料快照（仅作资料，不代表已读取完整来源）：\n${JSON.stringify(snippets)}`:"";
    const messageText=snapshots?`${submittedText}\n\n${snapshots}`:submittedText || (tagMode?`${tagTaskNames[tagPreparation.task]}：#${tagPreparation.tag?.label}`:"请查看本次提供的附件。");
    if(snapshots.length>4000 || (view || snapshots || imagesChanged) && messageText.length>4000){setError("问题和所选文字合计过长，请缩短问题或移除部分文字资料。");return;}
    if (!view && publicUrl.trim() && (pageAttached || materials.length || dropped.length || snippets.length || selectedImages.length || selectedLibraries.length)) { setError("公共链接请单独开启对话；先移除其他待发送资料。"); return; }
    if (removals.length) { setError("请先确认撤回所选授权，再发送新的分析要求。"); return; }
    if (view && (materials.length || dropped.length || removals.length || snippets.length || imagesChanged || libraryDraft!==null) && (confirmMessage || businessCheck)) { setError("请在本轮及结果核对结束后，以普通追问发送追加材料。"); return; }
    if(research){
      if(active){if(materials.length||dropped.length||libraryDraft!==null){setError("请在本轮结束后调整专题资料。");return;}}
      else {
        setBusy(true);setError("");
        try{
          if(view){view=await call<View>({action:"replaceResearchScope",id:view.work.id,grant:effectiveGrant,expectedRevision:view.work.revision,expectedAuthorizationVersion:view.work.authorizationVersion});setView(view);}

          sendMaterials=[];sendDropped=[];sendLibraryDraft=null;
        }catch(reason){setError(String(reason));return;}finally{setBusy(false);}
      }
    }
    if(view && active){
      if(libraryDraft!==null||imageChanges.removeImages.length){setError("请在本轮结束后撤回资料或调整整库范围。");return;}
      const deliveryMode=steerable?"steer":"queue";
      const payload={text:messageText,addNotes:sendMaterials.map(m=>m.locator),addSources:sendDropped.map(m=>m.locator),addImages:sendImages.addImages,deliveryMode};
      const identity=JSON.stringify(payload);
      if(!messageIdentity.current||messageIdentity.current.text!==identity)messageIdentity.current={text:identity,id:crypto.randomUUID()};
      const submittedGoal=goal;
      setBusy(true);setError("");
      try{const value=await call<View>({action:"followup",id:view.work.id,...(deliveryMode==="steer"?{expectedRunId:steerable&&steerable.runId}:{}),expectedAuthorizationVersion:view.work.authorizationVersion,clientMessageId:messageIdentity.current.id,...payload});
        if(alive.current){setView(current=>acceptLifecycleSnapshot(current,value));setGoal(current=>current===submittedGoal?"":current);setMaterials([]);setDropped([]);if(includeManual){setSnippets([]);setImageDraft(null);}messageIdentity.current=null;}
      }catch(reason){if(alive.current)setError(String(reason));}finally{if(alive.current)setBusy(false);}return;
    }
    conversationScroll.scrollToLatest();
    uiTiming.begin(steerable ? "steer" : view ? "revision" : "submit");
    if (view) {
      if (view.work.state === "revoked") return;
      setBusy(true); setError("");
      const text=messageText;
      const messageKey=JSON.stringify([text,materials.map(m=>m.locator),dropped,removals,imageChanges,libraryDraft]);
      if (!messageIdentity.current || messageIdentity.current.text!==messageKey) messageIdentity.current={text:messageKey,id:crypto.randomUUID()};
      try {
        const value=await call<View>(steerable ? {action:"steer",id:view.work.id,runId:steerable.runId,text,clientMessageId:messageIdentity.current.id} : confirmMessage ? {action:"decision",id:view.work.id,text} : {action:"message",id:view.work.id,text,clientMessageId:messageIdentity.current.id,...(sendLibraryDraft!==null?{setLibraryIds:sendLibraryDraft.map(l=>l.id)}:{}),...sendImages,...(materials.length?{addNotes:sendMaterials.map(m=>m.locator)}:{}),...(dropped.length?{addSources:sendDropped.map(m=>m.locator)}:{}),...(view.work.revision!==undefined?{expectedRevision:view.work.revision}:{})});
        if(!alive.current) return;
        await configureTags(value); if(research)setResearch({...research,manual,includeManual:false}); setView(value); setLibraryDraft(null); setGoal(research?skillPrefix:""); setMaterials([]);setDropped([]);if(includeManual){setSnippets([]);setImageDraft(null);} setRemovals([]); messageIdentity.current=null; setConfirmMessage(false);
        if(!steerable && !value.lifecycle?.requiresExplicitResume && canRunMode(value.lifecycle,mode)) void run(value.work.id,undefined,value.lifecycle);
      } catch(reason) {if(alive.current) setError(String(reason));}
      finally {if(alive.current) setBusy(false);}
      return;
    }
    setBusy(true); setError("");
    try {
      await checkDraftMemory();
      const grant=research?{libraryIds:[],notes:[],readingItemKeys:[]}:buildDraftGrant();
      let value = publicUrl.trim() ? await call<View>({action:"createFromPublicUrl",url:publicUrl.trim(),goal:goal.trim(),confirmedPublicRead:true,researchPolicy:assistantOptions.researchPolicy}) : await call<View>({ action: "create", goal: snapshots?(submittedText.trim()||"请分析提供的文字资料。"):messageText, successCriteria: "", anchor:research?null:anchor, grant });
      if (!alive.current) return;
      setPublicUrl("");
      boundMaterial.current=primaryMaterial || null;
      if(tagMode||tagPreparation.references.length)tagPending.current=tagPreparation;
      setView(value); if(research)researchPending.current={...research,manual,includeManual:false}; void reloadWorks();
      if(anchor){setMaterials([]);setDropped([]);} setRemovals([]);
      if(research){
        value=await call<View>({action:"replaceResearchScope",id:value.work.id,grant:effectiveGrant,expectedRevision:value.work.revision,expectedAuthorizationVersion:value.work.authorizationVersion});
        if(!alive.current)return;
        setView(value);
      }
      // Bind the user's preflight selection before the first model call. A
      // failed binding leaves a visible ready work and never starts a model.
      if (assistantOptions.researchPolicy || assistantOptions.model || assistantOptions.autoFlashcardInbox || assistantOptions.externalMcp || assistantOptions.webSearch || assistantOptions.mcpServices?.length) value=await call<View>({action:"configureAssistant",id:value.work.id,options:assistantOptions,confirmedAutoInbox:assistantOptions.autoFlashcardInbox});
      if (assistantOptions.researchPolicy!=="materials-only" && (memorySelection.enabled || memorySelection.projectId)) await invoke("shared_memory", { args: { action: "selectScope", workId: value.work.id, ...memorySelection } });
      const addNotes=!research&&!anchor?sendMaterials.map(m=>m.locator):[];
      const addSources=!research&&!anchor?sendDropped.map(m=>m.locator):[];
      if(snapshots||(!research&&imagesChanged)||addNotes.length||addSources.length||(!research&&libraryDraft!==null)){
        const key=JSON.stringify([messageText,addNotes,!anchor?dropped:[],[],imageChanges,libraryDraft]);
        if(!messageIdentity.current||messageIdentity.current.text!==key)messageIdentity.current={text:key,id:crypto.randomUUID()};
        value=await call<View>({action:"message",id:value.work.id,expectedRevision:value.work.revision,text:messageText,...(sendLibraryDraft!==null?{setLibraryIds:sendLibraryDraft.map(l=>l.id)}:{}),...sendImages,...(addNotes.length?{addNotes}:{}),...(addSources.length?{addSources}:{}),clientMessageId:messageIdentity.current.id});
        if(alive.current){setView(value);setLibraryDraft(null);setSnippets([]);setMaterials([]);setDropped([]);setImageDraft(null);messageIdentity.current=null;}
      }
      await configureTags(value); setLibraryDraft(null);
      if(alive.current)setView(value);
      setGoal(research?skillPrefix:"");
      void run(value.work.id,undefined,value.lifecycle);
    } catch (reason) { if (alive.current) setError(String(reason)); }
    finally { if (alive.current) setBusy(false); }
  };
  const create=async(event:React.FormEvent)=>{event.preventDefault();if(submitInFlight.current)return;submitInFlight.current=true;try{await createRequest(event);}finally{submitInFlight.current=false;}};
  async function checkDraftMemory() {
    if (assistantOptions.researchPolicy==="materials-only" || !memorySelection.enabled && !memorySelection.projectId) return;
    const status = await invoke<{configured: boolean; runtimeDetail?: string; projects: {id: string}[]}>("shared_memory", { args: { action: "status" } });
    if (memorySelection.projectId && !status.projects.some(project => project.id === memorySelection.projectId)) {
      const fallback = { projectId: "", enabled: false };
      setMemorySelection(fallback); rememberMemoryPreference(fallback);
      throw new Error("上次选择的记忆项目已不可用，已关闭记忆。请确认范围后重新发送。");
    }
    if (memorySelection.enabled && !status.configured) throw new Error(status.runtimeDetail || "本地记忆尚未就绪，请打开记忆面板检查后重试。");
  }
  const createSourceScope = async (selection:SourceSelection, expectedManifest:string) => {
    if (busy || view || !goal.trim()) return;
    setBusy(true); setError("");
    try {
      await checkDraftMemory();
      const value=await call<View>({action:"createWithSourceScope",selection,expectedManifest,anchor,goal:goal.trim(),successCriteria:"依据固定范围回答问题，说明覆盖、出处和局限；未读取或未抽取的材料不能算作已处理。"});
      if(!alive.current)return;
      setView(value);void reloadWorks();setGoal("");setMaterials([]);setDropped([]);setRemovals([]);
      if(assistantOptions.researchPolicy || assistantOptions.model || assistantOptions.autoFlashcardInbox || assistantOptions.externalMcp || assistantOptions.webSearch || assistantOptions.mcpServices?.length) await call<View>({action:"configureAssistant",id:value.work.id,options:assistantOptions,confirmedAutoInbox:assistantOptions.autoFlashcardInbox});
      if(memorySelection.enabled || memorySelection.projectId) await invoke("shared_memory",{args:{action:"selectScope",workId:value.work.id,...memorySelection}});
    } catch(reason) {if(alive.current)setError(String(reason));throw reason;}
    finally {if(alive.current)setBusy(false);}
  };
  const replaceSourceScope = async (selection:SourceSelection,expectedManifest:string) => {
    if(!view?.work.grant.manifest || view.work.revision===undefined || busy || active) return;
    const base={action:"replaceSourceScope",id:view.work.id,selection,expectedManifest,expectedPreviousManifest:view.work.grant.manifest.snapshot,expectedRevision:view.work.revision,text:`重新确认固定材料范围：目录 ${selection.directory||"根目录"}；文件日期 ${selection.dateFrom||"不限"} 至 ${selection.dateTo||"不限"}。保留同一事项及累计预算，不启动分析。`};
    const key=JSON.stringify(base);if(manifestIdentity.current?.key!==key)manifestIdentity.current={key,id:crypto.randomUUID()};
    setBusy(true);setError("");
    try {const value=await call<View>({...base,clientMessageId:manifestIdentity.current.id});if(alive.current){setView(value);setMaterials([]);setDropped([]);setRemovals([]);}}
    catch(reason){if(alive.current)setError(String(reason));throw reason;}
    finally{if(alive.current)setBusy(false);}
  };
  const openNoteEditor = async () => {
    if (busy || active || anchor?.kind !== "note") return;
    setBusy(true); setError("");
    try {
      const grant = { libraryIds: composerLibraries.map(library=>library.id), notes: [anchor], readingItemKeys: [] };
      const value = await call<View>({ action: "create", goal: "修改当前 Obsidian 笔记", successCriteria: "查看具体修改，明确确认后保存；发现外部变化时保留草稿并停止覆盖。", anchor, grant });
      if (alive.current) { setView(value); void reloadWorks(); setHistoryExpanded(false); if(detailsMenu.current) detailsMenu.current.open=true; }
    } catch (reason) { if (alive.current) setError(String(reason)); }
    finally { if (alive.current) setBusy(false); }
  };
  const mutate = async (action: "cancel" | "cancelGoal" | "revoke") => {
    if (!view) return;
    if (action === "revoke") { clearSourcePreview(); await businessAction({action}); return; }
    setBusy(true); setError("");
    setStopping(true);
    try {
      const current = view.lifecycle ? await refresh(view.work.id) : view;
      if (!alive.current) return;
      if (action === "cancel" && view.lifecycle) {
        if (view.lifecycle.activeRunId && current.lifecycle?.activeRunId && view.lifecycle.activeRunId !== current.lifecycle.activeRunId) throw new Error("运行已改变，请核对当前这一轮后再停止");
        if (!current.runActive && !current.lifecycle?.activeRunId) return;
      }
      cancelResponse.current=true;
      const value = await call<View>({ action, id: current.work.id, ...(current.lifecycle ? lifecycleRequest(current.lifecycle,crypto.randomUUID()) : {}) });
      sequence.current++;
      if (alive.current) setView(value);
    } catch (reason) { if (alive.current) { setError(String(reason)); setStopping(false); } }
    finally { if (alive.current) {setBusy(false);setStopping(false);} }
  };
  const businessAction = async (args: Record<string, unknown>) => {
    if (!view) return;
    if (["prepareObsidianEdit","prepareFlashcards","prepareTagProposal","prepareArchive"].includes(String(args.action)) && view.actions?.standaloneModelDrafts?.allowed===false) {
      setError(view.actions.standaloneModelDrafts.reason || "当前不能生成新草稿；已有成果及回执仍可查看。"); return;
    }
    const previous = businessChecks.current.get(view.work.id);
    // Revocation must remain available while draft preparation is pending.
    // Its check supersedes that operation; late preparation cannot release it.
    if (args.action === "revoke" ? previous?.scopeChanging : businessInFlight.current || previous) return;
    const id = view.work.id;
    const check = { actionId: typeof args.actionId === "string" ? args.actionId : undefined, afterSequence: Infinity, uncertain: false, checking: false, scopeChanging: args.action === "revoke" || (args.action === "message" && Array.isArray(args.removeNotes) && args.removeNotes.length > 0) };
    businessChecks.current.set(id, check);
    businessInFlight.current = check;
    redrawBusinessCheck(value => value + 1);
    setError(""); setPendingAction(String(args.action)); setStopping(false);
    try { await call<View>({ ...args, id, ...(args.action === "selectObsidianTarget" ? {expectedRevision:view.work.revision,expectedAuthorizationVersion:view.work.authorizationVersion} : {}) }); }
    catch (reason) { if (alive.current && businessInFlight.current === check) setError(String(reason)); }
    finally {
      if (alive.current && businessInFlight.current === check) {
        // Reads started before the outcome must never release this gate.
        sequence.current++;
        check.afterSequence = sequence.current + 1;
        try { await refresh(id); } catch (reason) { setError(String(reason)); }
        if (businessChecks.current.get(id) === check) {
          check.uncertain = true;
          redrawBusinessCheck(value => value + 1);
        }
        setPendingAction(null); setStopping(false);
      }
      if (businessInFlight.current === check) businessInFlight.current = null;
    }
  };
  const checkBusinessOutcome = async () => {
    if (!view || businessInFlight.current) return;
    const id = view.work.id;
    const check = businessChecks.current.get(id);
    if (!check || check.checking) return;
    check.checking = true;
    setError(""); redrawBusinessCheck(value => value + 1);
    sequence.current++;
    check.afterSequence = sequence.current + 1;
    try { await refresh(id); } catch (reason) { if (alive.current) setError(String(reason)); }
    finally {
      if (alive.current && businessChecks.current.get(id) === check) {
        check.checking = false; check.uncertain = true;
        redrawBusinessCheck(value => value + 1);
      }
    }
  };
  const withdrawMaterials = async () => {
    if (!view || !removals.length || materials.length || active || busy || confirmMessage) return;
    clearSourcePreview();
    const key=JSON.stringify([view.work.id,view.work.revision,removals]);
    if (!scopeIdentity.current || scopeIdentity.current.key!==key) scopeIdentity.current={key,id:crypto.randomUUID()};
    await businessAction({action:"message",text:"明确撤回本次选中的附加材料读取授权，保留原始目标与历史；本操作不启动模型分析。",clientMessageId:scopeIdentity.current.id,expectedRevision:view.work.revision,removeNotes:removals});
  };
  const conditionAction = async (args: Record<string, unknown>) => {
    if (!view) return;
    setBusy(true);
    try { await call<View>({ ...args, id: view.work.id }); await refresh(view.work.id); }
    finally { if (alive.current) setBusy(false); }
  };
  const saveAssistantOptions=async (options:AssistantOptions, remember=true)=>{
    const scope=selectionScope.current;
    const previous=(view ? view.assistantOptions || defaultAssistantOptions : assistantOptions);
    const provider=(options.model ?? runtime.settings)?.provider ?? "codex";
    const previousProvider=(previous.model ?? runtime.settings)?.provider ?? "codex";
    if(provider === "deepseek") options={...options,webSearch:"disabled"};
    else if(previousProvider === "deepseek") options={...options,webSearch:loadCodexWebSearchPreference()};
    if(view) {
      const next=await call<View>({action:"configureAssistant",id:view.work.id,options,confirmedAutoInbox:options.autoFlashcardInbox});
      if(!alive.current||selectionScope.current!==scope)throw Error("对话已切换，当前对话设置未改变");
      setView(next);
    } else setAssistantOptions(options);
    if(remember&&(JSON.stringify(previous.model)!==JSON.stringify(options.model) || previous.webSearch!==options.webSearch || previous.researchPolicy!==options.researchPolicy)) rememberAgentPreferences(options,previous,runtime.settings?.provider);
  };
  const outcomes=(items:NonNullable<AgentActions>["items"])=>items.length ? <div className="agent-outcomes" aria-label="对话成果">{items.map(item=>item.kind==="flashcardDrafts" ? <FlashcardRecord key={item.id} item={item as FlashcardAction} disabled={businessDisabled} revoked={view?.work.state==="revoked"} onAction={businessAction}/> : item.kind==="archiveCopy" ? <ArchiveRecord key={item.id} item={item as ArchiveAction} disabled={businessDisabled} revoked={view?.work.state==="revoked"} onAction={businessAction}/> : item.kind==="obsidianEdit" ? <AgentObsidianEdit key={item.id} actions={{tagOptions:[],items:[item]}} recordsOnly verificationPending={!!businessCheck?.uncertain && businessCheck.actionId===item.id} disabled={businessDisabled} revoked={view?.work.state==="revoked"} onAction={businessAction}/> : null)}</div> : null;
  const visibleNote=browsing?.entry&&"result" in browsing.entry?investigationAnchor(browsing.entry.result):pageAnchor;
  const saveTarget=visibleNote?.kind==="note"?visibleNote:null;
  const inlineOutcomes=(message:ConversationMessage)=>{
    const messages=view?.conversation?.messages || [];
    const same=messages.filter(m=>m.revision===message.revision);
    const replies=same.filter(m=>m.role==="assistant");
    const owner=replies[replies.length-1] || same[same.length-1];
    if(owner?.id!==message.id || message.revision===undefined)return null;
    return <>{view?.tagTasks?.filter(record=>record.revision===message.revision).map(record=><AgentTagResult key={record.runId} record={record}/>)}{outcomes(view?.actions?.items.filter(a=>a.kind!=="tagProposal" && a.baseRevision===message.revision) || [])}</>;
  };
  const report = view?.work.report;
  const nativeRun = view?.activity?.find(run=>run.runId===view.run?.id && run.native);
  const nativeTokens = nativeRun?.measurement?.turnTokens;
  const tokenLabel = (value:number|null|undefined) => value == null ? "未返回" : value.toLocaleString();
  const addTextMaterial=(entry:TextMaterial)=>{
    if(busy || filePreparing || view?.work.grant.manifest){setError("请先完成附件准备；固定范围请从范围入口调整。");return;}
    if(!entry.text.trim() || entry.text.length>2500 || snippets.length>=8 || snippets.reduce((n,s)=>n+s.text.length,0)+entry.text.length>3000){setError("文字资料过长，每份最多2500字，合计最多3000字；请缩小选择范围。");return;}
    setSnippets(current=>current.some(item=>item.text===entry.text&&item.kind===entry.kind)?current:[...current,{...entry,title:entry.title.slice(0,200)}]);
    if(!view){setPageAttached(false);setWholeLibrary(false);}
  };
  useEffect(()=>{if(open && !busy && textMaterials?.pending){addTextMaterial(textMaterials.pending);textMaterials.setPending(null);}},[open,busy,active,textMaterials?.pending]);
  const addExternalMaterial=(entry:{result?:SearchResult;itemKey?:string;title?:string;kind?:string;text?:string})=>{
    if((entry.kind==="text"||entry.kind==="flashcard")&&typeof entry.text==="string"){addTextMaterial({kind:entry.kind,text:entry.text,title:typeof entry.title==="string"?entry.title:"所选文字"});return;}
    if(busy || filePreparing || view?.work.grant.manifest){setError("请等待附件准备完成；固定资料范围需从范围入口调整。");return;}
    const locator=entry.result?investigationAnchor(entry.result):typeof entry.itemKey==="string" && entry.itemKey.length>0 && entry.itemKey.length<=200?{kind:"reading" as const,itemKey:entry.itemKey}:null;
    if(!locator || locator.kind==="attachment"){setError("请拖入页面、任务或阅读条目；原图请从＋添加。");return;}
    const key=JSON.stringify(locator);
    if(key===JSON.stringify(anchor) || materials.some(m=>JSON.stringify(m.locator)===key) || view?.work.grant.notes?.some(n=>JSON.stringify(n)===key) || view?.work.grant.sources?.some(n=>JSON.stringify(n)===key) || (locator.kind==="reading" && view?.work.grant.readingItemKeys?.includes(locator.itemKey)))return;
    if(dropped.length+materials.length>=31){setError("每次最多添加31份资料。");return;}
    setDropped(current=>current.some(m=>JSON.stringify(m.locator)===key)?current:[...current,{locator,title:(entry.title||entry.result?.title||"阅读条目").slice(0,200)}]);
  };
  const newInvestigation = (preserveHistory=false) => {
    setDraftSession(crypto.randomUUID());
    sequence.current++; setLibraryDraft(null); setView(null); setPublicUrl(""); setAssistantOptions(loadAgentPreferences()); setGoal(""); setWholeLibrary(false); setMaterials([]);setDropped([]);setSnippets([]);setImageDraft(null); setRemovals([]);
    setMemorySelection(loadMemoryPreference()); setConfirmMessage(false); setError("");  setSourcePreview(null); setSourceError(""); setSourceLoading(false); sourceSequence.current++; messageIdentity.current=null;
    setDraftRevision(value => value + 1);
    setPageAttached(!!pageAnchor);boundMaterial.current=null;clearSourcePreview();
    // Deleting the displayed chat keeps the history menu mounted so undo remains available.
    if(!preserveHistory)onNewConversation?.();
  };
  const suggestions = [
    { label: "概括主要内容", icon: FileText, prompt: "概括当前材料的主要内容，列出关键观点，并引用原文依据。" },
    { label: "找出待办与待确认事项", icon: ListChecks, prompt: "梳理当前材料中的行动项、未解决的问题和需要确认的事项，并给出原文依据。" },
    { label: "核对依据与遗漏", icon: Search, prompt: "检查当前材料中哪些结论有依据、哪些还缺少证据或验证，说明依据和局限。" },
  ];
  const detailGrant=research?researchGrant(manualResearchGrant(),research.topic.grant,research.includeManual):null;
  const detailCoreCount=detailGrant?detailGrant.notes.length+(detailGrant.sources?.length||0)+detailGrant.readingItemKeys.length:coreMaterialCount;
  const detailLibraries=detailGrant?detailGrant.libraryIds.length:composerLibraries.length;
  const scopeStatus=[detailCoreCount?`${detailCoreCount} 份资料`:"",detailLibraries?`${detailLibraries} 个库`:""].filter(Boolean).join(" · ")||"未选资料";
  const scopeDetails = view ? <>
        <details className="agent-run-details agent-detail-row"><summary><AgentDetailSummary icon={<Layers size={16}/>} title="资料范围" status={scopeStatus}/></summary><p className="agent-note">资料策略：{policyNames[(view.assistantOptions||assistantOptions).researchPolicy||"material-first"]}。在输入框底部调整，浏览页面不会自动加入。</p>
        <p className="agent-note">{view.work.grant.manifest ? `已授权：固定清单 ${view.work.grant.manifest.members.length} 份材料` : view.work.grant.libraryIds.length ? `已授权：${view.work.grant.libraryIds.length} 个资料库` : view.work.state === "revoked" ? "已停止使用来源" : (!anchor || view.work.grant.notes && view.work.grant.notes.length>1) ? `已授权：${view.work.grant.notes?.length || 0} 份明确选中的文档/页面` : `已授权：${currentObjectLabel}`} · 下一轮{mode === "quick" ? "最多 8 分钟、8 次分析调用" : "最多 15 分钟、16 次分析调用"}，另有最多 1 次结果纠错，仍计入总时限。</p>
        {view.run?.usage.modelCalls !== undefined && <p className="agent-note">{nativeRun?`本轮 Agent 会话：${view.run.usage.agentSessions ?? "未返回"}；模型响应轮次：未返回`:"本轮已调用 "+view.run.usage.modelCalls+" 次"}，读取 {view.run.usage.entitiesRead || 0} 个来源、{view.run.usage.bodyChars || 0} 字符。</p>}
        {nativeTokens && <p className="agent-note">本轮输入 {tokenLabel(nativeTokens.inputTokens)} Token，其中缓存输入 {tokenLabel(nativeTokens.cachedInputTokens)}、未缓存输入 {tokenLabel(nativeTokens.uncachedInputTokens)}；输出 {tokenLabel(nativeTokens.outputTokens)}。恢复会话按本轮差额记录，缓存输入已包含在本轮输入中；缺少回执时显示未返回。</p>}
        {!!view.run?.usage.localScanDocuments && <p className="agent-note">本地统计累计处理 {view.run.usage.localScanDocuments} 份材料、{((view.run.usage.localScanBytes || 0)/1024).toFixed(1)} KiB；原文未因此全部发送给模型。</p>}
        {view.modelSelection && <p className="agent-note">本轮请求模型：{codexSelectionLabel(view.modelSelection)}</p>}
        {!!view.modelExecutions?.length && <p className="agent-note">{view.modelExecutions.some(item => item.totalTokens != null) ? `提供方返回用量：${view.modelExecutions.reduce((total,item) => total + (item.totalTokens ?? 0),0).toLocaleString()} tokens` : "提供方未返回 token 用量"}</p>}
        {!!view.run?.usage.modelRetries && <p className="agent-note">模型超时后已重试 {view.run.usage.modelRetries} 次，计入本轮调用次数与总时限。</p>}
        {!!view.run?.usage.outputRepairs && <p className="agent-note">结果核验后已纠错 {view.run.usage.outputRepairs} 次，计入本轮调用次数与总时限。</p>}
        </details>
  </> : <details className="agent-run-details agent-detail-row"><summary><AgentDetailSummary icon={<Layers size={16}/>} title="资料范围" status={scopeStatus}/></summary><p className="agent-note">资料策略：{policyNames[assistantOptions.researchPolicy||"material-first"]}。{hasDraftSources?"已选择待发送资料，发送消息时按本次选择授权。":"当前未添加资料，可直接提问。"}</p><button type="button" disabled={busy} onClick={()=>{detailsPopover.close();setAddPage("scope");setAddMenuOpen(true);if(materialPopover.ref.current)materialPopover.ref.current.open=true;}}>管理资料范围</button></details>;
  const conversationDetails = view ? <>
        {!!view.decisions.length && <details><summary>你确认的决定（{view.decisions.length}）</summary><ul>{[...view.decisions].reverse().map((item, index) => <li key={index}>{item.text}</li>)}</ul></details>}
        <details className="agent-more-tools agent-detail-row" open={canEditNote && (view.work.goal === "修改当前 Obsidian 笔记" || !!view.actions?.items.some(item => item.kind === "obsidianEdit"))}><summary><AgentDetailSummary icon={<NotebookPen size={16}/>} title="成果与保存"/></summary><p className="agent-note">从回答下方插入页面、创建笔记或任务。保存前可查看并修改草稿。</p>
        {view.work.anchor === null && view.work.state !== "revoked" && <AgentObsidianTarget key={`target-${view.work.id}-${view.work.authorizationVersion}-${view.work.actionTargetIdentity}`} targets={view.actions?.obsidianTargets || []} current={view.work.actionTarget} disabled={businessDisabled || !!view.lifecycle?.requiresExplicitResume} onAction={businessAction}/>}
        {anchor?.kind === "note" && <AgentTagAction key={view.work.id} actions={view.actions} revoked={view.work.state === "revoked"} disabled={businessDisabled || !!view.lifecycle?.requiresExplicitResume} onAction={businessAction} />}
        {view.actions?.standaloneModelDrafts?.allowed===false && <p className="agent-note" role="status">{view.actions.standaloneModelDrafts.reason}</p>}
        {!view.run?.id&&<AgentReportSave actions={view.actions} disabled={businessDisabled||!!active||!!view.lifecycle?.requiresExplicitResume} onAction={businessAction}/>}
        <AgentObsidianEdit formsOnly key={`obsidian-edit-${view.work.id}`} actions={view.actions} revoked={view.work.state === "revoked"} disabled={businessDisabled || !!view.lifecycle?.requiresExplicitResume || view.actions?.standaloneModelDrafts?.allowed===false} onAction={businessAction} />
        {anchor && <AgentBusinessActions formsOnly key={`business-${view.work.id}`} actions={view.actions} sourceKind={anchor.kind} initialGoal={view.work.goal} revoked={view.work.state === "revoked"} disabled={businessDisabled || !!view.lifecycle?.requiresExplicitResume || view.actions?.standaloneModelDrafts?.allowed===false} onAction={businessAction} />}
        {view.work.state !== "revoked" && (report || view.watch) && <AgentConditions key={`conditions-${view.work.id}`} value={view.watch} disabled={busy} active={!!active} onAction={conditionAction} />}
        </details>
        <div className="agent-actions">
          {view.work.state !== "revoked" && <button type="button" disabled={busy} onClick={() => void mutate("revoke")}>撤回来源授权</button>}
          {!active && view.work.state !== "revoked" && <button type="button" disabled={busy} onClick={() => { setError(""); void revalidate(view.work.id).catch(reason => setError(String(reason))); }}>核对来源</button>}
        </div>
  </> : <>
    <details className="agent-more-tools agent-detail-row"><summary><AgentDetailSummary icon={<NotebookPen size={16}/>} title="成果与保存"/></summary><p className="agent-note">从回答下方插入页面、创建笔记或任务。保存前可查看并修改草稿。</p><p className="agent-note">发送消息后，可查看结果保存与后续操作；现在可先选择共享记忆。</p></details>
  </>;
  return <>
    <button ref={launcher} type="button" className={`agent-launcher${compact ? " agent-launcher-compact" : ""}`} title="打开 Hub 助手" aria-label={entryLabel} aria-expanded={open} aria-controls={panelId} onClick={() => {
      if (open) return;
      setOpen(true);
      onPin?.();
      if (!loaded.current) { loaded.current = true; void load(); }
    }}><MessageSquare size={18} aria-hidden="true" />{!compact && <span>询问助手</span>}</button>
    {createPortal(<button ref={floatingLauncher} type="button" hidden={open || !accountVisible} className="agent-floating-launcher" title="打开 Hub 助手" aria-label="打开助手" aria-expanded={false} aria-controls={loaded.current ? panelId : undefined} onClick={() => {
      setOpen(true);
      onPin?.();
      if (!loaded.current) { loaded.current = true; void load(); }
    }}><span className="agent-launcher-orb" aria-hidden="true"/>助手</button>, document.body)}
    {loaded.current && createPortal(<><div hidden={!open || docked} className="agent-panel-height-resizer" role="separator" aria-label="调整助手高度" aria-controls={panelId} aria-orientation="horizontal" aria-valuemin={panelHeightResize.minimum} aria-valuemax={panelHeightResize.maximum} aria-valuenow={panelHeightResize.width} aria-valuetext={`${panelHeightResize.width} 像素`} tabIndex={0} title="拖动调整高度，双击恢复默认" onPointerDown={panelHeightResize.onPointerDown} onKeyDown={panelHeightResize.onKeyDown} onDoubleClick={panelHeightResize.reset}/><div hidden={!open} className="agent-panel-resizer" role="separator" aria-label="调整助手宽度" aria-controls={panelId} aria-orientation="vertical" aria-valuemin={panelResize.minimum} aria-valuemax={panelResize.maximum} aria-valuenow={panelWidth} aria-valuetext={`${panelWidth} 像素`} tabIndex={0} title="拖动调整宽度，双击恢复默认" onPointerDown={panelResize.onPointerDown} onKeyDown={panelResize.onKeyDown} onDoubleClick={panelResize.reset}/><aside id={panelId} hidden={!open} data-agent-source-visible={sourceVisible} data-agent-reading={reportReading} data-agent-docked={docked} data-hub-keyboard-scope="assistant" className="agent-investigation agent-panel" aria-label="Hub 助手" onDragOver={event=>{if(event.dataTransfer.types.includes("application/x-hub-tag")||event.dataTransfer.types.includes(libraryDragType)||event.dataTransfer.types.includes("application/x-hub-agent-source")||event.dataTransfer.types.includes("Files")){event.preventDefault();event.dataTransfer.dropEffect="copy";}}} onDrop={event=>{
        const tagData=event.dataTransfer.types?.includes("application/x-hub-tag")?event.dataTransfer.getData("application/x-hub-tag"):"";
        if(tagData){event.preventDefault();event.stopPropagation();try{const v=JSON.parse(tagData);if(typeof v.tagId!=="string"||typeof v.label!=="string"||v.tagId.length>200)throw Error("无法识别标签");setTagPreparation({...tagPreparation,references:[...tagPreparation.references.filter(t=>t.tagId!==v.tagId),v].slice(0,16)});}catch(reason){setError(String(reason));}return;}
        const libraryData=event.dataTransfer.types?.includes(libraryDragType)?event.dataTransfer.getData(libraryDragType):"";
        if(libraryData){
          event.preventDefault();event.stopPropagation();
          if(busy||active||businessCheck||confirmMessage||view?.work.grant.manifest||view?.work.state==="revoked"||publicUrl){setError("请在普通对话空闲时调整库范围；固定清单请从范围入口调整。");return;}
          try {const items=readLibraryDrop(libraryData);changeLibraries([...new Map([...composerLibraries,...items].map(l=>[l.id,l])).values()]);setReportReading(false);setError("");}catch(reason){setError(String(reason));}
          return;
        }
        if(event.dataTransfer.files?.length){event.preventDefault();event.stopPropagation();setReportReading(false);void addFiles(Array.from(event.dataTransfer.files));return;}const data=event.dataTransfer.getData("application/x-hub-agent-source");if(!data)return;event.preventDefault();event.stopPropagation();setReportReading(false);try{if(data.length>65536)throw new Error();addExternalMaterial(JSON.parse(data));}catch{setError("无法识别拖入的资料，请重新拖入。");}}} onKeyDown={event => {
      if (event.key === "Escape" && !event.nativeEvent.isComposing && !event.defaultPrevented) { event.preventDefault(); event.stopPropagation(); const menu=(!reportReading && event.currentTarget.querySelector<HTMLDetailsElement>(".agent-composer details[open]")) || (detailsMenu.current?.open ? detailsMenu.current : null); if(menu){menu.open=false;menu.querySelector("summary")?.focus();}else if(citationOpen){returnFromCitation();}else if(reportReading){setReportReading(false);event.currentTarget.querySelector<HTMLButtonElement>('.agent-header-end button[aria-label="对话详情"]')?.focus();}else closePanel(); }
    }}>
      <header className="agent-panel-header">
        <div className="agent-header-start">
        <details ref={detailsMenu} data-history={historyExpanded} className="agent-dialogue-details" data-task-status={taskStatusOnly} onClickCapture={event=>{const menu=event.currentTarget;if(!menu.open&&(event.target as Element).closest("summary")===menu.firstElementChild){detailsReturn.current=menu.firstElementChild as HTMLElement;setHistoryExpanded(true);setTaskStatusOnly(false);}}} onToggle={event=>{if(event.target!==event.currentTarget)return;const menu=event.currentTarget;if(!menu.open&&detailsReturn.current?.isConnected&&(menu.contains(document.activeElement)||document.activeElement===document.body))detailsReturn.current.focus();}}><summary aria-label="对话历史" title="对话历史"><Menu size={18} aria-hidden="true"/></summary><div className="agent-details-content" role="region" aria-label={historyExpanded?"对话历史":taskStatusOnly?"任务状态":"对话详情"}>
          <div hidden={!historyExpanded} className="agent-history-container">
      <AgentConversationHistory query={historyQuery} archived={historyArchived} onQueryChange={query=>filterHistory(query,historyFilter.current.archived)} onArchivedChange={archived=>filterHistory(historyFilter.current.query,archived)} works={works} currentId={view?.work.id} disabled={busy||!!active} more={!!worksCursor} loading={worksLoading} error={worksError} states={states} onRetry={()=>void reloadWorks()} onClose={()=>{if(detailsMenu.current)detailsMenu.current.open=false;}} onMore={()=>void loadEarlierWorks()} onChange={changeHistory} onOpen={work=>void openHistoryWork(work)}/>
          </div>
          <div className="agent-details-sections" hidden={historyExpanded}>
          <div className="agent-details-heading"><strong>{taskStatusOnly?"任务状态":"对话详情"}</strong><button type="button" aria-label={taskStatusOnly?"关闭任务状态":"关闭对话详情"} onClick={()=>{detailsPopover.close();detailsReturn.current?.focus();}}><X size={16}/></button></div>
          <div className="agent-display-controls" hidden={taskStatusOnly}>

            {report && view?.work.state!=="revoked" && <button type="button" className="agent-reading-toggle" aria-pressed={reportReading} disabled={!!active} onClick={()=>{if(!reportReading)readingOrigin.current={scope:sourceScopeKey,scrollTop:conversationScroll.element.current?.scrollTop||0,focus:detailsReturn.current||goalInput.current};clearSourcePreview();setReportReading(current=>!current);detailsPopover.close();}}>{reportReading?<Minimize2 size={16}/>:<Maximize2 size={16}/>} {reportReading?"返回对话布局":"只看最新回答"}</button>}

            {onTopicBack&&<button type="button" disabled={busy||!!active} onClick={onTopicBack}><ArrowLeft size={16}/>返回专题所在工作</button>}
          </div>
          <section className="agent-detail-section agent-detail-materials" hidden={taskStatusOnly}><h3 className="agent-detail-group-title">资料与工具</h3>{scopeDetails}
          <details className="agent-run-details agent-detail-row"><summary><AgentDetailSummary icon={<Globe2 size={16}/>} title="联网与工具" status={(view?.assistantOptions||assistantOptions).researchPolicy==="materials-only"?"不联网":"按资料策略"}/></summary><AgentAssistantOptions section="connection" value={view?view.assistantOptions||defaultAssistantOptions:assistantOptions} disabled={busy||!!active} canAuto={anchor?.kind==="note"} onSave={saveAssistantOptions}/></details>
          {anchor?.kind==="note"&&canEditNote&&<AgentTopics key={`topics-${view?.work.id||draftRevision}`} anchor={anchor} work={view?.work} disabled={businessDisabled||!!active} onOpenWork={async (id,source,draft)=>{if(source&&!sameNoteAnchor(source.anchor,anchor)){if(!onOpenTopicWork)throw new Error("此入口尚不支持跨笔记继续，请从本期笔记打开原工作");onOpenTopicWork(id,source,view?.work.id,draft);return;}setLibraryDraft(null);setError("");setGoal("");setMaterials([]);setDropped([]);setRemovals([]);setSourcePreview(null);sourceSequence.current++;await refresh(id);if(alive.current){void reloadWorks();if(draft){setGoal(draft);goalInput.current?.focus();}}}}/>}
          <SharedMemory summary={selection=><AgentDetailSummary icon={<Brain size={16}/>} title="共享记忆" status={(view?.assistantOptions||assistantOptions).researchPolicy==="materials-only"?"本轮不使用":selection?selection.enabled?"已启用":"未启用":"展开核对"}/>} key={'details-memory-'+(view?.work.id || draftRevision)} compact workId={view?.work.id} initialSelection={memorySelection} disabled={busy || !!active} onSelectionChange={setMemorySelection} usage={view?.memoryUse}/>
          </section>
          <section className="agent-detail-section agent-detail-progress"><h3 className="agent-detail-group-title" hidden={taskStatusOnly}>进度与成果</h3>
        <details ref={workControls} className="agent-work-controls agent-detail-row" open={taskStatusOnly||undefined}><summary hidden={taskStatusOnly}><AgentDetailSummary icon={<Activity size={16}/>} title="任务状态" status={controlsNeedAttention?"需要处理":active?"正在处理":view?states[view.work.state]||view.work.state:"尚未开始"}/></summary>
        <dl className="agent-task-facts"><div><dt>任务进展</dt><dd>{active?"正在处理":view?states[view.work.state]||view.work.state:"尚未开始"}</dd></div><div><dt>对话消息</dt><dd>{view?.conversation?.messages.length||0} 条</dd></div><div><dt>上下文占用</dt><dd>{view?.nativeContext?.usedPercent==null?"尚未报告":view.nativeContext.usedPercent+"%"}</dd></div></dl>
        {view&&<label className="agent-confirm-message"><input type="checkbox" checked={confirmMessage} disabled={busy||!!active} onChange={event=>setConfirmMessage(event.target.checked)}/>这条内容是我确认的决定</label>}

        {view && view.work.state!=="revoked" ? <>
        {!businessCheck?.scopeChanging && <details><summary>计划与完成情况</summary>
        {view.work.state !== "revoked" && view.goalRevision && <AgentGoalRevision value={view.goalRevision} />}
        {view.work.state !== "revoked" && view.taskTree && <AgentTaskTree value={view.taskTree} />}
        {view.work.state !== "revoked" && view.workingState && view.work.revision!==undefined && view.work.authorizationVersion!==undefined && <AgentWorkingState value={view.workingState} scope={{workId:view.work.id,currentWorkRevision:view.work.revision,authorizationVersion:view.work.authorizationVersion}}/>}
        {view.work.state !== "revoked" && view.goalAssessment && <AgentGoalAssessment value={view.goalAssessment} answered={!active && view.work.state === "completed" && report?.status === "completed"} />}
        </details>}
        <AgentMaterialBudget value={view.materialBudget}/>
        <AgentNativeContext value={view.nativeContext}/>
        <AgentContextCompaction value={view.contextCompaction} disabled={busy || !!active} onRequest={()=>void changeCompaction()} onCancel={()=>void changeCompaction(true)}/>
        {view.lifecycle && <AgentLifecycle value={view.lifecycle} mode={mode} disabled={busy || !!active} onResume={()=>{uiTiming.begin("resume");void run(view.work.id,view.lifecycle);}} onCancel={()=>void mutate("cancelGoal")}/> }
        </> : <p className="agent-note">{view?"来源授权已撤回，保留历史记录供查看。":"尚未开始任务，发送消息后可查看实际用量和任务控制。"}</p>}
        </details>
        <div className="agent-detail-outcomes" hidden={taskStatusOnly}>{conversationDetails}</div></section>
        </div>
        </div></details>
          <button type="button" title="新对话" aria-label="新对话" disabled={busy || !!active} onClick={()=>newInvestigation()}><Plus size={19} /></button>
        </div>
        <AgentTaskMode activeTopic={research?.topic} onUnpinTopic={async topic=>{const scope=selectionScope.current;const saved=await call<ResearchTopic>({action:"saveResearchTopic",topic:{...topic,pinned:false}});if(alive.current&&selectionScope.current===scope&&research?.topic.id===saved.id)setResearch({...research,topic:{...research.topic,revision:saved.revision,pinned:false}});}} title={chatTitle} disabled={busy || !!active} tagMode={tagMode} onGeneral={()=>setTagMode(false)} onTag={enableTagMode} selectedSkills={selectedSkills.map(token=>token.slice(1))} onTopics={()=>{setRequestedTopic(undefined);setTopicSave(false);setTopicsOpen(true);}} onTopic={topic=>{setRequestedTopic(topic.id);setTopicSave(false);setTopicsOpen(true);}} onUsage={()=>{detailsReturn.current=document.getElementById(panelId)?.querySelector<HTMLElement>(".agent-task-mode>summary")||null;setTaskStatusOnly(true);setHistoryExpanded(false);if(detailsMenu.current)detailsMenu.current.open=true;if(workControls.current)workControls.current.open=true;setTimeout(()=>{if(detailsMenu.current?.open)detailsMenu.current.querySelector<HTMLButtonElement>(".agent-details-heading button")?.focus();},0);}}/>
        <div className="agent-header-end">
          <button type="button" aria-label={docked?"切换为浮窗":"展开为侧边栏"} title={docked?"切换为浮窗":"展开为侧边栏"} onClick={()=>{setDocked(value=>!value);detailsPopover.close();}}>{docked?<PanelsTopLeft size={18}/>:<PanelRight size={18}/>}</button>
          <button ref={detailsTrigger} type="button" title="对话详情" aria-label="对话详情" onClick={event=>{if(detailsMenu.current?.open&&!historyExpanded){detailsPopover.close();event.currentTarget.focus();return;}detailsReturn.current=event.currentTarget;setTaskStatusOnly(false);setHistoryExpanded(false);if(detailsMenu.current)detailsMenu.current.open=true;setTimeout(()=>{if(detailsMenu.current?.open)detailsMenu.current.querySelector<HTMLButtonElement>(".agent-details-sections .agent-details-heading button")?.focus();},0);}}><MoreHorizontal size={18}/></button>
          <button type="button" title="关闭助手（Esc）" aria-label="关闭助手" onClick={closePanel}><X size={19} /></button>
        </div>
      </header>
      <div className="agent-body">
      <div className="agent-conversation-wrap" aria-busy={loadingConversation || sourceLoading}>
      {loadingConversation && <div className="agent-conversation-loading" role="status" aria-label="正在打开对话"><span/><span/><span/></div>}
      <div className="agent-conversation" hidden={loadingConversation || (sourceScope.current===sourceScopeKey && (!!sourcePreview || !!sourceError || sourceLoading))} ref={conversationScroll.element} tabIndex={0} aria-label="对话与报告" onScroll={conversationScroll.onScroll} onClickCapture={event=>{if((event.target as Element).closest(".agent-activity-toggle,details > summary"))conversationScroll.holdPosition();}}>
      <div className="agent-conversation-content" ref={conversationScroll.content}>

      {controlsNeedAttention && view?.work.state!=="revoked" && <div className="agent-task-notice" role="status"><span>{view?.materialBudget?.preflight?.allowed===false || !!view?.materialBudget?.overrunBytes ? "资料处理容量不足" : view?.lifecycle?.requiresExplicitResume ? "任务已暂停，需手动恢复" : view?.lifecycle?.usageCompleteness==="incomplete" ? "部分模型用量尚未返回" : "任务状态需要处理"}</span><button type="button" onClick={()=>{setHistoryExpanded(false);if(detailsMenu.current)detailsMenu.current.open=true;if(workControls.current){workControls.current.open=true;workControls.current.querySelector("summary")?.focus();setTimeout(()=>workControls.current?.querySelector("summary")?.focus(),0);}}}>查看任务详情</button></div>}

      {newSource && <div className="agent-notice"><p>正在讨论「{sourceTitle || currentObjectLabel}」。当前浏览：{newSource.title}</p><button type="button" disabled={busy || !!active} onClick={newSource.use}>用当前材料新建对话</button></div>}
      {tagMode&&<AgentTagWorkspace value={tagPreparation} disabled={busy||!!active} onChange={setTagPreparation} onCancel={()=>setTagMode(false)}/>}
      {!view && !tagMode && !loadingConversation && <div className="agent-welcome">
        <h2>{hasDraftSources?"从这份材料开始":"有什么可以帮你？"}</h2><p>{hasDraftSources?"提一个问题，或试试下面的建议。":"直接提问，或从＋添加需要使用的资料。"}</p>
        {hasDraftSources && <div className="agent-suggestions">{suggestions.map(({ label, icon: Icon, prompt }) => <button key={label} type="button" disabled={busy} onClick={() => { setGoal(prompt); goalInput.current?.focus(); }}><Icon size={18} aria-hidden="true" /><span>{label}</span></button>)}</div>}
      </div>}
      {!view && canEditNote && <button type="button" disabled={busy || !!active} onClick={() => void openNoteEditor()}>修改这篇 Obsidian 笔记</button>}
      <p ref={statusElement} tabIndex={-1} role="status" className="agent-status" hidden={!!view && (view.work.state === "completed" || (view.work.state === "investigating" && !!view.activity?.length && !stopping)) && !businessCheck?.uncertain && !acting && !latestAction}>{view ? (businessCheck?.uncertain ? "结果待核对，已暂停再次提交" : stopping && active ? "正在停止，已有进展会保留" : acting ? pendingLabel : `${states[view.work.state] || view.work.state}${latestAction?.state === "prepared" ? ` · ${actionLabel}草稿已准备，待你确认` : latestAction?.state === "verified" ? ` · ${actionLabel}结果已核验` : latestAction?.state === "unknown" || latestAction?.state === "partial" ? ` · ${actionLabel}结果待核对` : ""}`) : loadingConversation ? "" : busy ? "正在发送…" : ""}</p>
      {view && !businessCheck?.scopeChanging && <>
        {!view.conversation && <p className="agent-goal">{view.work.goal}</p>}
        {(view.validity || view.run?.error) && <p className="agent-notice">{view.validity || view.run?.error}</p>}
        {view.run?.error && ["failed","interrupted"].includes(view.work.state) && <section className="agent-notice" aria-label="本轮恢复说明"><p>问题与资料选择保留在本对话中。可从输入框下方的“资料”核对范围，处理失败原因后再继续；不会自动反复重试。</p>{view.activity?.some(run=>run.runId===view.run?.id && run.events.some(event=>event.kind==="unpublishedAnswer")) && <p>模型答复已保留在本轮工作过程中，但尚未完成交付核验，不能当作已保存成果。</p>}</section>}
        {view.conversation && <AgentConversation workId={view.work.id} recordVersion={view.recordVersion} conversation={view.conversation} revoked={view.work.state==="revoked"} onOpenCitation={(...args)=>void openCitation(...args)} onLoadEarlier={()=>void loadEarlier()} earlierLoading={historyLoadingScope===historyScope.current} earlierError={historyNotice?.scope===historyScope.current ? historyNotice.text : ""} renderAfter={inlineOutcomes} renderActions={message=>message.role==="assistant"&&message.report&&message.runId&&view&&<AgentAnswerSave workId={view.work.id} runId={message.runId} current={saveTarget} disabled={businessDisabled||!!active||!!view.lifecycle?.requiresExplicitResume||message.artifactState==="unavailable"} records={view.answerSaves} onChanged={()=>void refresh(view.work.id)}/>} activity={view.activity}/> }
        {view.work.state!=="revoked" && view.activity?.filter(run=>!view.conversation?.messages.some(message=>message.runId===run.runId || message.revision===run.revision)).map(run=><AgentActivity key={run.runId} value={run}/>)}
        {view.work.state!=="revoked" && view.nativeInputs?.map(input=><AgentNativeInput key={input.key} value={input} disabled={busy||stopping||(!running&&input.delivery!=="async")} onAnswer={async(answers,cancel)=>{
          const ticket=sequence.current;
          const receipt=await call<{workId:string;runId:string;key:string;saved:boolean;startNewTurn?:boolean}>({action:"answerNativeInput",id:view.work.id,runId:input.runId,key:input.key,answers,cancel,expectedRevision:view.work.revision,expectedAuthorizationVersion:view.work.authorizationVersion});
          if(receipt?.saved!==true || receipt.workId!==view.work.id || receipt.runId!==input.runId || receipt.key!==input.key) throw new Error("回答保存回执不匹配，请刷新核对后再操作");
          if(alive.current && ticket===sequence.current) {
            const refreshed=refresh(view.work.id), refreshTicket=sequence.current;
            void refreshed.then(next=>{
              if(receipt.startNewTurn && alive.current && refreshTicket===sequence.current && !next.lifecycle?.requiresExplicitResume && canRunMode(next.lifecycle,mode)) void run(next.work.id,undefined,next.lifecycle);
            }).catch(()=>{/* Refresh reports its own error; the saved answer remains acknowledged. */});
          }
        }}/>) }
        <AgentCharts workId={view.work.id} recordVersion={view.recordVersion} items={view.analysisArtifacts || []} revoked={view.work.state === "revoked"} />
        {view.work.report?.status!=="completed" && view.work.state!=="revoked" && (view.workingState?.revision||0)>0 && view.work.revision!==undefined && view.work.authorizationVersion!==undefined && <AgentExternalReport key={`${view.work.id}:${view.work.revision}:${view.work.authorizationVersion}`} id={view.work.id} revision={view.work.revision} authorization={view.work.authorizationVersion} disabled={busy||!!active||view.lifecycle?.executionModes?.quick!==true||!!view.lifecycle?.requiresExplicitResume} onChanged={()=>{void revalidate(view.work.id).catch(reason=>setError(String(reason)));}}/>}
        {reportContinuation && <div>
          <button type="button" disabled={reportDisabled} aria-describedby={`agent-report-only-${view.work.id}`} onClick={()=>{
            if(reportDisabled)return;
            const recovery=view.lifecycle?.requiresExplicitResume ? view.lifecycle : undefined;
            uiTiming.begin(recovery ? "resume" : "continue");
            void run(view.work.id,recovery,view.lifecycle,reportContinuation);
          }}>仅补交报告</button>
          <p id={`agent-report-only-${view.work.id}`} className="agent-note">保留「{reportChart?.content?.spec.title}」第 {reportChart?.revision} 版的数据和图表，核对当前出处后补交报告，不重复修改或重算。
            {reportProvider!=="codex" ? (reportProvider ? "请先在本事项选择 Codex。" : "当前模型信息待核对，请刷新后再试。") : reportDisabled && !busy && !active ? (view.lifecycle?.reason || "当前不能开始新分析，请先核对额度和待核验结果。") : ""}
          </p>
        </div>}
        <AgentSleepDatasets workId={view.work.id} recordVersion={view.recordVersion} items={(view.sleepDatasets || []).filter(dataset => !(view.analysisArtifacts || []).some(chart => chart.content?.data.extractionDataset?.datasetId === dataset.datasetId && chart.content?.data.extractionDataset?.revision === dataset.revision))} revoked={view.work.state === "revoked"} />
        <AgentDelivery workId={view.work.id} recordVersion={view.recordVersion} report={view.conversation ? null : report ?? null} evidence={view.evidence} progress={view.activity?.length || (view.conversation && report) ? null : view.progress} history={view.conversation ? [] : view.history} running={!!running} revoked={view.work.state === "revoked"} runId={view.run?.id} onOpenCitation={(...args)=>void openCitation(...args)}/>
        {!view.conversation&&report&&view.run?.id&&<AgentAnswerSave workId={view.work.id} runId={view.run.id} current={saveTarget} disabled={businessDisabled||!!active||!!view.lifecycle?.requiresExplicitResume} records={view.answerSaves} onChanged={()=>void refresh(view.work.id)}/>}
        {outcomes(view.actions?.items.filter(a=>a.kind!=="tagProposal" && (!view.conversation || a.baseRevision===undefined || !view.conversation.messages.some(m=>m.revision===a.baseRevision))) || [])}
        {view.draftRequest && !active && <button type="button" disabled={businessDisabled} onClick={()=>void businessAction({action:"prepareResponse",runId:view.draftRequest!.runId})}>继续准备本轮草稿</button>}
        {(!active && ["ready","interrupted","failed","expired"].includes(view.work.state) || view.work.state==="revoked") && <div className="agent-actions">
          {view.work.state==="revoked" ? <button type="button" disabled={busy} onClick={()=>newInvestigation()}>新建调查</button> : <button type="button" disabled={busy || !canRunMode(view.lifecycle,mode)} onClick={() => {uiTiming.begin("continue");void run(view.work.id);}}>继续调查</button>}
        </div>}

      </>}
      </div>
      </div>
      {view && !businessCheck?.scopeChanging && sourceScope.current===sourceScopeKey && view.work.state!=="revoked" && (sourcePreview || sourceError || sourceLoading) && <section ref={sourcePreviewElement} className="agent-source-preview" aria-label="引用原文"><header><strong>{sourcePreview?.excerpt.title || (sourceLoading?"正在核对引用来源…":"引用暂不可读取")}</strong><button type="button" aria-label="关闭引用原文" onClick={returnFromCitation}>关闭</button></header>{sourceLoading ? <p role="status">正在读取当前版本的原文…</p> : sourceError ? <p role="alert">{sourceError}。可核对来源后重新打开引用。</p> : sourcePreview && <><p className="agent-note">{sourcePreview.excerpt.sourcePath} · 第 {sourcePreview.excerpt.startChar+1}–{sourcePreview.excerpt.endChar} 字符{sourcePreview.excerpt.truncated?"（原文节选）":""}</p><blockquote>{sourcePreview.excerpt.content.includes(sourcePreview.quote)?<>{sourcePreview.excerpt.content.slice(0,sourcePreview.excerpt.content.indexOf(sourcePreview.quote))}<mark>{sourcePreview.quote}</mark>{sourcePreview.excerpt.content.slice(sourcePreview.excerpt.content.indexOf(sourcePreview.quote)+sourcePreview.quote.length)}</>:sourcePreview.excerpt.content}</blockquote></>}</section>}
      {conversationScroll.showLatest && !reportReading && !citationOpen && <button type="button" className="agent-jump-latest" onClick={conversationScroll.scrollToLatest}><ArrowDown size={14} aria-hidden="true"/>回到最新内容</button>}
      </div>
      {businessCheck?.uncertain && <section className="agent-notice" aria-label="操作结果待核对" role="alert">
        <strong>结果待核对</strong><p>这次操作可能已经完成。为避免重复保存，已暂停再次提交；请先核对当前结果。</p>
        <button type="button" disabled={busy || !!pendingAction || businessCheck.checking} aria-busy={businessCheck.checking} onClick={() => void checkBusinessOutcome()}>核对当前结果</button>
      </section>}
      {error && !businessCheck && <div className="agent-error" role="alert">{error.includes("资料库不在本次有效授权范围") ? "待发送资料所属的资料库已停用、移除或不在有效授权范围。切换浏览页面不会自动替换输入框中的资料，请移除失效资料或改用当前页面。" : error}{!view && error.includes("资料库不在本次有效授权范围") && browsing?.entry && <button type="button" disabled={busy} onClick={()=>{
        const entry=browsing.entry;
        const locator=entry && ('result' in entry ? investigationAnchor(entry.result) : {kind:"reading" as const,itemKey:entry.itemKey});
        if(!locator)return;
        setPageAttached(false);setWholeLibrary(false);setMaterials([]);setRemovals([]);setPublicUrl("");
        setDropped([{locator,title:entry && 'result' in entry ? entry.result.documentTitle||entry.result.title : entry?.title||"当前阅读条目"}]);
        setError("");goalInput.current?.focus();
      }}>改用当前页面</button>}{!view && !error.includes("资料库不在本次有效授权范围") && <button type="button" disabled={busy} onClick={() => void load()}>重新读取记录</button>}</div>}
      {view&&<AgentFollowups items={view.followups||[]} busy={busy} active={!!active} canSteer={!!steerable} onResume={()=>void resumeQueue()} onAction={async(item,operation,payload)=>{
        setBusy(true);try{const next=await call<View>({action:"changeFollowup",id:view.work.id,clientMessageId:item.clientMessageId,editVersion:item.editVersion,operation,...payload,...(operation==="send"?{expectedRunId:view.lifecycle?.activeRunId??(steerable?steerable.runId:null)}:{})});setView(current=>acceptLifecycleSnapshot(current,next));if(operation==="send"&&!active)void resumeQueue(item.clientMessageId);}finally{setBusy(false);}
      }}/>}
      <AgentResearchTopics onBack={()=>{setTopicsOpen(false);const menu=document.getElementById(panelId)?.querySelector<HTMLDetailsElement>(".agent-task-mode");if(menu){menu.open=true;menu.querySelector("summary")?.focus();}}} onMetadata={saved=>{if(research?.topic.id===saved.id)setResearch({...research,topic:{...research.topic,revision:saved.revision,pinned:saved.pinned}});}} initialId={requestedTopic} open={topicsOpen} saveMode={topicSave} active={research?.topic} disabled={busy||!!active} config={{grant:research?researchGrant(manualResearchGrant(),research.topic.grant,research.includeManual):manualResearchGrant(),policy:(view?.assistantOptions||assistantOptions).researchPolicy||"material-first",skills:research?[...new Set([...research.topic.skills,...selectedSkills.map(s=>s.slice(1))])]:selectedSkills.map(s=>s.slice(1))}} onApply={applyResearch} onClose={()=>setTopicsOpen(false)}/>
      <div className="agent-composer" hidden={reportReading} onPaste={event=>{const files=Array.from(event.clipboardData.files);if(files.length){event.preventDefault();void addFiles(files);}}}>
        <input ref={fileInput} type="file" aria-label="选择图片或文本文件" accept={agentFileAccept} multiple hidden onChange={event=>{const files=Array.from(event.currentTarget.files||[]);event.currentTarget.value="";void addFiles(files);}}/>
        {open && globalPanel && (assistantOptions.model?.provider ?? runtime.settings.provider ?? "codex") === "codex" && <CodexAccountBadge boundScopeId={view?.codexAccountBinding?.scopeId} workId={view?.work.id} disabled={!!active||pendingRun} needsAuthorization={[error,view?.run?.error].some(value=>value?.includes("请确认账号后继续"))} onAuthorized={()=>{setError("");void refresh(view!.work.id);}}/>}
        <div className="agent-composer-materials">
        {research&&<div className="agent-topic-selection"><AgentActiveTopic topic={research.topic} disabled={busy||!!active} onChange={topic=>setResearch({...research,topic})} onCancel={()=>void cancelResearch()}/><label><input type="checkbox" checked={research.includeManual} disabled={busy||!!active} onChange={e=>setResearch({...research,includeManual:e.target.checked})}/>下一条同时使用手选资料与技能</label></div>}

        {libraryDraft!==null&&!selectedLibraries.length&&!!view?.work.grant.libraryIds.length&&<p className="agent-note">下一条问题将清除整库范围，单独添加的页面保留。<button type="button" onClick={()=>setLibraryDraft(null)}>撤销</button></p>}
        {(dropped.length>0||snippets.length>0)&&<div className="agent-pending-materials" aria-label="待添加资料">{dropped.map((item,index)=><AgentMaterialCard key={JSON.stringify(item.locator)} kind={item.locator.kind==="reading"?"reading":item.locator.kind==="task"?"task":"page"} title={item.title} disabled={busy} onRemove={()=>{setDropped(current=>current.filter((_,i)=>i!==index));goalInput.current?.focus();}}/>)}{snippets.map((item,index)=><AgentMaterialCard key={`text-${index}`} kind={item.kind} title={item.kind==="text"&&!item.file?item.text:item.title} subtitle={`${item.file?"文本附件 · 全文":item.kind==="text"?"所选文字":"闪卡文字快照"} · ${item.text.length}字 · ${item.title}`} disabled={busy} onRemove={()=>{setSnippets(current=>current.filter((_,i)=>i!==index));goalInput.current?.focus();}}/>)}</div>}
        {view?.work.grant.notes?.filter(n=>isTextAttachment(n)&&!removals.some(r=>materialKey(r)===materialKey(n))).map(locator=><AgentTextFileCard key={materialKey(locator)} locator={locator} disabled={businessDisabled||!!active} onRemove={()=>{setRemovals(current=>[...current,locator]);setAddPage("pages");setAddMenuOpen(true);if(materialPopover.ref.current)materialPopover.ref.current.open=true;}}/>)}
        {!!selectedImages.length && <AgentImageCards images={selectedImages} disabled={busy||filePreparing} pending={imagesChanged} onRemove={image=>{if(active&&currentImages.some(g=>sameImage(g,image))){setError("已发送图片请在本轮结束后撤回。");return;}setImageDraft(selectedImages.filter(g=>!sameImage(g,image)));}}/>}{imageChanges.removeImages.length>0&&<p className="agent-note">将随下一条问题移除 {imageChanges.removeImages.length} 张图片。<button type="button" disabled={busy} onClick={()=>setImageDraft(null)}>撤销图片更改</button></p>}
        {!view && publicUrl && <div className="agent-pending-materials"><AgentMaterialCard kind="link" title={publicUrl} removeLabel="移除公共链接" disabled={busy} onRemove={()=>setPublicUrl("")}/></div>}
        {(!view && pageAttached || materials.length>0) && <div className="agent-pending-materials" aria-label="待发送资料">
          {!view && pageAttached && <AgentMaterialCard kind={anchor?.kind==="reading"?"reading":anchor?.kind==="task"?"task":"page"} title={pageTitle||currentObjectLabel} subtitle={wholeLibrary?`${libraryName} · 整个资料库`:undefined} disabled={busy} openLabel="查看本次资料范围" onOpen={()=>{setAddPage("scope");if(materialPopover.ref.current)materialPopover.ref.current.open=true;}} removeLabel="移除当前页面" onRemove={()=>{setPageAttached(false);setWholeLibrary(false);goalInput.current?.focus();}}/>}
          {materials.map(item=><AgentMaterialCard key={materialKey(item.locator)} kind="page" title={item.title} subtitle={item.totalChars!==undefined?`文本附件 · 共 ${item.totalChars.toLocaleString()} 字符 · 待发送`:`页面 · ${item.libraryName}`} disabled={busy||filePreparing} onRemove={()=>{setMaterials(current=>current.filter(note=>materialKey(note.locator)!==materialKey(item.locator)));goalInput.current?.focus();}}/>)}
        </div>}
        </div>
        {view?.work.state !== "revoked" && <form onSubmit={event=>void create(event)}>
          {tagSuggestion&&<button type="button" className="agent-tag-open" disabled={busy||!!active} onClick={()=>prepareTagTask(tagSuggestion)}>准备标签任务 · {tagTaskNames[tagSuggestion]}</button>}<AgentTagReferences value={tagPreparation} mode={tagMode} disabled={busy||!!active} onChange={setTagPreparation} searchOpen={tagSearchOpen} onSearchClose={()=>setTagSearchOpen(false)}/><AgentTagRelated tags={[...tagPreparation.references,...(tagMode&&tagPreparation.tag?[tagPreparation.tag]:[])]} grant={researchGrant(manualResearchGrant(),research?.topic.grant,research?.includeManual)} disabled={busy||!!active} onAdd={item=>setMaterials(items=>items.some(m=>materialKey(m.locator)===materialKey(item.locator))?items:[...items,item])}/>
          {!!selectedSkills.length && <div className="agent-selected-skills" aria-label="本次指定技能">{selectedSkills.map(token=><span key={token}><WandSparkles size={13} aria-hidden="true"/>{skillTitle(token.slice(1))}<button type="button" aria-label={`移除技能 ${skillTitle(token.slice(1))}`} disabled={busy} onClick={()=>setGoal(selectedSkills.filter(item=>item!==token).map(item=>item+" ").join("")+questionText)}><X size={13}/></button></span>)}</div>}
          {suggestedQuestion&&usedQuestion!==suggestedQuestion.id&&view?.work.id===initialWorkId&&<div className="agent-note"><p>关联核对提问已准备，不会自动发送。{goal.trim()?"先保留当前输入，再使用这条提问。":"可先检查资料范围，再开始核对。"}</p><button type="button" disabled={busy||!!active||!!goal.trim()} onClick={()=>{setGoal(suggestedQuestion.text);setUsedQuestion(suggestedQuestion.id);goalInput.current?.focus();}}>使用关联核对提问</button><button type="button" onClick={()=>setUsedQuestion(suggestedQuestion.id)}>忽略这条提问</button></div>}
          <label className="agent-question"><span className="agent-visually-hidden">{view ? "继续对话" : "希望助手做什么"}</span><textarea rows={2} ref={goalInput} name="investigationGoal" value={questionText} maxLength={(view?4000:2000)-skillPrefix.length} disabled={busy} onChange={event => setGoal(skillPrefix+event.target.value)} placeholder={view?"继续追问，或告诉我接下来做什么…":hasDraftSources?"询问 Hub 助手…":"询问 Hub 助手…"} onKeyDown={event => {
            if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !event.nativeEvent.isComposing) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); }
          }} /></label>
          <div className="agent-composer-controls">
            <details ref={materialPopover.ref} className="agent-add-menu agent-popover" name="hub-agent-preference" onToggle={event=>{if(event.target!==event.currentTarget)return;setAddMenuOpen(event.currentTarget.open);if(!event.currentTarget.open)setAddPage("home");}}>
              <summary aria-label="添加附件" title="添加附件"><Plus size={20} aria-hidden="true"/></summary>
              <div className={`agent-add-content${(addPage==="materials" || addPage==="scope" || addPage==="pages")?" agent-add-materials":addPage==="skills"?" agent-add-skills":""}`}>
                <div className="agent-popover-header">{!["home","scope","materials","skills"].includes(addPage)&&<button type="button" className="agent-menu-back" ref={addBack} aria-label="返回资料范围" onClick={()=>setAddPage("scope")}><ArrowLeft size={16}/></button>}<strong>{addPage==="home"?"添加到本次对话":addPage==="skills"?"技能":addPage==="pages"?"核心材料":addPage==="images"?"资料库图片":addPage==="web"?"公共链接":"资料范围"}</strong><button type="button" aria-label="关闭添加菜单" title="关闭" onClick={()=>materialPopover.close(true)}><X size={16}/></button></div>
                {addPage==="home" && <div className="agent-add-choices">
                  <button type="button" className="agent-menu-choice" disabled={busy||filePreparing||!!businessCheck||!!view?.work.grant.manifest||!!publicUrl} onClick={()=>fileInput.current?.click()}><FileText size={18}/><span><strong>添加图片或文件</strong><small>也可以直接拖入或粘贴到输入框</small></span><ChevronRight size={15}/></button>
                  <button type="button" className="agent-menu-choice" onClick={()=>{setTagSearchOpen(true);materialPopover.close();}}><Tags size={18}/><span><strong>添加标签</strong><small>引用标签参与讨论</small></span><ChevronRight size={15}/></button>
                  <p className="agent-note">资料库里的图片和文档可直接拖入，也可通过「资料范围」查找。</p>
                </div>}
                {addMenuOpen && addPage==="images" && <AgentImages current={selectedImages} disabled={busy || filePreparing || !!businessCheck || !!view?.work.grant.manifest || !!publicUrl} onApply={updateImages}/>}
                {addMenuOpen && addPage==="web" && <div className="agent-add-section"><label>公共网页地址<input type="url" aria-label="公共网页地址" value={publicUrl} disabled={busy} onChange={event=>setPublicUrl(event.target.value)} placeholder="https://example.org/article"/></label><p className="agent-note">发送问题即读取并保存此公开网页。仅支持 HTTPS 文本与 HTML 源码；不登录、不跟随跳转，不加载脚本和图片。每次最多 256 KiB，30 秒超时。遇到代理虚拟地址时向 Cloudflare 加密查询域名，不发送正文。</p><button type="button" onClick={()=>{materialPopover.close(true);goalInput.current?.focus();}}>返回填写问题</button></div>}
                {addMenuOpen && addPage==="skills" && <AgentSkills pinned={pinnedSkills} onPin={toggleSkillPin} selected={selectedSkills.map(token=>token.slice(1))} onReset={()=>setGoal(questionText)} disabled={busy || (!!active && !steerable)} onSelect={name=>{setGoal(current=>new RegExp(`(^|[^a-zA-Z0-9_$\\\\-])\\$${name}(?=$|[^a-zA-Z0-9_-])`).test(current)?current:`$${name} ${current}`);materialPopover.close(false);goalInput.current?.focus();}} embedded/>}
                {addMenuOpen && (addPage==="materials" || addPage==="scope" || addPage==="pages") && <div className="agent-add-section agent-scope-body">
            {addPage!=="pages"&&<div className="agent-scope-overview">
              <details><summary><SlidersHorizontal size={16}/><strong>资料策略</strong><small>{policyNames[(view?.assistantOptions||assistantOptions).researchPolicy||"material-first"]}</small><ChevronDown size={14}/></summary><AgentResearchPolicy value={(view?.assistantOptions||assistantOptions).researchPolicy||"material-first"} disabled={busy||!!active} onChange={policy=>void saveAssistantOptions({...view?.assistantOptions||assistantOptions,researchPolicy:policy}).then(()=>{if(research)setResearch({...research,topic:{...research.topic,policy}});}).catch(e=>setError(String(e)))}/></details>
              <button type="button" onClick={()=>setAddPage("pages")}><FileText size={16}/><strong>核心材料</strong><span>{coreMaterialCount?`${coreMaterialCount} 份资料`:"添加页面"}</span><ChevronRight size={14}/></button>
              <details><summary><Library size={16}/><strong>可检索的资料库</strong><small>{composerLibraries.length?composerLibraries.length+" 个库":"未选择"}</small><ChevronDown size={14}/></summary>{!view?.work.grant.manifest&&<AgentLibraryScope registry={libraryRegistry} selected={composerLibraries} disabled={businessDisabled||!!active||confirmMessage||view?.work.state==="revoked"} onChange={changeLibraries}/>}</details>

            </div>}
            {addPage==="pages"&&<div className="agent-scope-extra"><button type="button" disabled={!!view?.work.grant.manifest||!!publicUrl} onClick={()=>setAddPage("images")}>选择资料库图片</button>{!view&&!pageAttached&&!materials.length&&(assistantOptions.researchPolicy!=="materials-only")&&<button type="button" onClick={()=>setAddPage("web")}>读取公共链接</button>}</div>}
            {addPage==="pages"&&<>

            {(browsing?.entry || (!view && pageAnchor)) && <button type="button" className="agent-menu-choice" disabled={busy || filePreparing || !!businessCheck || !!view?.work.grant.manifest || (!browsing?.entry && pageAttached)} onClick={()=>{if(browsing?.entry)addExternalMaterial(browsing.entry);else if(pageAnchor){setPageAttached(true);setMaterials(current=>current.filter(item=>!sameNoteAnchor(item.locator,pageAnchor)));}}}><FileText size={18}/><span><strong>{!browsing?.entry && pageAttached?"当前页面已加入":"添加当前页面"}</strong><small>{(browsing?.entry && ("result" in browsing.entry ? browsing.entry.result.title : browsing.entry.title)) || pageTitle || currentObjectLabel}</small></span></button>}
            {!view?.work.grant.manifest && <AgentMaterials embedded hideFooter onDone={()=>setAddPage("scope")} key={view?.work.id || draftRevision} anchor={anchor?.kind==="note" ? anchor : undefined} anchorIncluded={!!anchor && (!!view || pageAttached)} selected={materials} retained={view ? view.work.grant.notes || (anchor?.kind==="note" ? [anchor] : []) : undefined} libraryIds={view?.work.grant.libraryIds} disabled={busy || filePreparing || !!businessCheck || confirmMessage} onChange={setMaterials} removed={removals} onRemove={view&&!active ? setRemovals : undefined} onWithdraw={view&&!active ? ()=>void withdrawMaterials() : undefined}/>}
            </>}
            <details hidden={addPage!=="pages"} className="agent-material-advanced" key={addPage} ><summary>固定清单与覆盖核对</summary><p className="agent-note">{selectedLibraries.length ? `当前库范围：${selectedLibraries.map(l=>l.name).join("、")}` : (!view && !hasDraftSources || !!view && !anchor && !view.work.grant.notes?.length) ? "未添加资料，可直接对话；可在这里添加资料" : view?.work.state==="revoked" ? "来源授权已撤回" : view?.work.grant.manifest ? `已固定授权 ${view.work.grant.manifest.members.length} 份资料` : (view ? !!view.work.grant.libraryIds.length : wholeLibrary) ? `当前范围：${view?.work.grant.libraryIds.length || 1} 个资料库` : !anchor && view ? `当前范围：${view.work.grant.notes?.length || 0} 份明确选中的文档/页面` : `当前范围：${sourceTitle || currentObjectLabel}，另有 ${view ? Math.max(0,(view.work.grant.notes?.length || 1)-1) : Math.max(0,materials.length+dropped.length-(pageAttached?0:1))} 份资料`}。这里的固定清单按已有版本核验；添加资料不会改动原文件。</p>
            {!view && canEditNote && anchor?.kind==="note" && <AgentSourceScope key={`source-scope-${draftRevision}`} libraryId={anchor.libraryId} disabled={busy || wholeLibrary || !!selectedLibraries.length || !!materials.length} canConfirm={!!goal.trim()} onConfirm={createSourceScope}/>}
            {view?.work.grant.manifest && view.work.revision!==undefined && view.work.authorizationVersion!==undefined && <AgentScopeCoverage key={`scope-coverage-${view.work.id}-${view.work.revision}-${view.work.authorizationVersion}-${view.recordVersion}`} workId={view.work.id} revision={view.work.revision} authorizationVersion={view.work.authorizationVersion} disabled={businessDisabled || !!active}/> }
            {view?.work.grant.manifest?.selection && anchor?.kind==="note" && <AgentSourceScope key={`scope-refresh-${view.work.id}-${view.work.revision}`} libraryId={anchor.libraryId} initialSelection={view.work.grant.manifest.selection} disabled={businessDisabled || !!active || confirmMessage} canConfirm={view.work.revision!==undefined} confirmationLabel="确认新范围，保留本对话（不启动分析）" onConfirm={replaceSourceScope}/>}
            {view?.work.grant.manifest && <p className="agent-note">已固定授权 {view.work.grant.manifest.members.length} 份材料。成员或版本变化后可重新确认范围，原累计预算保留；也可停止整个事项的来源授权。</p>}
            {<div className="agent-settings">
              <p className="agent-note">这里决定助手可以读取哪些资料。浏览其他页面不会自动授权；输入框中的资料会随问题一起发送给当前模型。</p>
              {!view && anchor?.kind==="note" && <label className="agent-grant"><input type="checkbox" disabled={busy} checked={composerLibraries.some(library=>library.id===anchor.libraryId)} onChange={event=>changeLibraries(event.target.checked?[...composerLibraries.filter(library=>library.id!==anchor.libraryId),{id:anchor.libraryId,name:libraryName}]:composerLibraries.filter(library=>library.id!==anchor.libraryId))}/>允许查找「{libraryName}」整个资料库的相关资料</label>}
              {!view && anchor?.kind!=="note" && <p className="agent-note">可在上方选择资料库范围，或单独添加页面。</p>}
            </div>}
            </details></div>}
                {addMenuOpen&&["materials","scope","pages"].includes(addPage)&&<footer className="agent-scope-footer"><p className="agent-note">{addPage==="pages"?"只添加选中的页面，不开放整个资料库。":hasDraftSources||research?"所选范围用于下一轮；浏览页面不会自动加入资料。":"未选资料，可直接提问。"}</p><div>{addPage!=="pages"&&<button type="button" disabled={busy||!!active||!!view?.work.grant.manifest||!hasDraftSources&&!research} onClick={()=>{materialPopover.close();setRequestedTopic(undefined);setTopicSave(true);setTopicsOpen(true);}}><FolderBookmark size={14}/>保存为专题</button>}<button type="button" className="agent-scope-done" disabled={addPage==="pages"&&(busy||filePreparing||!!businessCheck||confirmMessage||!!removals.length)} onClick={()=>{if(addPage==="pages")setAddPage("scope");else{materialPopover.close();goalInput.current?.focus();}}}>{addPage==="pages"?"完成选择":"完成"}</button></div></footer>}

              </div>
            </details>
            <AgentAssistantOptions section="permissions" value={(view ? view.assistantOptions || defaultAssistantOptions : assistantOptions)} disabled={busy || !!active} canAuto={anchor?.kind==="note"} onSave={saveAssistantOptions}/>
            <AgentScopeTrigger selected={detailGrant ? detailGrant.libraryIds.map(id=>({id,name:id})) : composerLibraries} registry={libraryRegistry} fallbackLabel={detailGrant ? (detailCoreCount ? `${detailCoreCount} 份资料` : "添加资料范围") : view?.work.grant.manifest ? `固定 ${view.work.grant.manifest.members.length} 份资料` : (materials.length || dropped.length || snippets.length || (view?.work.grant.notes?.length || 0)>1) ? "已添加资料" : (pageAttached || !!anchor) ? "当前页面" : "添加资料范围"} pending={libraryDraft!==null} disabled={busy || filePreparing || !!publicUrl} onClick={()=>{setAddPage("scope");setAddMenuOpen(true);if(materialPopover.ref.current)materialPopover.ref.current.open=true;}}/>
          <button type="button" className="agent-current-page agent-skill-shortcut" aria-label="添加技能" title="技能：选择本次使用的处理方法" disabled={busy || (!!active && !steerable)} onClick={()=>{setAddPage("skills");setAddMenuOpen(true);if(materialPopover.ref.current)materialPopover.ref.current.open=true;}}><WandSparkles size={18} aria-hidden="true"/></button>
          {textMaterials?.selection&&<button type="button" className="agent-current-page agent-selection-tool" aria-label="添加所选文字" title="添加所选文字（文字快照，不是区块）" disabled={busy||filePreparing||!!view?.work.grant.manifest} onMouseDown={event=>event.preventDefault()} onClick={()=>{addTextMaterial(textMaterials.selection!);textMaterials.clearSelection();}}><Quote size={18}/></button>}
            <AgentAssistantOptions value={(view ? view.assistantOptions || defaultAssistantOptions : assistantOptions)} disabled={busy || !!active} canAuto={anchor?.kind==="note"} onSave={saveAssistantOptions}/>
            {active && <button className="agent-send" type="button" aria-label="停止本轮" title="停止本轮" disabled={busy || stopping || !!view?.lifecycle && !view.lifecycle.activeRunId} onClick={()=>void mutate("cancel")}><Square size={13} fill="currentColor" aria-hidden="true" /></button>}
            {(!active || !!goal.trim() || !!materials.length || !!dropped.length || !!snippets.length || !!imageChanges.addImages.length) && <button className="agent-send" type="submit" aria-label={tagMode&&!active?tagTaskNames[tagPreparation.task]:saveOnly&&!active?"保存补充":"发送"} aria-keyshortcuts="Control+Enter Meta+Enter" title="发送" disabled={busy || filePreparing || stopping || !!removals.length || (!goal.trim()&&!materials.length&&!dropped.length&&!snippets.length&&!imageChanges.addImages.length&&!(tagMode&&tagPreparation.tag))}><ArrowUp size={19} /></button>}
          </div>
          {filePreparing&&<p className="agent-composer-note" role="status">正在准备附件，可继续输入…</p>}{saveOnly&&!active&&<p className="agent-composer-note">保存补充，不启动运行</p>}
        </form>}
      </div>
      </div>
    </aside></>, document.body)}
  </>;
}
