import { useLayoutEffect, useRef, useState } from "react";

export function useAgentConversationScroll(open: boolean, workId: string | undefined, version: number | string | undefined) {
  const element = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const [showLatest, setShowLatest] = useState(false);
  const awayFromLatest = () => {
    const node = element.current;
    return !!node && node.scrollHeight - Math.max(0, node.scrollTop) - node.clientHeight >= 80;
  };
  const syncPosition = () => {
    if (follow.current && element.current) element.current.scrollTop = element.current.scrollHeight;
    const away = awayFromLatest();
    if (!away) follow.current = true;
    setShowLatest(away);
  };
  const scrollToLatest = () => {
    follow.current = true;
    setShowLatest(false);
    if (element.current) element.current.scrollTop = element.current.scrollHeight;
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
    follow.current = !awayFromLatest();
    setShowLatest(!follow.current);
  };
  const holdPosition = () => { follow.current = false; setShowLatest(awayFromLatest()); };
  return { element, content, showLatest, onScroll, scrollToLatest, holdPosition, isFollowing: () => follow.current };
}
