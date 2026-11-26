import { useEffect, useMemo, useRef, useState } from "react";
import { Hourglass, Link2, Sparkles } from "lucide-react";
import type { QuickJournalItem } from "./JournalRecords";
import type { LibrarySummary, SearchResult } from "./SearchTypes";
import type { UnifiedTask } from "./TaskWorkspacePresentation";
import { normalizeResults } from "./SearchResultNormalization";
import {
  documentMaterial,
  extractClues,
  generate,
  journalMaterial,
  matchExisting,
  native,
  nextMonday,
  parseWaitFromText,
  shiftDay,
  todayKey,
  type Clue,
  type Material,
} from "./ActionEvidence";
import { read, write, identity, type ActionMeta, type Decision, type Wait } from "./ActionState";
import { Materials } from "./ActionMaterials";
import { sourceNoteStatus, type TaskNoteAction } from "./TaskPlanningSource";

type AdoptionOptions = Pick<Decision, "projectId" | "priority">;
type DecisionMap = Record<string, Decision>;
type AdoptionMode = "backlog" | "today" | "wait";
type Receipt = { state: string; task?: UnifiedTask; error?: string; sourceId?: string };
const CLUES_PER_PAGE = 3;
export function ActionHarvester({
  tasks,
  journals,
  scope,
  libraries,
  day,
  onUpdate,
  onRefresh,
  onSelect,
  onOpen,
  onCount,
  planFull = false,
  revision,
}: {
  tasks: UnifiedTask[];
  journals: QuickJournalItem[];
  scope: string[] | null;
  libraries: LibrarySummary[];
  day: string;
  onUpdate: (task: UnifiedTask, change: (m: ActionMeta) => ActionMeta) => Promise<void>;
  onRefresh: () => Promise<unknown>;
  onSelect: (t: UnifiedTask) => void;
  onOpen?: (r: SearchResult) => void;
  onCount?: (n: number) => void;
  planFull?: boolean;
  revision: number;
}) {
  const [docs, setDocs] = useState<SearchResult[]>([]),
    [readError, setReadError] = useState(""),
    [tick, setTick] = useState(0);
  const [busy, setBusy] = useState(""),
    [msg, setMsg] = useState(""),
    [messageKey, setMessageKey] = useState(""),
    [opened, setOpen] = useState(false),
    [target, setTarget] = useState("");
  const [edits, setEdits] = useState<Record<string, string>>({}),
    [panelKey, setPanelKey] = useState(""),
    [panelMode, setPanelMode] = useState<AdoptionMode>("backlog"),
    [adoptProject, setAdoptProject] = useState(""),
    [adoptPriority, setAdoptPriority] = useState<0 | 5>(0),
    [who, setWho] = useState(""),
    [what, setWhat] = useState(""),
    [review, setReview] = useState(day),
    [blocking, setBlocking] = useState(false);
  const [limit, setLimit] = useState(CLUES_PER_PAGE),
    [picker, setPicker] = useState(""),
    [matchSearch, setMatchSearch] = useState("");
  const [choices, setChoices] = useState<Record<string, string>>({});
  const initialRefined = useMemo(
    () => read<{ titles: Record<string, string>; excluded: string[] }>("clues.refined", { titles: {}, excluded: [] }),
    [],
  );
  const [excluded, setExcluded] = useState<Set<string>>(() => new Set(initialRefined.excluded));
  const [titles, setTitles] = useState<Record<string, string>>(() => initialRefined.titles);
  const [deepOpen, setDeepOpen] = useState(false);
  const [deepPicked, setDeepPicked] = useState<string[]>([]);
  const [deepClues, setDeepClues] = useState<Clue[]>([]);
  const lock = useRef(false);
  const scopeKey = JSON.stringify(scope);
  const lastScopeKey = useRef(scopeKey);
  useEffect(() => {
    let live = true;
    if (lastScopeKey.current !== scopeKey) {
      lastScopeKey.current = scopeKey;
      setDocs([]);
      setDeepPicked([]);
      setDeepClues([]);
      setDeepOpen(false);
      setPanelKey("");
    }
    setReadError("");
    native<unknown>("workbenchPassages", { scope }).then(
      (v) => {
        if (!live) return;
        // Keep original paragraph boundaries and unchecked boxes for action detection and evidence.
        const raw = new Map<string, string>();
        for (const passage of Array.isArray(v) ? v : [])
          if (typeof passage?.id === "string" && typeof passage.snippet === "string")
            raw.set(passage.id, passage.snippet);
        setDocs(
          normalizeResults(v).map((result) => ({ ...result, snippet: raw.get(result.id) ?? result.snippet })),
        );
      },
      (e) => {
        if (live) setReadError(String(e));
      },
    );
    return () => {
      live = false;
    };
  }, [scopeKey, revision]);
  const candidates = useMemo(() => {
    const limit = new Date(day + "T12:00:00");
    limit.setDate(limit.getDate() - 13);
    return extractClues([
      ...journals.filter((j) => j.record.date >= todayKey(limit)).map(journalMaterial),
      ...docs.map(documentMaterial),
    ]);
  }, [day, journals, docs]);
  const decisions = useMemo(() => read<DecisionMap>("clues", {}), [tick, revision]);
  const retryClues = Object.values(decisions)
    .filter(
      (d) =>
        d.clue &&
        ((d.state === "linking" && tasks.some((t) => identity(t) === d.taskKey)) ||
          (["creating", "unknown"].includes(d.state) &&
            d.libraryId &&
            (!scope || scope.includes(d.libraryId)))),
    )
    .map((d) => d.clue!);
  const clues = [...new Map([...retryClues, ...deepClues, ...candidates].map((c) => [c.key, c])).values()].filter(
    (c) =>
      !["linked", "ignored"].includes(decisions[c.key]?.state) &&
      (!excluded.has(c.key) || retryClues.some((pending) => pending.key === c.key)),
  );
  const deepSources = useMemo<Material[]>(() => {
    const limitDate = new Date(day + "T12:00:00");
    limitDate.setDate(limitDate.getDate() - 13);
    const byOrigin = new Map<string, Material>();
    for (const j of journals.filter((j) => j.record.date >= todayKey(limitDate))) {
      const m = journalMaterial(j);
      if (!byOrigin.has(m.id)) byOrigin.set(m.id, m);
    }
    for (const d of docs) {
      const m = documentMaterial(d);
      const docKey = d.documentId || m.id;
      if (!byOrigin.has(docKey)) byOrigin.set(docKey, m);
    }
    return [...byOrigin.values()].slice(0, 8);
  }, [day, journals, docs]);
  useEffect(() => {
    onCount?.(clues.length);
  }, [clues.length, onCount]);
  const possibleMatches = useMemo(
    () => new Map(clues.map((c) => [c.key, matchExisting(c, tasks)])),
    [candidates, decisions, deepClues, tasks, excluded],
  );
  const matchCount = [...possibleMatches.values()].filter((matches) => matches.length).length;
  const duplicateTaskGroups = useMemo(() => {
    const counts = new Map<string, number>();
    for (const task of tasks) {
      const groupKey = JSON.stringify([task.libraryId, task.collectionId || task.documentTitle, task.title]);
      counts.set(groupKey, (counts.get(groupKey) || 0) + 1);
    }
    return counts;
  }, [tasks]);
  const normalizedMatchSearch = matchSearch.trim().toLowerCase();
  const writable = libraries.filter((l) => l.provider === "dida365" && (!scope || scope.includes(l.id)));
  const destination = writable.some((l) => l.id === target) ? target : writable.length === 1 ? writable[0].id : "";
  const projectOptions = useMemo(() => {
    const byId = new Map<string, string>();
    for (const task of tasks) {
      if (destination && task.libraryId !== destination) continue;
      if (task.collectionId && !byId.has(task.collectionId)) {
        byId.set(task.collectionId, task.collectionName || task.documentTitle || task.collectionId);
      }
    }
    return [...byId.entries()].sort((a, b) => a[1].localeCompare(b[1], "zh-CN"));
  }, [tasks, destination]);
  async function decide(key: string, d: Decision) {
    await write("clues", { ...read<DecisionMap>("clues", {}), [key]: d });
    setTick((v) => v + 1);
  }
  async function run(key: string, fn: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true;
    setBusy(key);
    setMessageKey(key);
    setMsg("");
    try {
      await fn();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      lock.current = false;
      setBusy("");
    }
  }
  async function attach(t: UnifiedTask, c: Clue, today: string | false, w?: Wait, linking = false) {
    const evidence = c.material.title + "\n" + c.material.text;
    await onUpdate(t, (m) => ({
      ...m,
      day: today || m.day,
      links: [...m.links.filter((x) => x.id !== c.material.id || x.text !== c.material.text), c.material],
      note: m.note?.includes(evidence) ? m.note : [m.note, evidence].filter(Boolean).join("\n\n"),
      waits: w ? [...m.waits.filter((x) => x.id !== w.id), w] : m.waits,
    }));
    await decide(c.key, {
      state: linking ? "linking" : "linked",
      taskKey: identity(t),
      clue: linking ? c : undefined,
    });
    onSelect(t);
  }
  async function link(t: UnifiedTask, c: Clue) {
    await attach(t, c, false, undefined, true);
    try {
      const p = await native<TaskNoteAction>("prepareNote", {
        taskId: t.id,
        contentRevision: t.contentRevision,
        workId: "workbench-clue-" + t.sourceId,
        text: c.material.title + "\n" + c.material.text,
      });
      const result = ["prepared", "retryable"].includes(p.state)
        ? await native<TaskNoteAction>("submitNote", { id: p.id })
        : ["unknown", "writing"].includes(p.state)
          ? await native<TaskNoteAction>("inspectNote", { id: p.id })
          : p;
      if (result.state === "confirmed") await decide(c.key, { state: "linked", taskKey: identity(t) });
      setMsg("已关联到备料与推进备注。" + sourceNoteStatus(result));
    } catch (e) {
      setMsg("已保留来源及本地备注。滴答备注待处理：" + String(e));
    }
  }
  async function create(
    c: Clue,
    kind: AdoptionMode,
    options?: AdoptionOptions,
  ) {
    const old = read<DecisionMap>("clues", {})[c.key];
    const lib = old?.libraryId || destination;
    const title = old?.title || (edits[c.key] ?? titles[c.key] ?? c.title).trim();
    if (!lib || !title) throw Error("请选择滴答资料库并填写行动标题。");
    if (!old?.requestId && kind === "today" && planFull) throw Error("今日计划已满，请先移出一项。");
    const requestId = old?.requestId || crypto.randomUUID();
    const intent = {
      clue: c,
      requestId,
      sourceId: old?.sourceId,
      libraryId: lib,
      title,
      projectId: old?.requestId ? old.projectId : options?.projectId,
      priority: old?.requestId ? old.priority ?? 0 : options?.priority ?? 0,
      day: old?.requestId ? old.day : kind === "today" ? day : undefined,
      wait: old?.requestId
        ? old.wait
        : kind === "wait"
          ? { id: requestId, who: who.trim(), what: what.trim(), review, blocking }
          : undefined,
    };
    await decide(c.key, { ...intent, state: "creating" });
    const receipt = await native<Receipt>("createTask", {
      requestId,
      libraryId: lib,
      title,
      projectId: intent.projectId,
      priority: intent.priority,
    });
    if (receipt.state !== "confirmed" || !receipt.task) {
      if (receipt.state === "failed") {
        const remaining = read<DecisionMap>("clues", {});
        delete remaining[c.key];
        await write("clues", remaining);
        setTick((v) => v + 1);
      } else await decide(c.key, { ...intent, state: "unknown", sourceId: receipt.sourceId || old?.sourceId });
      throw Error(receipt.error || "滴答写入尚未确认。核对原回执，或关联已出现的任务。");
    }
    await attach(receipt.task, c, intent.day || false, intent.wait);
    await onRefresh();
    setPanelKey("");
    setMsg(receipt.error || "滴答已回读确认，来源已保留。");
  }
  function openAdoption(c: Clue, mode: AdoptionMode, toggle = false) {
    if (toggle && panelKey === c.key && panelMode === mode) {
      setPanelKey("");
      return;
    }
    if (panelKey !== c.key) {
      const parsed = parseWaitFromText(edits[c.key] ?? titles[c.key] ?? c.title, day);
      setAdoptProject("");
      setAdoptPriority(0);
      setWho(parsed.who);
      setWhat(parsed.what);
      setReview(parsed.review);
      setBlocking(parsed.blocking);
    }
    setPanelKey(c.key);
    setPanelMode(mode);
  }
  async function refine() {
    const batch = clues.filter((clue) => !decisions[clue.key]).slice(0, 32);
    if (!batch.length) throw Error("没有可提炼的新线索，请先处理尚未确认的采纳或关联。");
    const materials = batch.map((c, i) => ({ ...c.material, id: String(i) }));
    const claims = await generate("harvest", materials);
    const kept = new Set(claims.map((c) => c.source));
    const nextTitles = { ...titles, ...Object.fromEntries(claims.map((c) => [batch[Number(c.source)].key, c.text])) };
    const nextExcluded = new Set([
      ...excluded,
      ...batch.filter((_, i) => !kept.has(String(i))).map((c) => c.key),
    ]);
    await write("clues.refined", { titles: nextTitles, excluded: [...nextExcluded] });
    setTitles(nextTitles);
    setExcluded(nextExcluded);
    setMsg(`助手从 ${batch.length} 条预筛线索中提炼出 ${claims.length} 条，已缓存并尚待采纳。`);
  }
  async function deepScan() {
    const picked = deepSources.filter((m) => deepPicked.includes(m.id)).slice(0, 3);
    if (!picked.length) throw Error("请先勾选 1–3 篇近期日志或笔记。");
    const claims = await generate("harvest", picked);
    if (lastScopeKey.current !== scopeKey) return;
    const extracted: Clue[] = [];
    for (const claim of claims) {
      const source = picked.find((m) => m.id === claim.source);
      if (!source) continue;
      const key = JSON.stringify([source.id, claim.quote]);
      extracted.push({
        key,
        title: claim.text,
        material: { ...source, originId: source.id, id: key, text: claim.quote },
      });
    }
    setDeepClues((prev) => [...new Map([...extracted, ...prev].map((c) => [c.key, c])).values()]);
    setDeepOpen(false);
    setMsg(
      extracted.length
        ? `深度扫描从 ${picked.length} 篇材料中提取出 ${extracted.length} 条隐式行动线索。`
        : "所选材料未发现额外待办线索。",
    );
  }
  return (
    <section className="aw-harvester">
      <button className="aw-capture-toggle" aria-expanded={opened} onClick={() => setOpen(!opened)}>
        <strong>
          <Sparkles size={14} aria-hidden="true" />
          <span>
            行动捕手 · {clues.length} 条新线索{matchCount > 0 && <>（{matchCount} 条可关联已有任务）</>}
          </span>
        </strong>
        <small>{opened ? "收起 ▴" : "展开处理 ▾"}</small>
      </button>
      {readError && <p role="alert">笔记线索读取失败 · {readError}</p>}
      {opened && (
        <>
          {clues.length >= 12 && !excluded.size && (
            <p className="aw-harvester-hint">
              当前为本地规则预筛（{clues.length} 条，可能含规范说明句），可点「用助手提炼线索」由 AI 过滤降噪。
            </p>
          )}
          {writable.length > 1 && (
            <div className="aw-clue-footer">
              <select
                aria-label="新任务的滴答资料库"
                value={destination}
                onChange={(e) => {
                  setTarget(e.target.value);
                  setAdoptProject("");
                }}
              >
                <option value="">选择滴答资料库</option>
                {writable.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </select>
            </div>
          )}
          {deepOpen && (
            <div className="aw-deep-scan">
              <small>勾选 1–3 篇近期日志或笔记，直接用模型提取无 TODO 关键词的隐式行动：</small>
              {deepSources.map((source) => (
                <label className="aw-step" key={source.id}>
                  <input
                    type="checkbox"
                    checked={deepPicked.includes(source.id)}
                    onChange={(e) =>
                      setDeepPicked((prev) =>
                        e.target.checked
                          ? prev.length < 3
                            ? [...prev, source.id]
                            : prev
                          : prev.filter((id) => id !== source.id),
                      )
                    }
                  />
                  <span>
                    {source.title} {source.date ? `· ${source.date}` : ""}
                  </span>
                </label>
              ))}
              <div className="aw-tools">
                <button disabled={!!busy || !deepPicked.length} onClick={() => void run("deep-scan", deepScan)}>
                  开始深度提取
                </button>
                <button onClick={() => setDeepOpen(false)}>取消</button>
              </div>
            </div>
          )}
          <div className="aw-clue-list">
            {clues.slice(0, limit).map((c) => {
              const actionStatus = messageKey === c.key && (busy || msg) && (
                <p role="status">{busy ? "正在处理…" : msg}</p>
              );
              const matches = possibleMatches.get(c.key) || [],
                selected = tasks.find(
                  (t) => identity(t) === (choices[c.key] ?? (matches.length === 1 ? identity(matches[0]) : "")),
                );
              const saved = decisions[c.key];
              const pending = saved?.requestId;
              const choosing = picker === c.key;
              const collection = selected?.collectionName || selected?.documentTitle;
              const togglePicker = () => {
                setPicker(choosing ? "" : c.key);
                setMatchSearch("");
              };
              if (saved?.state === "linking") {
                const linked = tasks.find((t) => identity(t) === saved.taskKey);
                return (
                  <article key={c.key}>
                    <strong>{c.title}</strong>
                    <p>已关联本地备料，滴答备注待核对。</p>
                    {linked && (
                      <button disabled={!!busy} onClick={() => void run(c.key, () => link(linked, c))}>
                        继续核对并追加到原任务
                      </button>
                    )}
                    <button
                      disabled={!!busy}
                      onClick={() =>
                        void run(c.key, () => decide(c.key, { state: "linked", taskKey: saved.taskKey }))
                      }
                    >
                      仅保留本地关联
                    </button>
                    {actionStatus}
                  </article>
                );
              }
              if (pending) {
                const syncedMatches = tasks.filter(
                  (task) =>
                    task.libraryId === saved.libraryId &&
                    (saved.sourceId
                      ? task.sourceId === saved.sourceId
                      : task.title === saved.title && (!saved.projectId || task.collectionId === saved.projectId)),
                );
                return (
                  <article key={c.key}>
                    <strong>{saved.title}</strong>
                    <p>滴答采纳待确认。核对时会沿用原请求。</p>
                    <button disabled={!!busy} onClick={() => void run(c.key, () => create(c, "backlog"))}>
                      核对采纳回执
                    </button>
                    {syncedMatches.map((task) => (
                      <button
                        key={identity(task)}
                        disabled={!!busy}
                        onClick={() => void run(c.key, () => attach(task, c, saved.day || false, saved.wait))}
                      >
                        采用已同步的任务 · {task.collectionName || task.documentTitle} · {task.sourceId}
                      </button>
                    ))}
                    {actionStatus}
                  </article>
                );
              }
              return (
                <article key={c.key}>
                  <textarea
                    className="aw-clue-title"
                    aria-label="候选行动标题"
                    rows={1}
                    maxLength={500}
                    value={edits[c.key] ?? titles[c.key] ?? c.title}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") e.preventDefault();
                    }}
                    onChange={(e) => {
                      const value = e.target.value.replace(/\r?\n/g, " ");
                      setEdits((v) => ({ ...v, [c.key]: value }));
                    }}
                  />
                  <div className="aw-clue-meta">
                    <Materials items={[c.material]} journals={journals} onOpen={onOpen} appearance="clue" />
                    {collection && (
                      <span>
                        归属：<b>{collection}</b>
                      </span>
                    )}
                  </div>
                  <blockquote className="aw-clue-quote">{c.material.text}</blockquote>
                  {selected ? (
                    <button type="button" className="aw-match" aria-expanded={choosing} onClick={togglePicker}>
                      <Link2 size={14} aria-hidden="true" />
                      <span title={selected.title}>
                        匹配已有任务：<strong>{selected.title}</strong>
                      </span>
                    </button>
                  ) : matches.length > 1 ? (
                    <button type="button" className="aw-match" aria-expanded={choosing} onClick={togglePicker}>
                      <Link2 size={14} aria-hidden="true" />
                      <span>发现 {matches.length} 项相似任务，请选择要关联的任务。</span>
                    </button>
                  ) : null}
                  {choosing && (
                    <div className="aw-clue-picker">
                      <input
                        aria-label="筛选可关联任务"
                        placeholder="按标题查找可关联的任务"
                        value={matchSearch}
                        onChange={(e) => setMatchSearch(e.target.value)}
                      />
                      <select
                        aria-label="关联已有任务"
                        value={selected ? identity(selected) : ""}
                        onChange={(e) => {
                          const value = e.target.value;
                          setChoices((v) => ({ ...v, [c.key]: value }));
                          setPicker("");
                        }}
                      >
                        <option value="">选择已有任务</option>
                        {[
                          ...matches,
                          ...tasks
                            .filter(
                              (t) =>
                                t.status === "open" &&
                                !matches.includes(t) &&
                                (!normalizedMatchSearch ||
                                  (t.title + " " + (t.collectionName || t.documentTitle || ""))
                                    .toLowerCase()
                                    .includes(normalizedMatchSearch)),
                            )
                            .slice(0, 40),
                        ].map((t) => (
                          <option key={identity(t)} value={identity(t)}>
                            {t.title} · {t.collectionName || t.documentTitle} · {t.libraryName}
                            {(duplicateTaskGroups.get(
                              JSON.stringify([t.libraryId, t.collectionId || t.documentTitle, t.title]),
                            ) || 0) > 1
                              ? " · " + t.sourceId.slice(-6)
                              : ""}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}
                  <div className="aw-clue-actions aw-clue-bar">
                    <div className="aw-clue-actions-left aw-clue-primary-group">
                      {selected && (
                        <button
                          className="aw-primary"
                          disabled={!!busy}
                          onClick={() => void run(c.key, () => link(selected, c))}
                        >
                          <Link2 size={13} aria-hidden="true" /> 关联并补充至已有任务
                        </button>
                      )}
                      <button
                        className={!matches.length && !selected ? "aw-primary" : "aw-clue-pill"}
                        aria-expanded={panelKey === c.key && panelMode === "backlog"}
                        disabled={!!busy || !destination}
                        onClick={() => openAdoption(c, "backlog", true)}
                      >
                        {matches.length || selected ? "仍新建待办" : "＋ 采纳到待办"}
                      </button>
                      <button
                        className="aw-clue-pill"
                        aria-expanded={panelKey === c.key && panelMode === "today"}
                        disabled={!!busy || !destination || planFull}
                        title={planFull ? "今日计划已满" : undefined}
                        onClick={() => openAdoption(c, "today", true)}
                      >
                        采纳并排入今天
                      </button>
                      <button
                        className="aw-clue-pill"
                        aria-expanded={panelKey === c.key && panelMode === "wait"}
                        disabled={!!busy || !destination}
                        onClick={() => openAdoption(c, "wait", true)}
                      >
                        <Hourglass size={13} aria-hidden="true" /> 设为等待
                      </button>
                    </div>
                    <div className="aw-clue-secondary-group">
                      {!matches.length && !selected && (
                        <button
                          className="aw-clue-dismiss"
                          type="button"
                          aria-label="关联已有任务"
                          title="关联已有任务"
                          aria-expanded={choosing}
                          onClick={togglePicker}
                        >
                          <Link2 size={13} aria-hidden="true" />
                        </button>
                      )}
                      <button
                        className="aw-clue-ghost"
                        disabled={!!busy}
                        onClick={() => void run(c.key, () => decide(c.key, { state: "ignored" }))}
                      >
                        忽略
                      </button>
                    </div>
                  </div>
                  {panelKey === c.key && (
                    <form
                      className="aw-form aw-clue-drawer"
                      onSubmit={(e) => {
                        e.preventDefault();
                        if (panelMode === "wait" && (!who.trim() || !what.trim())) return;
                        void run(c.key, () =>
                          create(c, panelMode, { projectId: adoptProject || undefined, priority: adoptPriority }),
                        );
                      }}
                    >
                      <div className="aw-clue-drawer-tabs" role="group" aria-label="采纳去向">
                        <button
                          type="button"
                          aria-pressed={panelMode === "backlog"}
                          onClick={() => openAdoption(c, "backlog")}
                        >
                          采纳到待办
                        </button>
                        <button
                          type="button"
                          disabled={planFull}
                          aria-pressed={panelMode === "today"}
                          onClick={() => openAdoption(c, "today")}
                        >
                          排入今天{planFull ? "（已满）" : ""}
                        </button>
                        <button
                          type="button"
                          aria-pressed={panelMode === "wait"}
                          onClick={() => openAdoption(c, "wait")}
                        >
                          设为等待
                        </button>
                      </div>
                      <div className="aw-clue-drawer-grid">
                        <label>
                          目标清单
                          <select
                            aria-label="目标清单"
                            value={adoptProject}
                            onChange={(e) => setAdoptProject(e.target.value)}
                          >
                            <option value="">收件箱（默认）</option>
                            {projectOptions.map(([id, name]) => (
                              <option key={id} value={id}>
                                {name}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label>
                          优先级
                          <select
                            aria-label="优先级"
                            value={String(adoptPriority)}
                            onChange={(e) => setAdoptPriority(e.target.value === "5" ? 5 : 0)}
                          >
                            <option value="0">普通</option>
                            <option value="5">高优（!高）</option>
                          </select>
                        </label>
                        {panelMode === "wait" && (
                          <>
                            <label>
                              等谁
                              <input required value={who} onChange={(e) => setWho(e.target.value)} />
                            </label>
                            <label>
                              等什么交付
                              <input required value={what} onChange={(e) => setWhat(e.target.value)} />
                            </label>
                            <label>
                              回看日
                              <input required type="date" value={review} onChange={(e) => setReview(e.target.value)} />
                            </label>
                            <div className="aw-clue-quick-dates">
                              <span>快捷回看</span>
                              <div className="aw-tools">
                                <button type="button" className="aw-snooze" onClick={() => setReview(shiftDay(day, 1))}>
                                  明天
                                </button>
                                <button type="button" className="aw-snooze" onClick={() => setReview(shiftDay(day, 3))}>
                                  +3天
                                </button>
                                <button type="button" className="aw-snooze" onClick={() => setReview(nextMonday(day))}>
                                  下周一
                                </button>
                              </div>
                            </div>
                          </>
                        )}
                      </div>
                      <div className="aw-clue-drawer-foot">
                        {panelMode === "wait" ? (
                          <label>
                            <input
                              type="checkbox"
                              checked={blocking}
                              onChange={(e) => setBlocking(e.target.checked)}
                            />
                            阻塞下一步
                          </label>
                        ) : (
                          <small>
                            {panelMode === "today" ? "确认后写入滴答并排入今日计划" : "确认后写入滴答待办并保留原句来源"}
                          </small>
                        )}
                        <div className="aw-tools">
                          <button type="button" disabled={!!busy} onClick={() => setPanelKey("")}>
                            取消
                          </button>
                          <button className="aw-primary" disabled={!!busy || !destination || (panelMode === "today" && planFull)}>
                            {panelMode === "today"
                              ? "确认采纳并排入今天"
                              : panelMode === "wait"
                                ? "确认采纳并保存等待"
                                : "确认采纳到待办"}
                          </button>
                        </div>
                      </div>
                    </form>
                  )}
                  {actionStatus}
                </article>
              );
            })}
          </div>
          <div className="aw-clue-footer">
            {limit < clues.length && (
              <button onClick={() => setLimit(limit + CLUES_PER_PAGE)}>查看更多线索</button>
            )}
            <button disabled={!!busy || !clues.length} onClick={() => void run("model", refine)}>
              用助手提炼线索
            </button>
            {!!excluded.size && (
              <button
                onClick={() => {
                  setExcluded(new Set());
                  setTitles({});
                  void write("clues.refined", { titles: {}, excluded: [] });
                }}
              >
                查看本地预筛全部线索
              </button>
            )}
            {deepSources.length > 0 && (
              <button disabled={!!busy} onClick={() => setDeepOpen((v) => !v)}>
                指定近期文档深度扫描
              </button>
            )}
          </div>
        </>
      )}
      {(msg || busy) && (!opened || !clues.slice(0, limit).some((clue) => clue.key === messageKey)) && (
        <p role="status">{busy ? "正在处理…" : msg}</p>
      )}
    </section>
  );
}
