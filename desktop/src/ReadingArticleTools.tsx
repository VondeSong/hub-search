import { useEffect, useId, useImperativeHandle, useRef, useState, type Ref } from "react";
import { createPortal } from "react-dom";
import { MoreHorizontal, ShieldCheck, X } from "lucide-react";
import { ReadingAttachments } from "./ReadingAttachments";
import { ReadingCopies } from "./ReadingCopies";
import { ReadingOffline } from "./ReadingOffline";
import { ReadingRecovery } from "./ReadingRecovery";
import { ReadingSourceRecovery } from "./ReadingSourceRecovery";
import { runtimeCapabilities } from "./RuntimePlatform";
import "./ReadingArticleTools.css";

export type ReadingArticleToolsHandle = { open: () => void };
type Props = { ref?: Ref<ReadingArticleToolsHandle>; itemKey: string; revision: string; reference?: boolean; needsAttention?: boolean };

// Changing articles closes the tools and releases their status polling.
export function ReadingArticleTools(props: Props) {
  return <ArticleTools key={props.itemKey} {...props} />;
}

function ArticleTools({ ref, itemKey, revision, reference = false, needsAttention = false }: Props) {
  const [opened, setOpened] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);
  const openedRef = useRef(false);
  const historySequence = useRef(0);
  const mobileHistory = useRef<{ token: string; closing: boolean; route: unknown; readingPreview: unknown; mobilePreview: unknown } | null>(null);
  const titleId = useId();

  const closeContent = () => {
    if (!openedRef.current) return;
    openedRef.current = false;
    restoreFocus.current = true;
    setOpened(false);
  };
  const close = () => {
    closeContent();
    const session = mobileHistory.current;
    if (!session || session.closing) return;
    if (window.history.state?.hubReadingArticleTools === session.token) {
      session.closing = true;
      window.history.back();
    } else mobileHistory.current = null;
  };
  const open = () => {
    // Wait for a requested traversal before creating another dialog entry.
    if (openedRef.current || mobileHistory.current?.closing) return;
    if (runtimeCapabilities.mobile) {
      const parent = window.history.state;
      const token = `${titleId}-${++historySequence.current}`;
      mobileHistory.current = { token, closing: false, route: parent?.hubMobileRoute, readingPreview: parent?.hubReadingPreview, mobilePreview: parent?.hubMobilePreview };
      window.history.pushState({ ...parent, hubReadingArticleTools: token }, "");
    }
    openedRef.current = true;
    setOpened(true);
  };

  useEffect(() => {
    if (!runtimeCapabilities.mobile) return;
    const consumeBack = (event: PopStateEvent) => {
      const session = mobileHistory.current;
      if (!session || event.state?.hubReadingArticleTools === session.token) return;
      mobileHistory.current = null;
      closeContent();
      // This traversal only dismisses the dialog. Leave its parent article and
      // the application's other Back handlers for the following traversal.
      if (event.state?.hubMobileRoute === session.route && event.state?.hubReadingPreview === session.readingPreview && event.state?.hubMobilePreview === session.mobilePreview) event.stopImmediatePropagation();
    };
    window.addEventListener("popstate", consumeBack, true);
    return () => {
      window.removeEventListener("popstate", consumeBack, true);
      openedRef.current = false;
      restoreFocus.current = false;
      const session = mobileHistory.current;
      mobileHistory.current = null;
      // A route change replaces the state before unmount. Never traverse that
      // new route; only release an entry still owned by this article's dialog.
      if (session && !session.closing && window.history.state?.hubReadingArticleTools === session.token) window.history.back();
    };
  }, []);

  useEffect(() => {
    if (!opened) {
      if (restoreFocus.current) { restoreFocus.current = false; trigger.current?.focus(); }
      return;
    }
    const element = dialog.current;
    element?.showModal();
    const position = () => {
      const paper = trigger.current?.closest(".collection-detail")?.getBoundingClientRect();
      if (!reference || !element || !paper) return;
      element.style.setProperty("--reading-inspector-top", paper.top + "px");
      element.style.setProperty("--reading-inspector-right", (window.innerWidth - paper.right) + "px");
      element.style.setProperty("--reading-inspector-height", paper.height + "px");
    };
    position();
    window.addEventListener("resize", position);
    return () => {
      window.removeEventListener("resize", position);
      if (element?.open) element.close();
    };
  }, [opened, reference]);

  useImperativeHandle(ref, () => ({ open }));

  const label = reference ? "本文管理与核验" : "更多阅读操作";
  return <>
    <button ref={trigger} type="button" className="reading-article-tools-trigger" aria-label={label} title={label} aria-haspopup="dialog" aria-expanded={opened} onClick={open}>{reference ? <ShieldCheck size={16} /> : <MoreHorizontal size={19} />}{reference && needsAttention && <span className="reading-inspector-warning" />}</button>
    {opened && createPortal(<dialog ref={dialog} className={"reading-article-tools-dialog"+(reference?" reading-reference-inspector":"")} aria-labelledby={titleId} onCancel={event => { event.preventDefault(); close(); }} onClose={close} onClick={event => { if (event.target === event.currentTarget) { const bounds = event.currentTarget.getBoundingClientRect(); if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) close(); } }}>
      <header><div><h2 id={titleId}>{reference ? <><ShieldCheck size={16}/>本文管理与核验</> : "本文管理"}</h2>{!reference && <p>离线内容、资料库副本与云端检查</p>}</div><button type="button" autoFocus aria-label="关闭本文管理" onClick={close}><X size={20} /></button></header>
      <div className="reading-article-tools-content">
        <ReadingOffline itemKey={itemKey} />
        <ReadingAttachments itemKey={itemKey} />
        <ReadingCopies itemKey={itemKey} />
        <ReadingRecovery itemKey={itemKey} revision={revision} />
        <ReadingSourceRecovery itemKey={itemKey} revision={revision} />
      </div>
    </dialog>, document.body)}
  </>;
}
