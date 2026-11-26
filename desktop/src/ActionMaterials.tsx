import { Fragment, useEffect, useState } from "react";
import type { ReactNode } from "react";
import type { QuickJournalItem } from "./JournalRecords";
import { QuickJournalCard } from "./QuickJournal";
import type { PdfPagePreview, SearchResult } from "./SearchTypes";
import { invoke } from "@tauri-apps/api/core";
import { isPdfContent } from "./PdfPreviewModel";
import { journalMaterial, queryMaterials, relevance, terms, type Material } from "./ActionEvidence";

export function useRecall(title: string, scope: string[] | null) {
  const key = JSON.stringify([title, scope]);
  const [state, setState] = useState({ key: "", items: [] as Material[], error: "" });
  useEffect(() => {
    let live = true;
    if (title)
      void queryMaterials(title, scope).then(
        (items) => {
          if (live) setState({ key, items, error: "" });
        },
        (e) => {
          if (live) setState({ key, items: [], error: String(e) });
        },
      );
    return () => {
      live = false;
    };
  }, [key]);
  return state.key === key ? state : { key, items: [], error: "" };
}
export function assembleMaterials(
  title: string,
  journals: QuickJournalItem[],
  docs: Material[],
  links: Material[],
  day: string,
) {
  const anchors = terms(title);
  const specific = anchors.filter((t) => /\d/.test(t));
  const matchesSubject = (text: string) =>
    specific.some((t) => text.toLowerCase().includes(t)) ||
    relevance(anchors, text) >= Math.min(2, anchors.length);
  const recentDate = new Date(day + "T12:00:00");
  recentDate.setDate(recentDate.getDate() - 13);
  const byId = new Map(links.map((m) => [m.id, m]));
  const found = journals
    .map((j) => ({
      item: j,
      score: relevance(
        anchors,
        (j.body || j.record.text) + " " + j.record.attachments.map((a) => a.name).join(" "),
      ),
    }))
    .filter(
      (v) =>
        matchesSubject(
          (v.item.body || v.item.record.text) + " " + v.item.record.attachments.map((a) => a.name).join(" "),
        ) &&
        v.score > 0 &&
        v.item.record.date <= day &&
        new Date(v.item.record.date + "T12:00:00") >= recentDate,
    )
    .sort((a, b) => b.score - a.score || b.item.record.date.localeCompare(a.item.record.date))
    .slice(0, 12);
  for (const m of [
    ...found.map((v) => journalMaterial(v.item)),
    ...docs.filter((d) => matchesSubject(d.title + " " + d.text)),
  ])
    if (!byId.has(m.id)) byId.set(m.id, m);
  const recent: Material[] = [],
    long: Material[] = [];
  for (const m of byId.values()) {
    const linked = links.some((a) => a.id === m.id);
    const isReference = /规范|标准|图纸|断面图|\.pdf\b|\.dwg\b|\.step\b/i.test(m.title);
    if (!linked && !isReference && m.date && new Date(m.date + "T12:00:00") >= recentDate) recent.push(m);
    else if (linked || isReference) long.push(m);
  }
  return { recent, long, all: [...recent, ...long] };
}
function PdfSource({ result }: { result: SearchResult }) {
  const page = result.pageNumber || 1;
  const [preview, setPreview] = useState<PdfPagePreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function open(external = false) {
    setBusy(true);
    setError("");
    try {
      const target = { resultId: result.id, pageNumber: page };
      if (external) await invoke("open_pdf_page", target);
      else {
        const p = await invoke<PdfPagePreview>("local_pdf_page_preview", target);
        if (p.pageNumber !== page) throw Error("返回的页码与引用不符。");
        setPreview(p);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <button disabled={busy} onClick={() => void open()}>
        打开来源 · 第 {page} 页
      </button>
      {preview && (
        <figure>
          <figcaption>原 PDF · 第 {page} 页</figcaption>
          {preview.imageDataUrl && (
            <img style={{ maxWidth: "100%" }} src={preview.imageDataUrl} alt={`${result.title} · 第 ${page} 页`} />
          )}
          {preview.text && <p>{preview.text}</p>}
          {preview.note && <small>{preview.note}</small>}
        </figure>
      )}
      {(preview || error) && (
        <button disabled={busy} onClick={() => void open(true)}>
          用阅读器打开原 PDF
        </button>
      )}
      {error && <p role="alert">{error}</p>}
    </>
  );
}
export function Materials({
  items,
  journals,
  onOpen,
  onPin,
  caption,
}: {
  items: Material[];
  journals: QuickJournalItem[];
  onOpen?: (r: SearchResult) => void;
  onPin?: (m: Material) => void;
  caption?: ReactNode;
}) {
  if (!items.length) return null;
  return (
    <section className="aw-materials">
      {caption && <h4>{caption}</h4>}
      {items.map((m) => {
        const j = m.journalId
          ? journals.find((j) => j.record.id === m.journalId && journalMaterial(j).id === (m.originId || m.id))
          : undefined;
        return (
          <Fragment key={m.id}>
            {!!j?.record.attachments.length && (
              <div className="aw-media-strip">
                <QuickJournalCard item={j} timeline mobile={false} onPreview={onOpen} />
              </div>
            )}
            <details>
              <summary>
                <i className="aw-file-icon">
                  {j ? "日志" : m.result?.pageNumber ? "PDF" : (m.result?.provider || "文档").toUpperCase()}
                </i>{" "}
                {m.title} <small>{m.result?.libraryName || m.date}</small>
              </summary>
              <blockquote>{m.text}</blockquote>

              {m.result && (isPdfContent(m.result.contentType) || m.result.pageNumber) ? (
                <PdfSource
                  key={JSON.stringify([m.result.id, m.result.pageNumber, m.result.modifiedAt])}
                  result={m.result}
                />
              ) : (
                m.result &&
                onOpen && (
                  <button onClick={() => onOpen(m.result!)}>
                    打开来源{m.result.pageNumber ? ` · 第 ${m.result.pageNumber} 页` : ""}
                  </button>
                )
              )}
              {onPin && <button onClick={() => onPin(m)}>固定到任务备料</button>}
            </details>
          </Fragment>
        );
      })}
    </section>
  );
}
