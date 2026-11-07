import type { FlashcardDeckSummary } from "./FlashcardTypes";

/** Lightweight deck metadata only. Each deck appears once, including orphaned
 * records received before their parents and malformed imported cycles. */
export function buildDeckHierarchy(decks: FlashcardDeckSummary[]) {
  const byId = new Map(decks.map(deck => [deck.id, deck]));
  const parentById = new Map(decks.map(deck => [deck.id, byId.has(deck.parentDeckId ?? "") ? deck.parentDeckId! : ""]));
  const done = new Set<string>();
  for (const deck of decks) {
    const path: string[] = [], positions = new Map<string, number>();
    let id = deck.id;
    while (id && !done.has(id)) {
      const position = positions.get(id);
      if (position !== undefined) {
        const root = path.slice(position).sort()[0];
        parentById.set(root, "");
        break;
      }
      positions.set(id, path.length); path.push(id);
      id = parentById.get(id) ?? "";
    }
    path.forEach(id => done.add(id));
  }
  const children = new Map<string, FlashcardDeckSummary[]>();
  for (const deck of decks) {
    const parent = parentById.get(deck.id)!;
    const siblings = children.get(parent) ?? [];
    siblings.push(deck); children.set(parent, siblings);
  }
  for (const siblings of children.values()) siblings.sort((a,b) => (a.sortOrder ?? 0)-(b.sortOrder ?? 0) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  const rootsByFolder = new Map<string, FlashcardDeckSummary[]>();
  for (const root of children.get("") ?? []) {
    const folder = root.folderId ?? "";
    const roots = rootsByFolder.get(folder) ?? [];
    roots.push(root); rootsByFolder.set(folder, roots);
  }
  const decksByFolder = new Map<string, FlashcardDeckSummary[]>();
  for (const [folder, roots] of rootsByFolder) {
    const group: FlashcardDeckSummary[] = [], pending = [...roots];
    while (pending.length) {
      const deck = pending.pop()!; group.push(deck);
      for (const child of children.get(deck.id) ?? []) pending.push(child);
    }
    decksByFolder.set(folder, group);
  }
  function matching(search: string): Set<string> {
    const query = search.trim().toLocaleLowerCase(), ids = new Set<string>();
    if (!query) return ids;
    for (const deck of decks) {
      if (!deck.name.toLocaleLowerCase().includes(query)) continue;
      let id = deck.id;
      while (id && !ids.has(id)) { ids.add(id); id = parentById.get(id) ?? ""; }
    }
    return ids;
  }
  function descendants(id: string): Set<string> {
    const ids = new Set<string>(), pending = [id];
    while (pending.length) {
      const next = pending.pop()!;
      if (ids.has(next)) continue;
      ids.add(next);
      for (const child of children.get(next) ?? []) pending.push(child.id);
    }
    return ids;
  }
  function scopeCounts(id: string, includeSubdecks: boolean) {
    const counts = { cardCount: 0, dueCount: 0, newCount: 0, suspendedCount: 0 };
    const ids = includeSubdecks ? descendants(id) : [id];
    for (const member of ids) {
      const deck = byId.get(member);
      if (!deck) continue;
      counts.cardCount += deck.cardCount;
      counts.dueCount += deck.dueCount;
      counts.newCount += deck.newCount;
      counts.suspendedCount += deck.suspendedCount ?? 0;
    }
    return counts;
  }
  return { byId, parentById, children, rootsByFolder, decksByFolder, descendants, matching, scopeCounts };
}
