import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

type CapturedSource = {
  title: string; content: string; start: number; end: number; totalCharacters: number;
  inputSet: { sourceAsOf: number; expiresAt: number };
  evidence: { start: number; end: number; text: string };
};

type SourceIdentity = { artifactId: string; datasetId?: never } | { datasetId: string; artifactId?: never };
export function AgentArtifactSource({ workId, artifactId, datasetId, revision, rowId, evidenceIndex }: SourceIdentity & {
  workId: string; revision: number; rowId: string; evidenceIndex: number;
}) {
  const [source, setSource] = useState<CapturedSource | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const sequence = useRef(0);
  const panel = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => () => { sequence.current++; }, []);
  useEffect(() => {
    if (source || loading || error) { panel.current?.focus(); panel.current?.scrollIntoView?.({ block: "nearest" }); }
  }, [source, loading, error]);
  useEffect(() => {
    if (!source) return;
    const timer = setTimeout(() => { setSource(null); setError("固定材料已过期"); }, Math.max(0, Math.min(source.inputSet.expiresAt * 1000 - Date.now(), 2_147_483_647)));
    return () => clearTimeout(timer);
  }, [source]);
  const close = () => { sequence.current++; setSource(null); setLoading(false); setError(""); trigger.current?.focus(); };
  const open = async () => {
    const ticket = ++sequence.current;
    setSource(null); setLoading(true); setError("");
    try {
      const value = await invoke<CapturedSource>("agent_investigation", { args: {
        ...(datasetId ? { action: "sleepDatasetSource", datasetId } : { action: "artifactSource", artifactId }),
        id: workId, revision, rowId, evidenceIndex,
      } });
      if (ticket === sequence.current) setSource(value);
    } catch (reason) { if (ticket === sequence.current) setError(String(reason)); }
    finally { if (ticket === sequence.current) setLoading(false); }
  };
  // Stored offsets count Unicode scalar values, not JavaScript UTF-16 units.
  const characters = Array.from(source?.content || "");
  const start = source ? source.evidence.start - source.start : 0;
  const end = source ? source.evidence.end - source.start : 0;
  return <div className="agent-source-preview" ref={panel} tabIndex={-1} onKeyDownCapture={event => {
    if (event.key === "Escape" && (source || loading || error)) { event.preventDefault(); event.stopPropagation(); close(); }
  }}>
    <button type="button" ref={trigger} disabled={loading} onClick={() => void open()}>查看固定原文</button>
    {(source || loading || error) && <button type="button" onClick={close}>关闭固定原文</button>}
    {loading && <p role="status">正在核对固定材料…</p>}
    {error && <p role="alert">{error}。可核对来源后重新打开。</p>}
    {source && <section aria-label="固定原文上下文">
      <strong>{source.title}</strong>
      <p className="agent-note">捕获于 {new Date(source.inputSet.sourceAsOf * 1000).toLocaleString()}，这是分析当时的固定原文。第 {source.start + 1}–{source.end} 字符，共 {source.totalCharacters} 字符。</p>
      <blockquote>{characters.slice(0, start).join("")}<mark>{characters.slice(start, end).join("")}</mark>{characters.slice(end).join("")}</blockquote>
      {(source.start > 0 || source.end < source.totalCharacters) && <p className="agent-note">仅展示出处附近的原文。</p>}
    </section>}
  </div>;
}
