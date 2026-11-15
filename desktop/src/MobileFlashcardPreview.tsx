import { useEffect, useRef, useState } from "react";
import { loadFlashcardReviewPlan, loadFlashcardsByIds } from "./FlashcardQueries";
import { flashcardFrontPreview } from "./FlashcardPresentation";
import type { Flashcard } from "./FlashcardTypes";

export function MobileFlashcardPreview({disabled}: {disabled: boolean}) {
  const [cards, setCards] = useState<Flashcard[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [index, setIndex] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => {mounted.current = false;}; }, []);
  useEffect(() => {
    if (!cards || !dialog.current) return;
    const previous = document.activeElement;
    dialog.current.showModal();
    return () => {dialog.current?.close(); if (previous instanceof HTMLElement) previous.focus();};
  }, [cards]);
  const open = async () => {
    if (busy) return;
    setBusy(true); setError("");
    try {
      const plan = await loadFlashcardReviewPlan(null, 5);
      const next = await loadFlashcardsByIds(plan.sessionIds);
      if (!mounted.current) return;
      setIndex(0); setRevealed(false); setCards(next);
    } catch (reason) {if (mounted.current) setError(`无法读取预览：${String(reason)}`);}
    finally {if (mounted.current) setBusy(false);}
  };
  const card = cards?.[index];
  return <><button type="button" disabled={disabled || busy} onClick={() => void open()}>{busy ? "正在读取…" : "卡片堆预览"}</button>{error && <p role="alert">{error}</p>}
    {cards && <dialog className="flashcard-mobile-preview" ref={dialog} aria-label="今日卡片堆预览" onCancel={() => setCards(null)}>
      <header><strong>今日预览</strong><button type="button" onClick={() => setCards(null)}>关闭</button></header>
      <p>先回想，再揭晓。此处浏览不会提交评分。</p>
      {card ? <><h2>{flashcardFrontPreview(card)}</h2>{revealed ? <div className="flashcard-preview-answer">{card.answer}</div> : <button type="button" onClick={() => setRevealed(true)}>揭晓答案</button>}
        <footer><span>{index+1} / {cards.length}</span><button type="button" disabled={index===0} onClick={() => {setIndex(index-1);setRevealed(false);}}>上一张</button><button type="button" disabled={index===cards.length-1} onClick={() => {setIndex(index+1);setRevealed(false);}}>下一张</button></footer></> : <p>当前没有可预览的待学习卡片。</p>}
    </dialog>}
  </>;
}
