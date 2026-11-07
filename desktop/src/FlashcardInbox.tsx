import { userProfileStorage } from "./UserProfileStorage";
import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, MouseEvent, PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, ChevronLeft, ChevronRight, CirclePlus, ExternalLink, FolderInput, Image, Inbox, Layers3, LoaderCircle, MessageSquare, Search, Trash2, X } from "lucide-react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import { FlashcardAttachment } from "./FlashcardAttachment";
import { FlashcardGenerationDetails } from "./FlashcardGenerationDetails";
import { flashcardFrontPreview } from "./FlashcardPresentation";
import type { FlashcardCardType, FlashcardDeckSummary, FlashcardDraft } from "./FlashcardTypes";
import "./FlashcardInbox.css";

const PAGE_SIZE = 60;
const LIST_WIDTH_KEY = "hub.flashcard-inbox-list-width";
const DEFAULT_LIST_WIDTH = 340;
const MIN_LIST_WIDTH = 260;
const MAX_LIST_WIDTH = 480;
const MIN_READER_WIDTH = 320;
const DIVIDER_WIDTH = 8;

function loadListWidth(): number {
  try {
    const stored = userProfileStorage.getItem(LIST_WIDTH_KEY);
    const width = stored === null ? DEFAULT_LIST_WIDTH : Number(stored);
    return Number.isFinite(width) ? Math.max(MIN_LIST_WIDTH, Math.min(MAX_LIST_WIDTH, width)) : DEFAULT_LIST_WIDTH;
  } catch { return DEFAULT_LIST_WIDTH; }
}
const CARD_TYPES: Record<FlashcardCardType, string> = { qa: "问答", cloze: "填空", multiple_choice: "选择题", typed_answer: "输入答案", ordering: "排序", image_occlusion: "图片遮挡" };
const REMARK_PLUGINS = [remarkGfm, remarkMath, remarkInboxEmphasis];
const REHYPE_PLUGINS = [rehypeKatex];

type MarkdownAstNode = { type: string; value?: string; children?: MarkdownAstNode[]; position?: { start: { offset?: number }; end: { offset?: number } } };

/** Repair spaces before closing bold markers in older imports for display only.
 * Escaped text, code and stored data keep their original content. */
function remarkInboxEmphasis() {
  return (tree: MarkdownAstNode, file: { value?: unknown }) => {
    const source = String(file.value ?? "");
    const visit = (parent: MarkdownAstNode) => {
      if (!parent.children || parent.type === "code" || parent.type === "inlineCode") return;
      parent.children = parent.children.flatMap((node) => {
        const value = node.value ?? "";
        const start = node.position?.start.offset;
        const end = node.position?.end.offset;
        if (node.type !== "text" || start === undefined || end === undefined || source.slice(start, end) !== value) { visit(node); return [node]; }
        const parts: MarkdownAstNode[] = [];
        let cursor = 0;
        for (const match of value.matchAll(/\*\*([^\n*]+?\S)[ \t]+\*\*/g)) {
          if (match.index > cursor) parts.push({ type: "text", value: value.slice(cursor, match.index) });
          parts.push({ type: "strong", children: [{ type: "text", value: match[1].trim() }] });
          cursor = match.index + match[0].length;
        }
        if (!parts.length) return [node];
        if (cursor < value.length) parts.push({ type: "text", value: value.slice(cursor) });
        return parts;
      });
    };
    visit(tree);
  };
}

type Props = {
  drafts: FlashcardDraft[];
  decks: FlashcardDeckSummary[];
  isAndroid: boolean;
  resolving: boolean;
  onCreate: () => void;
  onResolve: (ids: string[], accept: boolean, operationId: string, deckId?: string) => Promise<void>;
  onFeedback: (draft: FlashcardDraft) => void;
  onDragEnd: () => void;
  onDragTarget?: (deckId: string) => void;
  onOpenLink: (href: string) => unknown;
  onOpenSource: (draft: FlashcardDraft) => void;
};
export { inboxDraftIdsFromTransfer } from "./FlashcardInboxTransfer";


