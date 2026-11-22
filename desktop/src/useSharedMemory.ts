import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { rememberMemoryPreference, type MemorySelection } from "./AgentPreferences";

export type MemoryKind = "rule" | "decision";
export type MemorySource = { origin: string; workId?: string; runId?: string; sourceRecordId?: string; proposedBy?: string; confirmedAt?: number; proposedAt?: number; changeReason?: string };
export type MemoryContent = { title: string; body: string; kind: MemoryKind };
export type MemoryProposal = { id: string; projectId: string; projectName?:string|null; expectedVersion: number; candidate: MemoryContent & {topicKey:string; reason:string}; source: MemorySource };
export type MemoryEntry = Omit<MemoryContent,"body"> & {
  id: string; topicKey: string; projectId: string; version: number; state: string; body: string | null;
  detail?: string; source?: MemorySource; updatedAt?: number; history?: {version:number}[];
};
export type MemoryVersion = Omit<MemoryContent,"body"|"title"> & {version:number; title:string|null; body:string|null; source?: MemorySource};
type MemoryView = {
  configured: boolean; runtimeDetail?: string | null; entries: MemoryEntry[]; proposals?: MemoryProposal[];
  projects: {id:string; name:string}[]; selection: MemorySelection;
};
export type MemoryUse = { projectId: string; omissions?: {notRetrieved:number; budget:number}; notice?: string | null; items: {id:string; version:number; kind:string; reason:string}[] };
let memoryQueue: Promise<unknown> = Promise.resolve();
function read<T>(args: Record<string, unknown>) {
  const next = memoryQueue.then(() => invoke<T>("shared_memory", {args:{prepareRuntime:false,...args}}));
  memoryQueue = next.catch(() => undefined);
  return next;
}
const memoryChanged = "hub:shared-memory-content-changed";
const missingProject = "原记忆项目已不可用，已关闭记忆。请重新选择范围。";

export function readMemoryHistory(id: string) {
  return read<{versions: MemoryVersion[]}>({action:"history",id});
}

