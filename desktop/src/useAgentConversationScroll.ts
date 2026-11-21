import { useLayoutEffect, useRef, useState } from "react";

export function useAgentConversationScroll(open: boolean, workId: string | undefined, version: number | string | undefined) {
  const element = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const lastScrollTop = useRef(0);
  const [showLatest, setShowLatest] = useState(false);
  const awayFromLatest = () => {
    const node = element.current;
    return !!node && node.scrollHeight - Math.max(0, node.scrollTop) - node.clientHeight > 2;
  };
  const pinToLatest = () => {
    const node = element.current;
    if (!node) return;
    node.scrollTop = node.scrollHeight;
    lastScrollTop.current = node.scrollTop;
  };
  const syncPosition = () => {
    if (follow.current) pinToLatest();
    setShowLatest(awayFromLatest());
  };
  const scrollToLatest = () => {
    follow.current = true;
    setShowLatest(false);
    pinToLatest();
  };
  const jumpToLatest = () => {
    scrollToLatest();
    element.current?.focus({ preventScroll: true });
  };
  useLayoutEffect(() => { follow.current = true; setShowLatest(false); }, [workId]);
  useLayoutEffect(() => {
    if (!open || !element.current || !content.current) return;
    const pin = syncPosition;
    pin();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(pin);
    observer?.observe(content.current);
    observer?.observe(element.current);
    return () => observer?.disconnect();
  }, [open, workId]);
  useLayoutEffect(() => {
    if (open) syncPosition();
  }, [open, workId, version]);
  const onScroll = () => {
    const node = element.current;
    if (!node) return;
    const away = awayFromLatest();
    if (away) follow.current = false;
    // A shorter layout can move scrollTop backwards to the bottom by itself.
    else if (node.scrollTop > lastScrollTop.current) follow.current = true;
    lastScrollTop.current = node.scrollTop;
    setShowLatest(away);
  };
  const holdPosition = () => { follow.current = false; setShowLatest(awayFromLatest()); };
  return { element, content, showLatest, onScroll, scrollToLatest, jumpToLatest, holdPosition, isFollowing: () => follow.current };
}
