import { createPortal } from "react-dom";
import { todayKey } from "./ActionEvidence";
import { useEffect, useRef, useState } from "react";
import { flushUserProfileStorage } from "./UserProfileStorage";
import { read, write } from "./ActionState";
import { useInsights } from "./useInsights";
import type { Insight } from "./InsightTypes";

import type { HarvestEntry } from "./MobileHarvestDecision";

export type LocalTask = {
  harvestEntries?: HarvestEntry[];
  progressNotes?: string[];
  noteDraft?: string;
  list?: string;
  plannedDay?: string;
  waiting?: { who: string; date: string };
  id: string;
  title: string;
  note: string;
  created: number;
  done: boolean;
  source: string;
};
const taskKey = "mobile.local-tasks";
export function mobileTasks(): LocalTask[] {
  return read<LocalTask[]>(taskKey, []);
}
export async function saveMobileTask(task: LocalTask) {
  const rows = mobileTasks();
  await write(taskKey, [task, ...rows.filter((row) => row.id !== task.id)]);
}
export function MobileLocalTaskDetail({
  task,
  back,
  onChange,
}: {
  task: LocalTask;
  back: () => void;
  onChange: () => void;
}) {
  const [error, setError] = useState(""),
    [edit, setEdit] = useState(false);
  const today = todayKey(),
    [who, setWho] = useState(task.waiting?.who || ""),
    [date, setDate] = useState(task.waiting?.date || "");
  const header = document.querySelector(".mobile-hub-header");
  const subhead = <div className="bw-task-subhead"><button type="button" aria-label="返回" onClick={back}>‹ 返回</button><strong>任务详情</strong></div>;
  const [draft, setDraft] = useState(task.noteDraft ?? "");
  const latest = () => mobileTasks().find(row => row.id === task.id) ?? task;
  const evidence = (mode: HarvestEntry["mode"]) => task.harvestEntries?.filter(entry => entry.mode === mode).map(entry =>
    <section key={entry.key}>{entry.note && <p>{entry.note}</p>}
      <blockquote>{entry.quote}<cite>行动捕手 · {entry.source}</cite></blockquote>
    </section>);
  async function update(patch: Partial<LocalTask>) {
    try {
      await saveMobileTask({ ...latest(), ...patch });
      setError("");
      setEdit(false);
      onChange();
    } catch (e) {
      setError(String(e));
    }
  }
  return (
    <section className="bw-local-detail">
      {header ? createPortal(subhead, header) : subhead}
      <h2>{task.title}</h2>
      <small>{task.list || "本机任务"} · 普通 · 无截止日</small>
      <div className="bw-buttons">
        <button onClick={() => void update({ done: !task.done })}>
          {task.done ? "恢复待办" : "标记完成"}
        </button>
        <button
          disabled={task.done}
          onClick={() =>
            void update({ plannedDay: task.plannedDay === today ? "" : today })
          }
        >
          {task.plannedDay === today ? "移出今日计划" : "加入今日计划"}
        </button>
      </div>
      <h3>来源与依据</h3>
      <p>{task.source}</p>
      {task.note && <blockquote>{task.note}</blockquote>}
      {evidence("new")}
      <h3>等待跟进</h3>
      <p>
        {task.waiting
          ? [task.waiting.who, task.waiting.date || "未定回看日"].join(" · ")
          : "当前无需等待"}
      </p>
      <div className="bw-buttons">
        <button onClick={() => setEdit(true)}>
          {task.waiting ? "修改等待" : "设置等待"}
        </button>
        {task.waiting && (
          <button onClick={() => void update({ waiting: undefined })}>
            结束等待
          </button>
        )}
      </div>
      {edit && (
        <form
          className="bw-compose"
          onSubmit={(e) => {
            e.preventDefault();
            if (who.trim()) void update({ waiting: { who: who.trim(), date } });
          }}
        >
          <label>
            等待对象
            <input
              autoFocus
              required
              value={who}
              onChange={(e) => setWho(e.target.value)}
            />
          </label>
          <label>
            回看日期
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          </label>
          <button type="button" onClick={() => setEdit(false)}>
            取消
          </button>
          <button>保存等待</button>
        </form>
      )}
      <h3>续办备注</h3>
      {task.progressNotes?.map((text, index) => <p key={index}>{text}</p>)}
      {evidence("append")}
      <form className="bw-task-progress" onSubmit={async event => {
        event.preventDefault();
        const current = latest();
        const note = current.noteDraft?.trim();
        if (!draft.trim()) return;
        try {
          if (note) {
            await saveMobileTask({ ...current, progressNotes: [...(current.progressNotes ?? []), note], noteDraft: "" });
          } else {
            await flushUserProfileStorage();
          }
          setDraft(latest().noteDraft ?? ""); setError(""); onChange();
        } catch (reason) { setError(String(reason)); }
      }}>
        <label>补充进展<textarea rows={2} placeholder="下次接着做什么？" value={draft} onChange={event => {
          const value = event.target.value;
          setDraft(value);
          void saveMobileTask({ ...latest(), noteDraft: value }).catch(reason => setError(String(reason)));
        }}/></label>
        <button type="submit" disabled={!draft.trim()}>保存备注</button>
      </form>
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
export function MobileTaskForm({
  initialList = "本机任务", origin,
  onSave,
  onCancel,
}: {
  initialList?: string;
  origin?: Pick<LocalTask,"id"|"title"|"source"|"note">;
  onSave: (task: LocalTask) => void;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState(origin ? "跟进《"+origin.title+"》" : ""),
    [list, setList] = useState(initialList || "本机任务"),
    [planned, setPlanned] = useState(true),
    [error, setError] = useState("");
  const request = useRef(crypto.randomUUID()),
    dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const el = dialog.current;
    el?.showModal();
    return () => el?.close();
  }, []);
  return (
    <dialog
      ref={dialog}
      aria-label={origin ? "从原文创建任务" : "新建本机任务"}
      className="bw-task-sheet"
      onCancel={(e) => {
        e.preventDefault();
        onCancel();
      }}
    >
      <form
        className="bw-compose"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!title.trim() || !list.trim()) return;
          const task = {
            id: origin?.id || request.current,
            title: title.trim(),
            note: origin?.note || "",
            list: list.trim(),
            plannedDay: planned ? todayKey() : "",
            source: origin?.source || "本机新建",
            created: Date.now(),
            done: false,
          };
          try {
            await saveMobileTask(task);
            onSave(task);
          } catch (reason) {
            setError(String(reason));
          }
        }}
      >
        <h3 tabIndex={-1} autoFocus>{origin ? "从原文创建任务" : "新建本机任务"}</h3>
        {origin && <p>来源 · {origin.title}</p>}
        <label>
          任务名称
          <input
            required
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </label>
        <label>
          保存到清单
          <input
            required
            value={list}
            onChange={(e) => setList(e.target.value)}
          />
        </label>
        <label>
          <input
            type="checkbox"
            checked={planned}
            onChange={(e) => setPlanned(e.target.checked)}
          />
          加入今日计划
        </label>
        <div className="bw-buttons">
          <button type="button" onClick={onCancel}>
            取消
          </button>
          <button disabled={!title.trim() || !list.trim()}>创建任务</button>
        </div>
        {error && <p role="alert">{error}</p>}
      </form>
    </dialog>
  );
}
export function MobileInsightList({
  openTask,
  advanced,
}: {
  openTask: (id: string) => void;
  advanced: () => void;
}) {
  const data = useInsights();
  const [later, setLater] = useState(() =>
      Boolean(window.history.state?.hubInsightsLater),
    ),
    [editing, setEditing] = useState<Insight | null>(null),
    [at, setAt] = useState("");
  const [error, setError] = useState(""),
    [posting, setPosting] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const closeSnooze = () => {
    if (window.history.state?.hubMobileSnooze) window.history.back();
    else setEditing(null);
  };
  useEffect(() => {
    if (!editing) return;
    const el = dialog.current;
    el?.showModal();
    window.history.pushState(
      { ...window.history.state, hubMobileSnooze: true },
      "",
    );
    const back = (event: PopStateEvent) => {
      event.stopImmediatePropagation();
      setEditing(null);
    };
    window.addEventListener("popstate", back, true);
    return () => {
      el?.close();
      window.removeEventListener("popstate", back, true);
    };
  }, [editing]);
  const laterItems = data.items.filter((i) => i.processingState === "later");
  const dates = laterItems
    .map((i) => i.snoozeUntil || 0)
    .filter((t) => t > Date.now());
  const next = dates.length ? Math.min(...dates) : 0;
  useEffect(() => {
    if (!next) return;
    const timer = setTimeout(
      () => void data.refresh(),
      Math.min(2147483647, Math.max(1, next - Date.now() + 50)),
    );
    return () => clearTimeout(timer);
  }, [next, data.refresh]);
  function choose(hours: number) {
    const d = new Date(Date.now() + hours * 3600000);
    setAt(
      new Date(d.getTime() - d.getTimezoneOffset() * 60000)
        .toISOString()
        .slice(0, 16),
    );
  }
  async function convert(item: Insight) {
    const id = "insight:" + item.id;
    if (posting) return;
    setPosting(true);
    setError("");
    try {
      if (!mobileTasks().some((task) => task.id === id)) {
        if (!item.snapshot || item.validity === "unavailable")
          throw Error("当前发现正文不可用");
        await saveMobileTask({
          id,
          title: item.workTitle || item.snapshot.text.split("\n")[0],
          note: item.snapshot.text,
          created: Date.now(),
          done: false,
          source: "洞察转化",
        });
      }
      await flushUserProfileStorage();
      openTask(id);
    } catch (e) {
      setError(String(e));
    } finally {
      setPosting(false);
    }
  }
  return (
    <section className="bw-insights">
      <nav className="bw-tabs">
        {[false, true].map((v) => (
          <button
            key={String(v)}
            aria-pressed={later === v}
            onClick={() => {
              window.history.replaceState(
                { ...window.history.state, hubInsightsLater: v },
                "",
              );
              setLater(v);
            }}
          >
            {v ? "稍后再看" : "待关注"} (
            {v
              ? laterItems.length
              : data.items.filter((i) => i.processingState === "attention")
                  .length}
            )
          </button>
        ))}
        <button onClick={advanced}>更多洞察</button>
      </nav>
      {(error || data.error) && <p role="alert">{error || data.error}</p>}
      {data.items
        .filter((i) => i.processingState === (later ? "later" : "attention"))
        .map((item) => (
          <article className="bw-insight" key={item.id}>
            <small>✦ 洞察发现</small>
            <h3>{item.workTitle || "洞察"}</h3>
            <p>{item.snapshot?.text}</p>
            {later && item.snoozeUntil && (
              <small>
                回看时间 · {new Date(item.snoozeUntil).toLocaleString()}
              </small>
            )}
            {item.snapshot?.sourceCitations.map((s) => (
              <details key={s.evidenceId}>
                <summary>{s.excerpt.title || "原文依据"}</summary>
                {s.quote || s.excerpt.content}
              </details>
            ))}
            <div className="bw-buttons">
              <button
                onClick={() => {
                  setEditing(item);
                  choose(2);
                }}
              >
                {later ? "修改回看时间" : "稍后再看"}
              </button>
              {later && (
                <button
                  disabled={data.busy}
                  onClick={() =>
                    void data
                      .change(item, "insightStatus", { state: "attention" })
                      .catch(() => {})
                  }
                >
                  移回待关注
                </button>
              )}
              <button
                disabled={posting || !item.snapshot}
                onClick={() => void convert(item)}
              >
                {mobileTasks().some((t) => t.id === "insight:" + item.id)
                  ? "打开关联任务"
                  : "转为任务并打开"}
              </button>
            </div>
          </article>
        ))}
      {data.loading && <p>正在读取洞察…</p>}
      {!data.loading &&
        !data.items.some(
          (i) => i.processingState === (later ? "later" : "attention"),
        ) && <p>{later ? "暂无稍后再看的洞察" : data.items.length ? "暂无待关注的洞察" : "本机暂无洞察。可在「更多洞察」中选择已接入的资料，开始发现。"}</p>}
      {data.more && (
        <button onClick={() => void data.refresh(true)}>加载更多</button>
      )}
      {editing && (
        <dialog
          ref={dialog}
          className="bw-snooze"
          aria-label="稍后再看"
          onCancel={(e) => {
            e.preventDefault();
            closeSnooze();
          }}
        >
          <h3>稍后再看</h3>
          <div className="bw-buttons">
            {[
              [2, "两小时后"],
              [24, "明天此时"],
              [168, "一周后"],
            ].map(([h, n]) => (
              <button key={h} onClick={() => choose(Number(h))}>
                {n}
              </button>
            ))}
          </div>
          <label>
            回看时间
            <input
              type="datetime-local"
              value={at}
              onChange={(e) => setAt(e.target.value)}
            />
          </label>
          <div className="bw-buttons">
            <button onClick={closeSnooze}>取消</button>
            <button
              disabled={data.busy || !(Date.parse(at) > Date.now())}
              onClick={() =>
                void data
                  .change(editing, "insightStatus", {
                    state: "later",
                    snoozeUntil: Date.parse(at),
                  })
                  .then(closeSnooze)
                  .catch(() => {})
              }
            >
              确认回看时间
            </button>
          </div>
        </dialog>
      )}
    </section>
  );
}

