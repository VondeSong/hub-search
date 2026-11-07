import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { AgentSleepDatasets, type SleepDatasetItem } from "./AgentSleepDatasets";

// The parent keys this view by Work, saved revision and authorization refresh.
export function AgentDatasetVersions({ item, workId, recordVersion, onCorrect }: {
  item: SleepDatasetItem; workId: string; recordVersion?: number; onCorrect?: (item: SleepDatasetItem, rowId: string) => void;
}) {
  const [revision, setRevision] = useState(item.revision), [older, setOlder] = useState<SleepDatasetItem | null>(null);
  const [loading, setLoading] = useState(false), [error, setError] = useState("");
  const sequence = useRef(0);
  useEffect(() => () => { sequence.current++; }, []);
  async function read(selected: number) {
    const ticket = ++sequence.current;
    setRevision(selected); setOlder(null); setError(""); setLoading(false);
    if (selected === item.revision) return;
    setLoading(true);
    try {
      const value = await invoke<SleepDatasetItem & { currentRevision: number }>("agent_investigation", { args: { action: "sleepDataset", id: workId, datasetId: item.datasetId, revision: selected } });
      if (ticket !== sequence.current) return;
      if (value.datasetId !== item.datasetId || value.revision !== selected || value.currentRevision !== item.revision || value.state !== "stale") throw new Error("数据身份或当前版本已变化，请重新核对当前状态");
      setOlder(value);
    } catch (reason) { if (ticket === sequence.current) setError(String(reason)); }
    finally { if (ticket === sequence.current) setLoading(false); }
  }
  if (item.state === "unavailable" || !item.content) return <AgentSleepDatasets items={[item]} workId={workId} recordVersion={recordVersion} revoked={false} evidenceTable />;
  const shown = revision === item.revision ? item : older;
  return <section aria-label="数据保存版本">
    <label>数据版本<select value={revision} onChange={event => void read(Number(event.target.value))}>
      {Array.from({ length: Math.min(32, item.revision) }, (_, index) => item.revision - index).map(value => <option key={value} value={value}>第 {value} 版{value === item.revision ? "（当前）" : "（历史，只读）"}</option>)}
    </select></label>
    <p className="agent-note">查看旧版不改变当前数据、图表、报告或预算。纠正入口只预填原工作要求，核对并发送后才提交；不修改原笔记。</p>
    {loading && <p role="status">正在按当前授权读取指定数据版本…</p>}
    {error && <p role="alert">{error}</p>}
    {shown && <AgentSleepDatasets key={shown.revision} items={[shown]} workId={workId} recordVersion={recordVersion} revoked={false} evidenceTable onCorrect={revision === item.revision ? onCorrect : undefined} />}
  </section>;
}
