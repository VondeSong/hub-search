// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";
import {
  DECK_ACTIVE_VIEW_STORAGE_KEY,
  DECK_SAVED_VIEWS_STORAGE_KEY,
  DECK_VIEW_STORAGE_KEY,
  loadActiveDeckViewId,
  loadDeckViews,
  loadDeckViewType,
  saveActiveDeckViewId,
  saveDeckViews,
  saveDeckViewType,
} from "./FlashcardDeckViews";

describe("flashcard deck view persistence", () => {
  beforeEach(() => localStorage.clear());

  it("migrates legacy names and fills properties introduced by newer versions", () => {
    localStorage.setItem(DECK_SAVED_VIEWS_STORAGE_KEY, JSON.stringify({
      deck: [{ id: "legacy", name: "画廊视图", type: "grid", showAll: false, columnOrder: ["question", 7] }],
    }));

    const [view] = loadDeckViews("deck");
    expect(view.name).toBe("画廊");
    expect(view.showAll).toBe(false);
    expect(view.cardLayout).toBe("comfortable");
    expect(view.columnOrder).toEqual(["question"]);
    expect(view.galleryCoverMode).toBe("crop");
  });

  it("falls back safely when storage contains malformed data", () => {
    localStorage.setItem(DECK_VIEW_STORAGE_KEY, "not-json");
    localStorage.setItem(DECK_SAVED_VIEWS_STORAGE_KEY, JSON.stringify({ deck: [null, 3] }));

    expect(loadDeckViewType("deck")).toBe("table");
    expect(loadDeckViews("deck")).toEqual([expect.objectContaining({ id: "default", type: "table", name: "表格" })]);
  });

  it("preserves other decks while saving view and active selection", () => {
    localStorage.setItem(DECK_VIEW_STORAGE_KEY, JSON.stringify({ other: "column" }));
    const views = loadDeckViews("deck");
    saveDeckViewType("deck", "grid");
    saveDeckViews("deck", views);
    saveActiveDeckViewId("deck", "default");

    expect(JSON.parse(localStorage.getItem(DECK_VIEW_STORAGE_KEY) ?? "{}")).toEqual({ other: "column", deck: "grid" });
    expect(loadActiveDeckViewId("deck", views)).toBe("default");
    expect(JSON.parse(localStorage.getItem(DECK_ACTIVE_VIEW_STORAGE_KEY) ?? "{}").deck).toBe("default");
  });

  it("preserves supported subdeck scopes alongside other saved view options", () => {
    localStorage.setItem(DECK_SAVED_VIEWS_STORAGE_KEY, JSON.stringify({ deck: [{ id: "legacy", name: "My view", type: "column", showSubdecks: true, showAll: false }] }));
    const views = loadDeckViews("deck");
    expect(views[0].showSubdecks).toBe(true);
    expect(views[0].showAll).toBe(false);
    expect(views[0].type).toBe("column");
    saveDeckViews("deck", views);
    expect(JSON.parse(localStorage.getItem(DECK_SAVED_VIEWS_STORAGE_KEY)!).deck[0].showSubdecks).toBe(true);
  });
});
