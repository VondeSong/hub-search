import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { MoreHorizontal, X } from "lucide-react";
import { ReadingAttachments } from "./ReadingAttachments";
import { ReadingCopies } from "./ReadingCopies";
import { ReadingOffline } from "./ReadingOffline";
import { ReadingRecovery } from "./ReadingRecovery";
import { ReadingSourceRecovery } from "./ReadingSourceRecovery";
import { runtimeCapabilities } from "./RuntimePlatform";
import "./ReadingArticleTools.css";

type Props = { itemKey: string; revision: string };

// Changing articles closes the tools and releases their status polling.
export function ReadingArticleTools(props: Props) {
  return <ArticleTools key={props.itemKey} {...props} />;
}

function ArticleTools({ itemKey, revision }: Props) {
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
    return () => { if (element?.open) element.close(); };
  }, [opened]);

  return <>
    <button ref={trigger} type="button" className="reading-article-tools-trigger" aria-label="更多阅读操作" title="更多阅读操作" aria-haspopup="dialog" aria-expanded={opened} onClick={open}><MoreHorizontal size={19} /></button>
    {opened && createPortal(<dialog ref={dialog} className="reading-article-tools-dialog" aria-labelledby={titleId} onCancel={event => { event.preventDefault(); close(); }} onClose={close} onClick={event => { if (event.target === event.currentTarget) { const bounds = event.currentTarget.getBoundingClientRect(); if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) close(); } }}>
      <header><div><h2 id={titleId}>本文管理</h2><p>离线内容、资料库副本与云端检查</p></div><button type="button" autoFocus aria-label="关闭本文管理" onClick={close}><X size={20} /></button></header>
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
