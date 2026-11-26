import { useEffect, useMemo, useRef, useState } from "react";
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
  todayKey,
  type Clue,
} from "./ActionEvidence";
import { read, write, identity, type ActionMeta, type Decision, type Wait } from "./ActionState";
import { Materials } from "./ActionMaterials";
import { sourceNoteStatus, type TaskNoteAction } from "./TaskPlanningSource";

type DecisionMap = Record<string, Decision>;
type Receipt = { state: string; task?: UnifiedTask; error?: string; sourceId?: string };
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
    [waiting, setWaiting] = useState(""),
    [who, setWho] = useState(""),
    [what, setWhat] = useState(""),
    [review, setReview] = useState(day),
    [blocking, setBlocking] = useState(false);
  const [limit, setLimit] = useState(12),
    [matchSearch, setMatchSearch] = useState("");
  const [choices, setChoices] = useState<Record<string, string>>({}),
    [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [titles, setTitles] = useState<Record<string, string>>({});
  const lock = useRef(false);
  const scopeKey = JSON.stringify(scope);
  useEffect(() => {
    let live = true;
    setDocs([]);
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
          (["creating", "unknown"].includes(d.state) && d.libraryId && (!scope || scope.includes(d.libraryId)))),
    )
    .map((d) => d.clue!);
  const clues = [...new Map([...retryClues, ...candidates].map((c) => [c.key, c])).values()].filter(
    (c) => !excluded.has(c.key) && !["linked", "ignored"].includes(decisions[c.key]?.state),
  );
  useEffect(() => {
    onCount?.(clues.length);
  }, [clues.length, onCount]);
  const possibleMatches = useMemo(
    () => new Map(clues.map((c) => [c.key, matchExisting(c, tasks)])),
    [candidates, decisions, tasks, excluded],
  );
  const matchCount = [...possibleMatches.values()].filter((matches) => matches.length).length;
  const writable = libraries.filter((l) => l.provider === "dida365" && (!scope || scope.includes(l.id)));
  const destination = writable.some((l) => l.id === target) ? target : writable.length === 1 ? writable[0].id : "";
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
  async function create(c: Clue, kind: "backlog" | "today" | "wait") {
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
      day: old?.requestId ? old.day : kind === "today" ? day : undefined,
      wait: old?.requestId
        ? old.wait
        : kind === "wait"
          ? { id: requestId, who: who.trim(), what: what.trim(), review, blocking }
          : undefined,
    };
    await decide(c.key, { ...intent, state: "creating" });
    const receipt = await native<Receipt>("createTask", { requestId, libraryId: lib, title, priority: 0 });
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
    setWaiting("");
    setMsg(receipt.error || "滴答已回读确认，来源已保留。");
  }
  async function refine() {
    const batch = clues.slice(0, 32);
    const materials = batch.map((c, i) => ({ ...c.material, id: String(i) }));
    const claims = await generate("harvest", materials);
    const kept = new Set(claims.map((c) => c.source));
    setTitles(Object.fromEntries(claims.map((c) => [batch[Number(c.source)].key, c.text])));
    setExcluded(new Set(batch.filter((_, i) => !kept.has(String(i))).map((c) => c.key)));
    setMsg(`助手从 ${batch.length} 条预筛线索中提炼出 ${claims.length} 条，尚待采纳。`);
  }
  return (
    <section className="aw-harvester">
      <button className="aw-capture-toggle" aria-expanded={opened} onClick={() => setOpen(!opened)}>
        <strong>
          ✦ 行动捕手 · {clues.length} 条新线索{matchCount > 0 && `（${matchCount} 条可关联已有任务）`}
        </strong>
        <small>{opened ? "收起 ▴" : "展开处理 ▾"}</small>
      </button>
      {readError && <p role="alert">笔记线索读取失败 · {readError}</p>}
      {opened && (
        <>
          <div className="aw-tools">
            <button disabled={!!busy || !clues.length} onClick={() => void run("model", refine)}>
              用助手提炼线索
            </button>
            {!!excluded.size && <button onClick={() => setExcluded(new Set())}>查看本地预筛全部线索</button>}
            {writable.length > 1 && (
              <select
                aria-label="新任务的滴答资料库"
                value={destination}
                onChange={(e) => setTarget(e.target.value)}
              >
                <option value="">选择滴答资料库</option>
                {writable.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </select>
            )}
          </div>
          <input
            aria-label="筛选可关联任务"
            placeholder="按标题查找可关联的任务"
            value={matchSearch}
            onChange={(e) => setMatchSearch(e.target.value)}
          />
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
                  (saved.sourceId ? task.sourceId === saved.sourceId : task.title === saved.title),
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
                <input
                  aria-label="候选行动标题"
                  maxLength={500}
                  value={edits[c.key] ?? titles[c.key] ?? c.title}
                  onChange={(e) => setEdits((v) => ({ ...v, [c.key]: e.target.value }))}
                />
                <Materials items={[c.material]} journals={journals} onOpen={onOpen} />
                <blockquote>{c.material.text}</blockquote>
                {selected ? (
                  <div className="aw-match">
                    🔗 匹配已有任务：<strong>{selected.title}</strong>
                    <small>
                      {" "}
                      · {selected.collectionName || selected.documentTitle} · {selected.libraryName}
                    </small>
                  </div>
                ) : matches.length > 1 ? (
                  <div className="aw-match">发现 {matches.length} 项相似任务，请选择要关联的任务。</div>
                ) : null}
                <div className="aw-tools">
                  <select
                    aria-label="关联已有任务"
                    value={selected ? identity(selected) : ""}
                    onChange={(e) => setChoices((v) => ({ ...v, [c.key]: e.target.value }))}
                  >
                    <option value="">选择已有任务</option>
                    {[
                      ...matches,
                      ...tasks
                        .filter(
                          (t) =>
                            t.status === "open" && !matches.includes(t) && t.title.includes(matchSearch.trim()),
                        )
                        .slice(0, 40),
                    ].map((t) => (
                      <option key={identity(t)} value={identity(t)}>
                        {t.title} · {t.collectionName || t.documentTitle} · {t.libraryName}
                        {tasks.some(
                          (other) =>
                            other.id !== t.id &&
                            other.title === t.title &&
                            other.libraryId === t.libraryId &&
                            (other.collectionId || other.documentTitle) === (t.collectionId || t.documentTitle),
                        )
                          ? " · " + t.sourceId.slice(-6)
                          : ""}
                      </option>
                    ))}
                  </select>
                  {selected && (
                    <button
                      className="aw-primary"
                      disabled={!!busy}
                      onClick={() => void run(c.key, () => link(selected, c))}
                    >
                      关联并补充至已有任务
                    </button>
                  )}
                </div>
                <div className="aw-tools">
                  <button
                    disabled={!!busy || !destination}
                    onClick={() => void run(c.key, () => create(c, "backlog"))}
                  >
                    {matches.length || selected ? "仍新建待办" : "＋ 采纳到待办"}
                  </button>
                  <button
                    disabled={!!busy || !destination || planFull}
                    title={planFull ? "今日计划已满" : undefined}
                    onClick={() => void run(c.key, () => create(c, "today"))}
                  >
                    采纳并排入今天
                  </button>
                  <button
                    disabled={!!busy || !destination}
                    onClick={() => {
                      setWaiting(c.key);
                      setWho("");
                      setWhat(edits[c.key] ?? titles[c.key] ?? c.title);
                      setReview(day);
                      setBlocking(false);
                    }}
                  >
                    设为等待
                  </button>
                  <button
                    disabled={!!busy}
                    onClick={() => void run(c.key, () => decide(c.key, { state: "ignored" }))}
                  >
                    忽略
                  </button>
                </div>
                {waiting === c.key && (
                  <form
                    className="aw-form"
                    onSubmit={(e) => {
                      e.preventDefault();
                      if (who.trim() && what.trim()) void run(c.key, () => create(c, "wait"));
                    }}
                  >
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
                    <label>
                      <input type="checkbox" checked={blocking} onChange={(e) => setBlocking(e.target.checked)} />
                      阻塞下一步
                    </label>
                    <button disabled={!!busy}>采纳并保存等待项</button>
                  </form>
                )}
                {actionStatus}
              </article>
            );
          })}
          {limit < clues.length && <button onClick={() => setLimit(limit + 12)}>查看更多线索</button>}
        </>
      )}
      {(msg || busy) && (!opened || !clues.slice(0, limit).some((clue) => clue.key === messageKey)) && (
        <p role="status">{busy ? "正在处理…" : msg}</p>
      )}
    </section>
  );
}
