import { userProfileStorage } from "./UserProfileStorage";
import { useEffect, useMemo, useState, type ReactNode, type MouseEvent } from "react";
import { ChevronDown, ChevronRight, MoreHorizontal } from "lucide-react";
import type { FlashcardDeckSummary } from "./FlashcardTypes";
import { buildDeckHierarchy } from "./FlashcardDeckHierarchy";

const EXPANSION_KEY = "hub.flashcards.subdeck-expansion-v1";
type Props = {
  decks: FlashcardDeckSummary[]; folderId: string; selectedDeckId: string; search: string;
  hierarchy?: ReturnType<typeof buildDeckHierarchy>;
  matchingIds?: ReadonlySet<string>;
  onMenu?: (event:MouseEvent,deck:FlashcardDeckSummary)=>void;
  renderRow: (deck: FlashcardDeckSummary, nested: boolean) => ReactNode;
};

/** Owns tree projection, expansion persistence and reveal/search behavior. */
export function FlashcardDeckTree({ decks, folderId, selectedDeckId, search, renderRow, hierarchy, onMenu, matchingIds }: Props) {
  const tree = useMemo(() => hierarchy ?? buildDeckHierarchy(decks), [decks, hierarchy]);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    try { const value: unknown = JSON.parse(userProfileStorage.getItem(`${EXPANSION_KEY}.${folderId}`) ?? "[]"); return new Set(Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []); }
    catch { return new Set(); }
  });
  useEffect(() => {
    const parents = new Set<string>();
    let parent = tree.parentById.get(selectedDeckId) ?? "";
    while (parent && !parents.has(parent)) { parents.add(parent); parent = tree.parentById.get(parent) ?? ""; }
    setCollapsed(current => {
      if (![...parents].some(id => current.has(id))) return current;
      const next = new Set(current); parents.forEach(id => next.delete(id)); return next;
    });
  }, [selectedDeckId, tree]);
  const query = search.trim().toLocaleLowerCase();
  const matching = useMemo(() => matchingIds ?? tree.matching(query), [matchingIds, query, tree]);
  const toggle = (id: string) => setCollapsed(current => {
    const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id);
    try { userProfileStorage.setItem(`${EXPANSION_KEY}.${folderId}`, JSON.stringify([...next])); } catch { /* Session remains usable. */ }
    return next;
  });
  const visible: Array<{deck:FlashcardDeckSummary;depth:number}> = [];
  const pending = (tree.rootsByFolder.get(folderId) ?? []).map(deck => ({deck,depth:0})).reverse();
  while (pending.length) {
    const item = pending.pop()!;
    if (query && !matching.has(item.deck.id)) continue;
    visible.push(item);
    if (query || !collapsed.has(item.deck.id)) {
      const children = tree.children.get(item.deck.id) ?? [];
      for (let index=children.length-1; index>=0; index--) pending.push({deck:children[index],depth:item.depth+1});
    }
  }
  return <>{visible.map(({deck,depth}) => {
    const children = tree.children.get(deck.id) ?? [];
    const expanded = Boolean(query) || !collapsed.has(deck.id);
    return <div className="flashcards-subdeck-row" style={{ paddingLeft: Math.min(depth, 12) * 14 }} key={deck.id}>
        {children.length > 0 && <button type="button" className="flashcards-subdeck-toggle" style={{left:Math.min(depth,12)*14-16}} aria-label={`${expanded ? "收起" : "展开"}子牌组：${deck.name}`} aria-expanded={expanded} onClick={() => toggle(deck.id)}>{expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}</button>}
        {renderRow(deck, depth > 0 || Boolean(folderId))}
        {onMenu && <button type="button" className="flashcards-subdeck-actions" aria-label={`牌组操作：${deck.name}`} onClick={event => onMenu(event,deck)}><MoreHorizontal size={14}/></button>}
    </div>;
  })}</>;
}
