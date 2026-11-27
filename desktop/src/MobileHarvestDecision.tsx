import { useRef, useState } from "react";
import type { Clue } from "./ActionEvidence";
import { mobileTasks, saveMobileTask, type LocalTask } from "./MobileInsightTasks";
import { flushUserProfileStorage } from "./UserProfileStorage";

export type HarvestEntry = {
  key: string;
  at?: number;
  mode: "new" | "append";
  quote: string;
  source: string;
  note: string;
  list: string;
};

export function localHarvestReceipts(tasks: LocalTask[]) {
  return tasks.flatMap(task => (task.harvestEntries ?? []).map(entry => ({ task, entry })));
}

type Props = {
  clue?: Clue;
  receipt?: ReturnType<typeof localHarvestReceipts>[number];
  onSaved: () => void;
  onOpen: (id: string) => void;
};

export function MobileHarvestDecision({ clue, receipt, onSaved, onOpen }: Props) {
  const tasks = mobileTasks();
  const [mode, setMode] = useState<HarvestEntry["mode"]>("new");
  const [title, setTitle] = useState(clue?.title ?? "");
  const [list, setList] = useState("本机任务");
  const [target, setTarget] = useState("");
  const [note, setNote] = useState(clue?.title ?? "");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const lock = useRef(false);
  const current = tasks.find(task => task.id === target);
  const lists = new Set(["本机任务", ...tasks.map(task => task.list).filter((name): name is string => !!name)]);
  const append = mode === "append";

  if (receipt) {
    const { task, entry } = receipt;
    return <section className="bw-harvest-receipt" aria-label="采纳回执" aria-live="polite">
      <small>已保存到本机{entry.at && " · " + new Date(entry.at).toLocaleString("zh-CN")}</small>
      <h2>{entry.mode === "append" ? "已补充已有任务" : "已新建任务"}</h2>
      <dl><dt>对应任务</dt><dd>{task.title}</dd><dt>目标清单</dt><dd>{entry.list}</dd></dl>
      {entry.note && <p>已追加备注 · {entry.note}</p>}
      <blockquote>{entry.quote}<cite>{entry.source}</cite></blockquote>
      <button type="button" onClick={() => onOpen(task.id)}>打开对应任务</button>
    </section>;
  }
  if (!clue) return null;

  async function confirm(candidate: Clue) {
    if (lock.current) return;
    lock.current = true;
    setSaving(true);
    setError("");
    try {
      const latest = mobileTasks();
      if (localHarvestReceipts(latest).some(({ entry }) => entry.key === candidate.key)) {
        // A failed write stays in the profile cache until its transaction is retried.
        await flushUserProfileStorage();
      } else {
        const existing = latest.find(task => task.id === target);
        if (append && !existing) throw Error("请重新选择已有任务");
        const savedList = append ? existing?.list || "本机任务" : list.trim();
        if (!savedList || !(append ? note : title).trim()) throw Error("请填写任务和目标清单");
        const task: LocalTask = append && existing ? existing : {
          id: crypto.randomUUID(), title: title.trim(), list: savedList, note: "",
          source: "行动捕手", created: Date.now(), done: false,
        };
        const entry: HarvestEntry = {
          key: candidate.key, at: Date.now(), mode, source: candidate.material.title,
          quote: candidate.material.text, note: append ? note.trim() : "", list: savedList,
        };
        await saveMobileTask({ ...task, harvestEntries: [...(task.harvestEntries ?? []), entry] });
      }
      onSaved();
    } catch (reason) {
      setError(String(reason));
    } finally {
      lock.current = false;
      setSaving(false);
    }
  }

  return <form className="bw-harvest-decision" onSubmit={event => { event.preventDefault(); void confirm(clue); }}>
    <h2>{clue.title}</h2>
    <blockquote>{clue.material.text}<cite>原句 · {clue.material.title}</cite></blockquote>
    <div className="bw-tabs" role="group" aria-label="采纳方式">
      <button type="button" aria-pressed={!append} onClick={() => setMode("new")}>新建任务</button>
      <button type="button" aria-pressed={append} onClick={() => setMode("append")}>补充已有任务</button>
    </div>
    {append ? <>
      <label>对应任务<select required value={target} onChange={event => setTarget(event.target.value)}>
        <option value="">请选择已有任务</option>
        {tasks.map(task => <option key={task.id} value={task.id}>{task.done && "已完成 · "}{task.title} · {task.list || "本机任务"}</option>)}
      </select></label>
      <label>补充备注<textarea required rows={2} value={note} onChange={event => setNote(event.target.value)}/></label>
      <p>目标清单 · {current ? current.list || "本机任务" : "选择任务后显示"}</p>
    </> : <>
      <label>任务名称<input required value={title} onChange={event => setTitle(event.target.value)}/></label>
      <label>目标清单<select required value={list} onChange={event => setList(event.target.value)}>
        {Array.from(lists, name => <option key={name}>{name}</option>)}
      </select></label>
    </>}
    {error && <p role="alert">{error}</p>}
    <button type="submit" disabled={saving || (append ? !current || !note.trim() : !title.trim() || !list.trim())}>
      {append ? "确认清单并补充" : "确认清单并新建"}
    </button>
    <small>采纳结果保存在本机</small>
  </form>;
}
