import { userProfileStorage } from "./UserProfileStorage";
export type DeckDatabaseView = "table" | "grid" | "list" | "column";
export type CardLayout = "compact" | "comfortable" | "spacious";
export type GalleryCoverMode = "fit" | "crop";
export type CardPropertyKey = "answer" | "explanation" | "type" | "status" | "deck" | "sourceTitle" | "sourcePath" | "tags" | "confidence" | "media";
export type CardFieldKey = CardPropertyKey | `custom:${string}`;
export type CardColorOperator = "equals" | "contains" | "not_contains" | "is_empty" | "is_not_empty";
export type CardColorName = "gray" | "blue" | "green" | "yellow" | "orange" | "red" | "purple";
export type CardColorRule = { id: string; field: CardFieldKey; operator: CardColorOperator; value: string; color: CardColorName };
export type DeckViewConfig = { id: string; name: string; type: DeckDatabaseView; showAll: boolean; showSubdecks?: boolean; showCustomFields: boolean; hiddenProperties?: string[]; cardLayout?: CardLayout; colorRules?: CardColorRule[]; columnWidths?: Record<string, number>; columnOrder?: string[]; galleryImageCover?: boolean; galleryCoverMode?: GalleryCoverMode; galleryWrapContent?: boolean; galleryShowPropertyNames?: boolean; galleryShowFullTitle?: boolean; galleryCompactHiddenProperties?: boolean };

export const DECK_VIEW_STORAGE_KEY = "hub.flashcards.deck-database-views";
export const DECK_SAVED_VIEWS_STORAGE_KEY = "hub.flashcards.saved-deck-views-v1";
export const DECK_ACTIVE_VIEW_STORAGE_KEY = "hub.flashcards.active-deck-view-v1";
export const DECK_VIEW_DEFAULT_NAMES: Record<DeckDatabaseView, string> = { table: "表格", column: "看板", grid: "画廊", list: "列表" };
export const LEGACY_DECK_VIEW_NAMES: Record<DeckDatabaseView, string> = { table: "表格视图", column: "看板视图", grid: "画廊视图", list: "列表视图" };

const DECK_VIEW_TYPES: DeckDatabaseView[] = ["table", "grid", "list", "column"];
const CARD_LAYOUTS: CardLayout[] = ["compact", "comfortable", "spacious"];

function storedRecord(key: string): Record<string, unknown> {
  try {
    const value = JSON.parse(userProfileStorage.getItem(key) ?? "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

function saveRecordValue(key: string, id: string, value: unknown): void {
  if (!id) return;
  try {
    userProfileStorage.setItem(key, JSON.stringify({ ...storedRecord(key), [id]: value }));
  } catch {
    // The selected view remains available for this session when storage is unavailable.
  }
}

function deckViewType(value: unknown): DeckDatabaseView {
  return DECK_VIEW_TYPES.includes(value as DeckDatabaseView) ? value as DeckDatabaseView : "table";
}

export function defaultDeckView(type: DeckDatabaseView): DeckViewConfig {
  return {
    id: "default",
    name: DECK_VIEW_DEFAULT_NAMES[type],
    type,
    showAll: true,
    showSubdecks: false,
    showCustomFields: true,
    hiddenProperties: [],
    cardLayout: "comfortable",
    colorRules: [],
    columnWidths: {},
    columnOrder: [],
    galleryImageCover: true,
    galleryCoverMode: "crop",
    galleryWrapContent: false,
    galleryShowPropertyNames: true,
    galleryShowFullTitle: false,
    galleryCompactHiddenProperties: true,
  };
}

export function loadDeckViewType(deckId: string): DeckDatabaseView {
  if (!deckId) return "table";
  return deckViewType(storedRecord(DECK_VIEW_STORAGE_KEY)[deckId]);
}

export function loadDeckViews(deckId: string): DeckViewConfig[] {
  if (!deckId) return [];
  const stored = storedRecord(DECK_SAVED_VIEWS_STORAGE_KEY)[deckId];
  if (Array.isArray(stored) && stored.length) {
    const views = stored.flatMap((candidate, index): DeckViewConfig[] => {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return [];
      const view = candidate as Record<string, unknown>;
      const supportedView = view;
      const type = deckViewType(view.type);
      const fallback = defaultDeckView(type);
      const storedName = typeof view.name === "string" && view.name.trim() ? view.name : fallback.name;
      return [{
        ...fallback,
        ...supportedView,
        id: typeof view.id === "string" && view.id.trim() ? view.id : `view-${index + 1}`,
        name: LEGACY_DECK_VIEW_NAMES[type] === storedName ? DECK_VIEW_DEFAULT_NAMES[type] : storedName,
        type,
        showSubdecks: typeof view.showSubdecks === "boolean" ? view.showSubdecks : false,
        showAll: typeof view.showAll === "boolean" ? view.showAll : fallback.showAll,
        showCustomFields: typeof view.showCustomFields === "boolean" ? view.showCustomFields : fallback.showCustomFields,
        hiddenProperties: Array.isArray(view.hiddenProperties) ? view.hiddenProperties.filter((key): key is string => typeof key === "string") : [],
        cardLayout: CARD_LAYOUTS.includes(view.cardLayout as CardLayout) ? view.cardLayout as CardLayout : fallback.cardLayout,
        colorRules: Array.isArray(view.colorRules) ? view.colorRules as CardColorRule[] : [],
        columnWidths: view.columnWidths && typeof view.columnWidths === "object" && !Array.isArray(view.columnWidths) ? view.columnWidths as Record<string, number> : {},
        columnOrder: Array.isArray(view.columnOrder) ? view.columnOrder.filter((key): key is string => typeof key === "string") : [],
        galleryImageCover: typeof view.galleryImageCover === "boolean" ? view.galleryImageCover : true,
        galleryCoverMode: view.galleryCoverMode === "fit" ? "fit" : "crop",
        galleryWrapContent: typeof view.galleryWrapContent === "boolean" ? view.galleryWrapContent : false,
        galleryShowPropertyNames: typeof view.galleryShowPropertyNames === "boolean" ? view.galleryShowPropertyNames : true,
        galleryShowFullTitle: typeof view.galleryShowFullTitle === "boolean" ? view.galleryShowFullTitle : false,
        galleryCompactHiddenProperties: typeof view.galleryCompactHiddenProperties === "boolean" ? view.galleryCompactHiddenProperties : true,
      }];
    });
    if (views.length) return views;
  }
  return [defaultDeckView(loadDeckViewType(deckId))];
}

export function loadActiveDeckViewId(deckId: string, views: DeckViewConfig[]): string {
  const stored = storedRecord(DECK_ACTIVE_VIEW_STORAGE_KEY)[deckId];
  return typeof stored === "string" && views.some((view) => view.id === stored) ? stored : views[0]?.id ?? "default";
}

export function saveDeckViewType(deckId: string, view: DeckDatabaseView): void {
  saveRecordValue(DECK_VIEW_STORAGE_KEY, deckId, view);
}

export function saveDeckViews(deckId: string, views: DeckViewConfig[]): void {
  saveRecordValue(DECK_SAVED_VIEWS_STORAGE_KEY, deckId, views);
}

export function saveActiveDeckViewId(deckId: string, viewId: string): void {
  saveRecordValue(DECK_ACTIVE_VIEW_STORAGE_KEY, deckId, viewId);
}
