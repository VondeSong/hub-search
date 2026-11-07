import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { AgentCharts, type AnalysisChart } from "./AgentCharts";
import type { ArtifactReference } from "./AgentDelivery";

export function AgentArtifactRevision({ workId, reference }: { workId: string; reference: ArtifactReference }) {
  const [chart, setChart] = useState<AnalysisChart | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const sequence = useRef(0);
  useEffect(() => () => { sequence.current++; }, []);
  useEffect(() => {
    if (!chart?.content) return;
    const remaining = chart.content.data.statistics.inputSet.expiresAt * 1000 - Date.now();
    const timer = setTimeout(() => { setChart(null); setError("固定材料已过期"); }, Math.max(0, Math.min(remaining, 2_147_483_647)));
    return () => clearTimeout(timer);
  }, [chart]);
  const close = () => { sequence.current++; setChart(null); setError(""); setLoading(false); };
  const open = async () => {
    const ticket = ++sequence.current;
    setLoading(true); setError(""); setChart(null);
    try {
      const value = await invoke<AnalysisChart>("agent_investigation", { args: {
        action: "artifact", id: workId, artifactId: reference.artifactId, revision: reference.revision,
      } });
      if (ticket === sequence.current) setChart(value);
    } catch (reason) { if (ticket === sequence.current) setError(String(reason)); }
    finally { if (ticket === sequence.current) setLoading(false); }
  };
  return <section aria-label={`第 ${reference.revision} 版图表`}>
    <button type="button" onClick={() => void open()} disabled={loading}>查看第 {reference.revision} 版图表</button>
    {(chart || loading || error) && <button type="button" onClick={close}>关闭历史图表</button>}
    {loading && <p role="status">正在核对图表与来源权限…</p>}
    {error && <p role="alert">{error}。可核对来源后重新打开。</p>}
    {chart && <><p className="agent-note">这是回答使用的固定版本；继续修改请在对话中提出要求。</p><AgentCharts workId={workId} items={[chart]} revoked={false} /></>}
  </section>;
}