function plainPreview(text: string): string {
  return text.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[*`#]/g, "").replace(/\s+/g, " ").trim();
}

export function FlashcardInbox({ drafts, decks, isAndroid, resolving, onCreate, onResolve, onFeedback, onDragEnd, onDragTarget, onOpenLink, onOpenSource }: Props) {
  const [query, setQuery] = useState("");
  const [type, setType] = useState<"all" | FlashcardCardType>("all");
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [previewId, setPreviewId] = useState("");
  const [movePopoverOpen, setMovePopoverOpen] = useState(false);
  const [movePopoverScope, setMovePopoverScope] = useState("");
  const [deckQuery, setDeckQuery] = useState("");
  const moveTriggerRef = useRef<HTMLButtonElement>(null);
  const movePopoverRef = useRef<HTMLDivElement>(null);
  const deckSearchRef = useRef<HTMLInputElement>(null);
  const inboxSearchRef = useRef<HTMLInputElement>(null);
  const selectionAnchor = useRef("");
  const lastPreviewIndex = useRef(0);
  const selectAllRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const workbenchRef = useRef<HTMLDivElement>(null);
  const resizeCleanup = useRef<(() => void) | null>(null);
  const [workbenchWidth, setWorkbenchWidth] = useState(0);
  const [listWidth, setListWidth] = useState(loadListWidth);
  const draggedWidth = useRef(listWidth);
  const pointerDragCleanup = useRef<(() => void) | null>(null);
  const suppressDragClick = useRef(false);
  const dragClickTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [dragPreview, setDragPreview] = useState<{ originId: string; count: number; x: number; y: number; deckName: string } | null>(null);
  const liveDrag = useRef({ drafts, decks, resolving, isAndroid, onResolve, onDragTarget, onDragEnd });
  liveDrag.current = { drafts, decks, resolving, isAndroid, onResolve, onDragTarget, onDragEnd };
  const hasDrafts = drafts.length > 0;
  const compact = isAndroid || (workbenchWidth > 0 && workbenchWidth <= 650);
  const maximumListWidth = workbenchWidth > 0
    ? Math.min(MAX_LIST_WIDTH, Math.max(MIN_LIST_WIDTH, workbenchWidth - MIN_READER_WIDTH - DIVIDER_WIDTH))
    : MAX_LIST_WIDTH;
  const effectiveListWidth = Math.min(maximumListWidth, Math.max(MIN_LIST_WIDTH, listWidth));

  useEffect(() => {
    const workbench = workbenchRef.current;
    if (!workbench) return;
    const measure = () => {
      resizeCleanup.current?.();
      setWorkbenchWidth(Math.floor(workbench.getBoundingClientRect().width));
    };
    measure();
    window.addEventListener("resize", measure);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(workbench);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
      resizeCleanup.current?.();
    };
  }, [hasDrafts]);

  const persistListWidth = (value: number, restoreDefault = false) => {
    const width = restoreDefault ? DEFAULT_LIST_WIDTH : Math.round(Math.min(maximumListWidth, Math.max(MIN_LIST_WIDTH, value)));
    draggedWidth.current = width;
    setListWidth(width);
    try { userProfileStorage.setItem(LIST_WIDTH_KEY, String(width)); } catch { /* Keep the preference for this session. */ }
  };
  const resizeList = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || compact) return;
    event.preventDefault();
    resizeCleanup.current?.();
    const { clientX: startX, pointerId } = event;
    const startWidth = effectiveListWidth;
    const handle = event.currentTarget;
    draggedWidth.current = startWidth;
    handle.focus();
    handle.setPointerCapture?.(pointerId);
    handle.classList.add("is-resizing");
    const move = (next: PointerEvent) => {
      if (next.pointerId !== pointerId) return;
      const width = Math.round(Math.min(maximumListWidth, Math.max(MIN_LIST_WIDTH, startWidth + next.clientX - startX)));
      draggedWidth.current = width;
      workbenchRef.current?.style.setProperty("--inbox-list-width", `${width}px`);
      handle.setAttribute("aria-valuenow", String(width));
      handle.setAttribute("aria-valuetext", `列表宽度 ${width} 像素`);
    };
    const cleanup = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      handle.classList.remove("is-resizing");
      if (handle.hasPointerCapture?.(pointerId)) handle.releasePointerCapture(pointerId);
      // Restore the rendered preference when a resize or unmount interrupts a drag.
      workbenchRef.current?.style.setProperty("--inbox-list-width", `${effectiveListWidth}px`);
      handle.setAttribute("aria-valuenow", String(effectiveListWidth));
      handle.setAttribute("aria-valuetext", `列表宽度 ${effectiveListWidth} 像素`);
      resizeCleanup.current = null;
    };
    const finish = (next: PointerEvent) => {
      if (next.pointerId !== pointerId) return;
      const width = draggedWidth.current;
      cleanup();
      persistListWidth(width);
    };
    resizeCleanup.current = cleanup;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
  };
  const resizeListWithKeyboard = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    let width = effectiveListWidth;
    if (event.key === "ArrowLeft") width -= event.shiftKey ? 40 : 16;
    else if (event.key === "ArrowRight") width += event.shiftKey ? 40 : 16;
    else if (event.key === "Home") width = MIN_LIST_WIDTH;
    else if (event.key === "End") width = maximumListWidth;
    else if (event.key === "Enter") width = DEFAULT_LIST_WIDTH;
    else return;
    if (compact) return;
    event.preventDefault();
    persistListWidth(width, event.key === "Enter");
  };

  const filtered = useMemo(() => {
    const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    return drafts.filter((draft) => (type === "all" || draft.cardType === type) && terms.every((term) =>
      [draft.question, draft.answer, draft.explanation, draft.evidence, draft.sourceTitle, draft.sourcePath, draft.deckName, ...draft.tags].join(" ").toLocaleLowerCase().includes(term)));
  }, [drafts, query, type]);
  const visible = filtered.slice(0, visibleCount);
  const selected = drafts.filter((draft) => selectedIds.has(draft.id));
  const foundPreviewIndex = filtered.findIndex((draft) => draft.id === previewId);
  const previewIndex = foundPreviewIndex >= 0 ? foundPreviewIndex : Math.min(lastPreviewIndex.current, Math.max(0, filtered.length - 1));
  const preview = filtered[previewIndex];
  const allVisibleSelected = visible.length > 0 && visible.every((draft) => selectedIds.has(draft.id));
  const someVisibleSelected = visible.some((draft) => selectedIds.has(draft.id));
  const hiddenSelectedCount = selected.filter((draft) => !filtered.some((item) => item.id === draft.id)).length;
  const moveIds = selected.length > 0 ? selected.map((draft) => draft.id) : preview ? [preview.id] : [];
  const moveScope = JSON.stringify(moveIds);
  const matchingDecks = decks.filter((deck) => deck.name.toLocaleLowerCase().includes(deckQuery.trim().toLocaleLowerCase()));

  useEffect(() => {
    if (movePopoverOpen && movePopoverScope !== moveScope) {
      setMovePopoverOpen(false);
      moveTriggerRef.current?.focus();
    }
  }, [movePopoverOpen, movePopoverScope, moveScope]);

  useEffect(() => {
    if (!movePopoverOpen) return;
    deckSearchRef.current?.focus();
    const dismissOutside = (event: Event) => {
      const target = event.target as Node | null;
      if (target && !movePopoverRef.current?.contains(target) && !moveTriggerRef.current?.contains(target)) setMovePopoverOpen(false);
    };
    const dismissOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); setMovePopoverOpen(false); moveTriggerRef.current?.focus(); }
    };
    document.addEventListener("pointerdown", dismissOutside);
    document.addEventListener("focusin", dismissOutside);
    document.addEventListener("keydown", dismissOnEscape);
    return () => {
      document.removeEventListener("pointerdown", dismissOutside);
      document.removeEventListener("focusin", dismissOutside);
      document.removeEventListener("keydown", dismissOnEscape);
    };
  }, [movePopoverOpen]);

  useEffect(() => {
    setSelectedIds((current) => {
      const live = new Set(drafts.map((draft) => draft.id));
      const next = new Set([...current].filter((id) => live.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [drafts]);
  useEffect(() => { if (selectAllRef.current) selectAllRef.current.indeterminate = someVisibleSelected && !allVisibleSelected; }, [someVisibleSelected, allVisibleSelected]);
  useEffect(() => {
    lastPreviewIndex.current = previewIndex;
    if (preview && preview.id !== previewId) setPreviewId(preview.id);
  }, [preview, previewId, previewIndex]);

  const resetBrowse = () => { setVisibleCount(PAGE_SIZE); lastPreviewIndex.current = 0; if (listRef.current) listRef.current.scrollTop = 0; };
  const toggleSelection = (id: string, range = false) => {
    if (resolving) return;
    const anchorId = selectionAnchor.current;
    setSelectedIds((current) => {
      const next = new Set(current);
      const anchorIndex = filtered.findIndex((draft) => draft.id === anchorId);
      const clickedIndex = filtered.findIndex((draft) => draft.id === id);
      if (range && anchorIndex >= 0 && clickedIndex >= 0) {
        filtered.slice(Math.min(anchorIndex, clickedIndex), Math.max(anchorIndex, clickedIndex) + 1).forEach((draft) => next.add(draft.id));
      } else if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    if (!range) selectionAnchor.current = id;
  };
  const openPreview = (draft: FlashcardDraft, event: MouseEvent<HTMLElement>) => {
    if (suppressDragClick.current) { event.preventDefault(); event.stopPropagation(); return; }
    // Checkbox clicks only change selection; the row remains a separate preview target.
    if ((event.target as HTMLElement).closest("input")) return;
    setPreviewId(draft.id);
    if (event.ctrlKey || event.metaKey || event.shiftKey) {
      if (event.detail <= 1) toggleSelection(draft.id, event.shiftKey);
    }
    else selectionAnchor.current = draft.id;
  };
  const selectRowOnDoubleClick = (draft: FlashcardDraft, event: MouseEvent<HTMLElement>) => {
    if (suppressDragClick.current) { event.preventDefault(); event.stopPropagation(); return; }
    if ((event.target as HTMLElement).closest("input") || event.ctrlKey || event.metaKey || event.shiftKey) return;
    event.preventDefault();
    toggleSelection(draft.id);
  };
  const pagePreview = (index: number) => {
    if (!filtered[index]) return;
    setPreviewId(filtered[index].id);
    if (index >= visibleCount) setVisibleCount(Math.ceil((index + 1) / PAGE_SIZE) * PAGE_SIZE);
    requestAnimationFrame(() => listRef.current?.querySelector<HTMLElement>(`[data-inbox-index="${index}"]`)?.scrollIntoView?.({ block: "nearest" }));
  };
  useEffect(() => () => {
    pointerDragCleanup.current?.();
    if (dragClickTimer.current !== null) clearTimeout(dragClickTimer.current);
  }, []);
  useEffect(() => { if (resolving || isAndroid) pointerDragCleanup.current?.(); }, [resolving, isAndroid]);
  const beginPointerDrag = (event: ReactPointerEvent<HTMLElement>, draft: FlashcardDraft) => {
    if (isAndroid || resolving || event.button !== 0 || event.pointerType === "touch" || event.isPrimary === false || (event.target as Element).closest("input, label")) return;
    pointerDragCleanup.current?.();
    const handle = event.currentTarget;
    const { pointerId, clientX: startX, clientY: startY } = event;
    const dragIds = (selectedIds.has(draft.id) ? selected : [draft]).map((item) => item.id);
    let dragging = false;
    try { handle.setPointerCapture?.(pointerId); } catch { /* Window listeners still track the gesture. */ }
    const targetDeck = (x: number, y: number) => {
      const target = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-inbox-drop-deck]");
      return liveDrag.current.decks.find((deck) => deck.id === target?.dataset.inboxDropDeck);
    };
    const suppressClick = () => {
      suppressDragClick.current = true;
      if (dragClickTimer.current !== null) clearTimeout(dragClickTimer.current);
      // The compatibility click follows pointerup in the same browser input turn.
      dragClickTimer.current = setTimeout(() => { suppressDragClick.current = false; dragClickTimer.current = null; }, 0);
    };
    const cleanup = () => {
      pointerDragCleanup.current = null;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", cancelPointer);
      window.removeEventListener("keydown", cancelKey);
      window.removeEventListener("blur", cancel);
      handle.removeEventListener("lostpointercapture", cancelPointer);
      if (handle.hasPointerCapture?.(pointerId)) handle.releasePointerCapture(pointerId);
      setDragPreview(null);
      liveDrag.current.onDragTarget?.("");
      liveDrag.current.onDragEnd();
      if (dragging) suppressClick();
    };
    const move = (next: PointerEvent) => {
      if (next.pointerId !== pointerId) return;
      if (liveDrag.current.resolving || liveDrag.current.isAndroid) { cleanup(); return; }
      if (!dragging && Math.hypot(next.clientX - startX, next.clientY - startY) < 5) return;
      dragging = true;
      next.preventDefault();
      const deck = targetDeck(next.clientX, next.clientY);
      setDragPreview({ originId: draft.id, count: dragIds.length, x: next.clientX + 12, y: next.clientY + 12, deckName: deck?.name ?? "" });
      liveDrag.current.onDragTarget?.(deck?.id ?? "");
    };
    const finish = (next: PointerEvent) => {
      if (next.pointerId !== pointerId) return;
      const live = liveDrag.current;
      const deck = dragging && !live.resolving && !live.isAndroid ? targetDeck(next.clientX, next.clientY) : undefined;
      const liveIds = new Set(live.drafts.map((item) => item.id));
      const ids = dragIds.filter((id) => liveIds.has(id));
      if (dragging) next.preventDefault();
      cleanup();
      if (deck && ids.length > 0) void live.onResolve(ids, true, "inbox-drop", deck.id);
    };
    const cancel = () => cleanup();
    const cancelPointer = (next: PointerEvent) => { if (next.pointerId === pointerId) cleanup(); };
    const cancelKey = (next: KeyboardEvent) => { if (next.key === "Escape") { next.preventDefault(); cleanup(); } };
    pointerDragCleanup.current = cleanup;
    window.addEventListener("pointermove", move, { passive: false });
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", cancelPointer);
    window.addEventListener("keydown", cancelKey);
    window.addEventListener("blur", cancel);
    handle.addEventListener("lostpointercapture", cancelPointer);
  };
  const moveToDeck = async (deckId: string) => {
    setMovePopoverOpen(false);
    moveTriggerRef.current?.focus();
    try {
      await onResolve(moveIds, true, "inbox-move", deckId);
    } finally {
      requestAnimationFrame(() => {
        if (document.activeElement !== document.body && document.activeElement !== moveTriggerRef.current) return;
        if (moveTriggerRef.current && !moveTriggerRef.current.disabled) moveTriggerRef.current.focus();
        else inboxSearchRef.current?.focus();
      });
    }
  };
  const markdown = (text: string) => <div className="flashcard-inbox-markdown"><ReactMarkdown remarkPlugins={REMARK_PLUGINS} rehypePlugins={REHYPE_PLUGINS} skipHtml urlTransform={(url) => /^(?:craftdocs|obsidian):\/\//i.test(url) ? url : defaultUrlTransform(url)} components={{
    a: ({ href, children }) => <a href={href} onClick={(event) => { event.preventDefault(); if (href) void onOpenLink(href); }}>{children}</a>,
    img: ({ alt }) => <span>{alt || "图片见附件"}</span>,
  }}>{text}</ReactMarkdown></div>;
  const media = (placement: "question" | "answer" | "explanation") => {
    const items = preview?.media.filter((item) => (item.placement ?? "answer") === placement) ?? [];
    return items.length > 0 ? <div className="flashcards-media">{items.map((item, index) => <FlashcardAttachment key={`${item.url}-${index}`} item={item} />)}</div> : null;
  };

  return <section className="flashcard-inbox" aria-label="闪卡收件箱">
    <header className="flashcard-inbox-toolbar">
      <div className="flashcard-inbox-title"><h1>收件箱</h1><span>{drafts.length}</span></div>
      <label className="flashcard-inbox-search"><Search size={15} aria-hidden="true" /><input ref={inboxSearchRef} aria-label="搜索收件箱" placeholder="搜索收件箱" value={query} onChange={(event) => { setQuery(event.target.value); resetBrowse(); }} />{query && <button aria-label="清除搜索" onClick={() => { setQuery(""); resetBrowse(); }}><X size={13} /></button>}</label>
      <select className="flashcard-inbox-type-filter" aria-label="筛选卡片类型" value={type} onChange={(event) => { setType(event.target.value as typeof type); resetBrowse(); }}><option value="all">所有类型</option>{Object.entries(CARD_TYPES).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
      <button className="flashcard-inbox-new" onClick={onCreate}><CirclePlus size={16} /><span>新建</span></button>
      <div className="flashcard-inbox-popover-wrap">
        <button ref={moveTriggerRef} className="flashcard-inbox-move-trigger" aria-label="移入牌组" aria-haspopup="dialog" aria-expanded={movePopoverOpen} aria-controls={movePopoverOpen ? "flashcard-inbox-move-popover" : undefined} disabled={resolving || moveIds.length === 0} onClick={() => { setDeckQuery(""); setMovePopoverScope(moveScope); setMovePopoverOpen((open) => !open); }}>{resolving ? <LoaderCircle size={16} className="spin" /> : <FolderInput size={16} />}<span>移入…</span><ChevronDown size={12} /></button>
        {movePopoverOpen && <div ref={movePopoverRef} className="flashcard-inbox-move-popover" id="flashcard-inbox-move-popover" role="dialog" aria-label="选择目标牌组"><header><strong>{selected.length > 0 ? `移动 ${selected.length} 张卡片` : "移动当前卡片"}</strong><button aria-label="关闭牌组选择" onClick={() => { setMovePopoverOpen(false); moveTriggerRef.current?.focus(); }}><X size={15} /></button></header>
          {hiddenSelectedCount > 0 && <p className="flashcard-inbox-popover-note">包含 {hiddenSelectedCount} 张筛选外的卡片</p>}
          <label className="flashcard-inbox-deck-search"><Search size={14} /><input ref={deckSearchRef} aria-label="搜索目标牌组" placeholder="搜索牌组" value={deckQuery} onChange={(event) => setDeckQuery(event.target.value)} /></label>
          <div className="flashcard-inbox-deck-options">{matchingDecks.map((deck) => <button key={deck.id} disabled={resolving} onClick={() => void moveToDeck(deck.id)}><Layers3 size={16} /><span>{deck.name}</span><small>{deck.cardCount}</small></button>)}{matchingDecks.length === 0 && <p>{decks.length === 0 ? "先在牌库中创建一个牌组" : "没有匹配的牌组"}</p>}</div>
        </div>}
      </div>
    </header>
    {drafts.length === 0 ? <div className="flashcard-inbox-empty"><Inbox size={38} strokeWidth={1.5} /><strong>收件箱已整理完毕</strong><p>新建和导入的闪卡会先到这里。</p><button onClick={onCreate}><CirclePlus size={15} />新建卡片</button></div> : <div ref={workbenchRef} className={`flashcard-inbox-workbench${compact ? " is-compact" : ""}`} style={{ "--inbox-list-width": `${effectiveListWidth}px` } as CSSProperties}>
      <section className="flashcard-inbox-queue" id="flashcard-inbox-queue" aria-label="待归组卡片">
        <div className="flashcard-inbox-queue-bar"><label><input ref={selectAllRef} type="checkbox" aria-label="选择当前显示的卡片" checked={allVisibleSelected} disabled={resolving || visible.length === 0} onChange={() => setSelectedIds((current) => {
          const next = new Set(current); visible.forEach((draft) => { if (allVisibleSelected) next.delete(draft.id); else next.add(draft.id); }); return next;
        })} /><span aria-live="polite">{selected.length > 0 ? `已选 ${selected.length} 张` : filtered.length < drafts.length ? `${filtered.length} / ${drafts.length} 张` : `${drafts.length} 张卡片`}</span></label>{selected.length > 0 && <button className="flashcard-inbox-cancel-selection" aria-label="取消选择" disabled={resolving} onClick={() => setSelectedIds(new Set())}>取消</button>}{selected.length > 0 && <button className="flashcard-inbox-remove-selected" aria-label="移除所选卡片" title="移除所选卡片" disabled={resolving} onClick={() => { if (window.confirm(`确定从收件箱移除所选 ${selected.length} 张卡片？`)) void onResolve(selected.map((draft) => draft.id), false, "inbox-batch-reject"); }}><Trash2 size={14} /></button>}</div>
        <div className="flashcard-inbox-rows" ref={listRef}>
          {visible.map((draft, index) => <article key={draft.id} data-inbox-index={index} data-draggable={!isAndroid && !resolving} className={`flashcard-inbox-row${preview?.id === draft.id ? " active" : ""}${selectedIds.has(draft.id) ? " selected" : ""}${dragPreview?.originId === draft.id ? " is-dragging" : ""}`} onClick={(event) => openPreview(draft, event)} onDoubleClick={(event) => selectRowOnDoubleClick(draft, event)} draggable={false} onPointerDown={(event) => beginPointerDrag(event, draft)}>
            <input type="checkbox" aria-label={`选择卡片：${draft.question}`} checked={selectedIds.has(draft.id)} disabled={resolving} onChange={(event) => toggleSelection(draft.id, Boolean((event.nativeEvent as { shiftKey?: boolean }).shiftKey))} />
            <button className="flashcard-inbox-row-open" aria-label={`预览卡片：${draft.question}`} aria-current={preview?.id === draft.id ? "true" : undefined} title="单击预览；双击选中；拖入左侧牌组">
              <span className="flashcard-inbox-row-title"><span className="flashcard-inbox-row-question">{plainPreview(flashcardFrontPreview(draft))}</span></span><p>{plainPreview(draft.answer) || "查看卡片内容"}</p>
              {(draft.cardType !== "qa" || draft.media.length > 0) && <small className="flashcard-inbox-row-kind">{draft.cardType !== "qa" && CARD_TYPES[draft.cardType]}{draft.media.length > 0 && <span><Image size={11} />{draft.media.length} 个附件</span>}</small>}
            </button>
          </article>)}
          {filtered.length === 0 && <div className="flashcard-inbox-empty"><Search size={24} /><strong>没有匹配的卡片</strong><p>试试其他关键词或卡片类型</p><button onClick={() => { setQuery(""); setType("all"); resetBrowse(); }}>清除筛选</button></div>}
          {visible.length < filtered.length && <button className="flashcard-inbox-more" onClick={() => setVisibleCount((count) => count + PAGE_SIZE)}>显示余下 {filtered.length - visible.length} 张</button>}
        </div>
      </section>
      <div className="flashcard-inbox-divider" role="separator" aria-label="调整收件箱列表宽度" aria-orientation="vertical" aria-controls="flashcard-inbox-queue" aria-valuemin={MIN_LIST_WIDTH} aria-valuemax={maximumListWidth} aria-valuenow={effectiveListWidth} aria-valuetext={`列表宽度 ${effectiveListWidth} 像素`} tabIndex={compact ? -1 : 0} hidden={compact} title="拖动调整列表与预览宽度；双击或按 Enter 恢复默认" onPointerDown={resizeList} onKeyDown={resizeListWithKeyboard} onDoubleClick={() => persistListWidth(DEFAULT_LIST_WIDTH, true)} />
      <section className="flashcard-inbox-reading" aria-label="卡片详情">
        <div className="flashcard-inbox-reading-bar"><span>{preview ? `${CARD_TYPES[preview.cardType]} · ${preview.generation?.source === "manual" ? "手动新建" : "模型提交"}` : "卡片详情"}</span><div className="flashcard-inbox-pager"><span>{preview ? `${previewIndex + 1} / ${filtered.length}` : "—"}</span><button aria-label="上一张卡片" disabled={!preview || previewIndex === 0} onClick={() => pagePreview(previewIndex - 1)}><ChevronLeft size={16} /></button><button aria-label="下一张卡片" disabled={!preview || previewIndex >= filtered.length - 1} onClick={() => pagePreview(previewIndex + 1)}><ChevronRight size={16} /></button></div></div>
        {preview ? <div key={preview.id} className="flashcard-inbox-document" data-selectable="true">
          <h2 className="flashcard-inbox-question">{preview.question}</h2>
          {media("question")}
          {preview.cardType === "multiple_choice" && preview.cardData.options?.length ? <ol className="flashcard-inbox-options">{preview.cardData.options.map((option, index) => <li key={index} className={index === preview.cardData.correctIndex ? "correct" : ""}>{option}{index === preview.cardData.correctIndex && <Check size={14} aria-label="正确答案" />}</li>)}</ol> : null}
          {preview.cardType === "ordering" && preview.cardData.items?.length ? <ol className="flashcard-inbox-options">{preview.cardData.items.map((item, index) => <li key={index}>{item}</li>)}</ol> : null}
          <section className="flashcard-inbox-section flashcard-inbox-answer flashcard-inbox-answer-section"><h3>答案</h3>{markdown(preview.answer)}{media("answer")}</section>
          {preview.evidence && <aside className="flashcard-inbox-evidence" aria-label="卡片依据"><strong>依据：</strong>{markdown(preview.evidence.replace(/^\s*依据[：:]\s*/, ""))}</aside>}
          {(preview.explanation || preview.media.some((item) => item.placement === "explanation")) && <section className="flashcard-inbox-section flashcard-inbox-explanation flashcard-inbox-explanation-section"><h3>解释</h3>{preview.explanation && markdown(preview.explanation)}{media("explanation")}</section>}
          <div className="flashcard-inbox-source-row"><span>来源</span><strong title={preview.sourcePath}>{preview.sourceTitle || preview.sourcePath || "未提供来源"}</strong>{(Boolean(preview.sourceLibraryId && preview.sourceDocumentId) || /^(https?:\/\/|obsidian:\/\/|craftdocs:\/\/)/i.test(preview.sourcePath.trim())) && <button aria-label="查看卡片来源" onClick={() => onOpenSource(preview)}><ExternalLink size={13} /></button>}</div>
          {preview.tags.length > 0 && <div className="flashcard-inbox-tags">{preview.tags.map((tag) => <span key={tag}>{tag}</span>)}</div>}
          <FlashcardGenerationDetails key={preview.id} generation={preview.generation} decks={decks} />
          <div className="flashcard-inbox-detail-actions">{typeof preview.confidence === "number" && <span title="提交时对内容可靠性的评分">置信度 {Math.round(preview.confidence * 100)}%</span>}<button onClick={() => onFeedback(preview)}><MessageSquare size={14} />反馈</button><button disabled={resolving} onClick={() => void onResolve([preview.id], false, preview.id)}><Trash2 size={14} />移除</button></div>
        </div> : <div className="flashcard-inbox-empty"><Inbox size={28} /><strong>没有可预览的卡片</strong><p>清除筛选后继续整理收件箱</p></div>}
      </section>
    </div>}
    {dragPreview && createPortal(<div className="flashcard-inbox-drag-preview" role="status" style={{ left: dragPreview.x, top: dragPreview.y }}><strong>{dragPreview.count} 张卡片</strong><span>{dragPreview.deckName ? `移入 ${dragPreview.deckName}` : "拖入左侧牌组"}</span></div>, document.body)}
  </section>;
}