export function useSharedMemory({workId,runId,active,blocked,selection,onSelectionChange,showToolbarScope=false}: {
  workId?:string; runId?:string; active:boolean; blocked:boolean; selection:MemorySelection;
  onSelectionChange:(value:MemorySelection)=>void;showToolbarScope?:boolean;
}) {
  const [view,setView] = useState<MemoryView|null>(null);
  const [proposals,setProposals] = useState<MemoryProposal[]>([]);
  const [settingsOpen,setSettingsOpen] = useState(false);
  const [managerOpen,setManagerOpen] = useState(false);
  const [browseScope,setBrowseScope] = useState("");
  const [browse,setBrowse] = useState<{scope:string; items:MemoryProposal[]}|null>(null);
  const [busy,setBusy] = useState(false);
  const [loading,setLoading] = useState(false);
  const [error,setError] = useState("");
  const [notice,setNotice] = useState("");
  const current = useRef({workId,selection,managerOpen,browseScope});
  current.current = {workId,selection,managerOpen,browseScope};
  const managerReturn = useRef<HTMLElement|null>(null);
  const initializeBrowse = useRef(false);
  const mounted = useRef(false);
  const locked = useRef(false);
  const request = useRef<{payload:string; key:string}|null>(null);
  const version = useRef(0);
  const scopeReadFor = useRef<string|undefined>(undefined);
  const proposalRead = useRef(0);
  const browseRead = useRef(0);
  const onSelect = useRef(onSelectionChange);
  onSelect.current = onSelectionChange;

  useEffect(() => { mounted.current=true; return () => { mounted.current=false; }; }, []);
  useEffect(() => {
    setView(null); setProposals([]); setBrowse(null); setError(""); setNotice("");
    request.current=null;
  }, [workId]);
  const refreshProposals = useCallback(async () => {
    if (!workId || active) return;
    const id = ++proposalRead.current;
    try {
      const result = await read<{proposals:MemoryProposal[]}>({action:"workProposals",workId});
      if (mounted.current && current.current.workId===workId && id===proposalRead.current) setProposals(result.proposals ?? []);
    } catch { /* Explicit settings and manager reads offer a retry. */ }
  }, [workId,active]);
  useEffect(() => { void refreshProposals(); }, [refreshProposals,runId]);

  async function loadView(clearError=true) {
    const id = ++version.current;
    const previous = current.current.selection;
    if(clearError)setError("");
    setLoading(true);
    try {
      const next = await read<MemoryView>({action:"status",workId});
      if (!mounted.current || current.current.workId!==workId || id!==version.current) return;
      let effective = workId ? next.selection : previous;
      if (effective.projectId && !next.projects.some(value=>value.id===effective.projectId)) {
        if (workId) { setError("原记忆项目已不可用，请在此重新选择范围。"); }
        else if (current.current.selection===previous) {
          effective = {projectId:"",enabled:false};
          rememberMemoryPreference(effective); onSelect.current(effective); setNotice(missingProject);
        }
      } else if (workId) {
        scopeReadFor.current=workId;
        onSelect.current(effective);
      }
      setView(next);
      return effective;
    } catch (reason) {
      if (mounted.current && current.current.workId===workId && id===version.current) setError(String(reason));
    } finally {
      if (mounted.current && current.current.workId===workId && id===version.current) setLoading(false);
    }
  }
  async function loadBrowse(scope: string) {
    const id = ++browseRead.current;
    try {
      const next = await read<MemoryView>({action:"status",projectId:scope});
      if (!mounted.current || current.current.workId!==workId || id!==browseRead.current) return;
      setBrowse({scope,items:next.proposals ?? []});
      setView(existing => existing ? {...existing, entries:next.entries, projects:next.projects, configured:next.configured, runtimeDetail:next.runtimeDetail} : next);
    } catch (reason) {
      if (mounted.current && current.current.workId===workId && id===browseRead.current) setError(String(reason));
    }
  }
  const callbacks = useRef({loadView,loadBrowse,refreshProposals});
  callbacks.current = {loadView,loadBrowse,refreshProposals};

  useEffect(() => {
    if(workId&&showToolbarScope&&!current.current.managerOpen)void callbacks.current.loadView();
  },[workId,showToolbarScope]);

  useEffect(() => {
    if (!settingsOpen && !managerOpen) return;
    let cancelled=false;
    void callbacks.current.loadView().then(effective => {
      if (cancelled || !current.current.managerOpen) return;
      const initial = initializeBrowse.current && effective ? effective.projectId : current.current.browseScope;
      initializeBrowse.current=false;
      setBrowseScope(initial);
      void callbacks.current.loadBrowse(initial);
    });
    return () => { cancelled=true; };
  }, [workId,settingsOpen,managerOpen]);

  useEffect(() => {
    const listener = (event: Event) => {
      if ((event as CustomEvent).detail===current || locked.current) return;
      const state=current.current;
      void callbacks.current.refreshProposals().then(() => {
        if (state.managerOpen) void callbacks.current.loadBrowse(state.browseScope);
        else if (settingsOpen) void callbacks.current.loadView();
      });
    };
    window.addEventListener(memoryChanged,listener);
    return () => window.removeEventListener(memoryChanged,listener);
  }, [settingsOpen]);

  async function perform(args: Record<string,unknown>, message: string, selectScope = false) {
    if (blocked || locked.current) return false;
    locked.current=true; setBusy(true); setError(""); setNotice("");
    version.current++; browseRead.current++; proposalRead.current++;
    const context = workId;
    let ok = false;
    let nextBrowseScope: string | undefined;
    try {
      const next = await read<MemoryView>({...args,workId});
      ok=true;
      if (mounted.current && current.current.workId===context) {
        setLoading(false); setView(next); setNotice(message);
        if (selectScope) { scopeReadFor.current=workId; onSelect.current(next.selection); rememberMemoryPreference(next.selection); }
        if (args.proposalId) setProposals(values=>values.filter(item=>item.id!==args.proposalId));
        if (args.action==="createProject" && current.current.managerOpen) {
          const created=next.projects.find(project=>project.name===args.name && !view?.projects.some(previous=>previous.id===project.id));
          if (created) { nextBrowseScope=created.id; setBrowseScope(created.id); }
        }
      }
    } catch (reason) {
      if (mounted.current && current.current.workId===context) {
        setLoading(false); setError(String(reason));
        await callbacks.current.loadView(false);
      }
    } finally {
      locked.current=false;
      if (mounted.current) {
        setBusy(false);
        if (current.current.workId===context && !selectScope && current.current.managerOpen) void callbacks.current.loadBrowse(nextBrowseScope ?? current.current.browseScope);
      }
      if (!selectScope) window.dispatchEvent(new CustomEvent(memoryChanged,{detail:current}));
    }
    return ok;
  }
  function select(next: MemorySelection) {
    if (blocked || locked.current) return;
    setNotice(""); setError("");
    if (workId) { void perform({action:"selectScope",...next},"已更新本对话记忆",true); return; }
    rememberMemoryPreference(next); onSelect.current(next);
  }
  function openManager(trigger: HTMLElement) {
    managerReturn.current=trigger;
    initializeBrowse.current=true;
    setBrowseScope(selection.projectId); setBrowse(null); setError(""); setManagerOpen(true);
  }
  function closeManager() {
    setManagerOpen(false);
    requestAnimationFrame(() => { if(managerReturn.current?.isConnected) managerReturn.current.focus({preventScroll:true}); });
  }
  function browseProject(projectId: string) {
    setBrowseScope(projectId); setError("");
    void loadBrowse(projectId);
  }
  async function retryRead() {
    if (await loadView() && current.current.managerOpen) await loadBrowse(current.current.browseScope);
  }
  function save(content: MemoryContent, target: {projectId:string; topicKey:string; expectedVersion:number; proposalId?:string}, message: string) {
    const payload = {action:"put",...content,...target,confirmed:true,changeReason:"用户确认保存"};
    const identity = JSON.stringify(payload);
    if (request.current?.payload!==identity) request.current={payload:identity,key:crypto.randomUUID()};
    return perform({...payload,requestKey:request.current.key},message).then(ok=>{if(ok && request.current?.payload === identity) request.current=null;return ok;});
  }
  const projectLabel = (projectId: string) => !projectId ? "个人通用" : view?.projects.find(p=>p.id===projectId)?.name ?? "原记忆项目";

  return {view,selection,select,proposals,settingsOpen,setSettingsOpen,managerOpen,openManager,closeManager,
    browseScope,browseProject,browseProposals:browse?.scope===browseScope ? browse.items : undefined,projectLabel,
    perform,save,busy,loading,error,notice,scopePending:!!workId&&(!view||scopeReadFor.current!==workId),blocked:blocked||busy,retryRead};
}
export type SharedMemoryModel = ReturnType<typeof useSharedMemory>;