export function MobileTaskFilter({ source, list, options, onApply, onSources }: {
  source: string;
  list: string;
  options: {source: string; list: string}[];
  onApply: (source: string, list: string) => void;
  onSources: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [draftSource, setSource] = useState(source);
  const [draftList, setList] = useState(list);
  const sources = [...new Set(options.map(o => o.source))];
  const lists = [...new Set(options.filter(o => !draftSource || o.source === draftSource).map(o => o.list))];
  return <>
    <button type="button" aria-haspopup="dialog" onClick={() => {
      setSource(source); setList(list); dialog.current?.showModal();
    }}>{[source, list].filter(Boolean).join(" · ") || "全部来源与清单"} ▾</button>
    <dialog ref={dialog} className="bw-task-sheet" aria-label="筛选任务">
      <form method="dialog" className="bw-filter-form" onSubmit={() => onApply(draftSource, draftList)}>
        <header><h2>筛选任务</h2><button type="button" onClick={() => {dialog.current?.close(); onSources();}}>查看来源任务</button><button type="button" onClick={() => dialog.current?.close()}>取消</button></header>
        <label>来源<select value={draftSource} onChange={event => {setSource(event.target.value); setList("");}}>
          <option value="">全部来源</option>{sources.map(s => <option key={s}>{s}</option>)}
        </select></label>
        <label>项目与清单<select value={draftList} onChange={e => setList(e.target.value)}>
          <option value="">全部清单</option>{lists.map(l => <option key={l}>{l}</option>)}
        </select></label>
        <button type="submit">应用筛选</button>
      </form>
    </dialog>
  </>;
}
