// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultJournalView, JOURNAL_VIEWS_KEY, journalMonthDays, localJournalDate, normalizeJournalView, parseJournalViews, shiftJournalDay, useJournalViewStore, type JournalViewStore } from "./JournalViews";

let host: HTMLDivElement, root: Root, store: JournalViewStore;
function Harness() { store = useJournalViewStore(); return null; }
const render = async () => { await act(async () => root.render(createElement(Harness))); };
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(2026, 9, 13, 12));
  localStorage.clear();
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.useRealTimers();
  delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

describe("date-only journal navigation", () => {
  it("keeps local today, Gregorian leap dates, century rules, and early years correct", () => {
    expect(localJournalDate()).toBe("2026-10-13");
    expect(shiftJournalDay("2024-02-28", 1)).toBe("2024-02-29");
    expect(shiftJournalDay("2024-02-29", 1)).toBe("2024-03-01");
    expect(shiftJournalDay("1900-02-28", 1)).toBe("1900-03-01");
    expect(shiftJournalDay("2000-02-28", 1)).toBe("2000-02-29");
    expect(shiftJournalDay("0099-12-31", 1)).toBe("0100-01-01");
    expect(shiftJournalDay("2011-12-29", 1)).toBe("2011-12-30");
    expect(journalMonthDays("0004-02")).toHaveLength(29);
    expect(shiftJournalDay("0001-01-01", -1)).toBe("");
    expect(shiftJournalDay("9999-12-31", 1)).toBe("");
  });
  it("returns complete Sunday-first five/six-week grids across month/year boundaries", () => {
    const october = journalMonthDays("2026-10", true);
    expect(october).toHaveLength(35); expect(october[0]).toBe("2026-09-27"); expect(october[october.length - 1]).toBe("2026-10-31");
    const august = journalMonthDays("2026-08", true);
    expect(august).toHaveLength(42); expect(august[0]).toBe("2026-07-26"); expect(august[august.length - 1]).toBe("2026-09-05");
    expect(journalMonthDays("2027-01", true)[0]).toBe("2026-12-27");
    expect(journalMonthDays("2024-02")).toHaveLength(29);
    expect(journalMonthDays("not-a-month")).toEqual([]);
  });
  it.each(["2026-02-29", "2026-04-31", "2026-00-12", "2026-13-01", "0000-01-01", "2026-1-01"])("rejects invalid persisted day %s and repairs day scope", day => {
    const view = normalizeJournalView({ day, period: "day" });
    expect(view.day).toBe(""); expect(view.period).toBe("month"); expect(shiftJournalDay(day, 1)).toBe("");
  });
});

describe("saved journal views", () => {
  it("validates layouts and normalizes unordered library membership without changing explicit empty scope", () => {
    expect(normalizeJournalView({ layout: "toString", month: "0000-10", compact: "yes", query: "x".repeat(800) }).layout).toBe("stream");
    expect(normalizeJournalView({ month: "0000-10" }).month).toBe("2026-10");
    expect(normalizeJournalView({ compact: "yes" }).compact).toBe(false);
    expect(normalizeJournalView({ query: "x".repeat(800) }).query).toHaveLength(500);
    expect(normalizeJournalView({ libraries: ["b", "a", "b", "", null] }).libraries).toEqual(["a", "b"]);
    expect(normalizeJournalView({ libraries: [] }).libraries).toEqual([]);
  });
  it("repairs malformed storage, duplicate identities, hidden selection, and unknown versions", () => {
    expect(parseJournalViews("{").saved).toEqual([]);
    expect(parseJournalViews(JSON.stringify({ version: 2, saved: [{ id: "a", name: "日志" }] })).saved).toEqual([]);
    const value = parseJournalViews(JSON.stringify({ version: 1, activeId: "hidden", anchor: "2026-10-07", saved: [
      { id: "a", name: "  工作  ", config: { libraries: ["b", "a"] } },
      { id: "a", name: "duplicate" }, { id: "", name: "invalid" },
      { id: "hidden", name: "个人", hidden: true }, { id: "b", name: " " },
    ] }));
    expect(value.saved.map(s => s.id)).toEqual(["a", "hidden"]); expect(value.saved[0].name).toBe("工作");
    expect(value.activeId).toBe(""); expect(value.anchor).toBe("");
  });
  it("persists pending edits, restores saved configuration, and explicitly updates or copies views", async () => {
    await render();
    await act(async () => { store.update({ libraries: ["b", "a"], summary: false }); store.save(" 工作日志 "); });
    const firstId = store.activeId;
    expect(store.active?.name).toBe("工作日志"); expect(store.modified).toBe(false);
    await act(async () => store.update({ libraries: ["a", "b", "a"] })); expect(store.modified).toBe(false);
    await act(async () => store.update({ layout: "table" })); expect(store.modified).toBe(true);
    const persisted = parseJournalViews(localStorage.getItem(JOURNAL_VIEWS_KEY));
    expect(persisted.activeId).toBe(firstId); expect(persisted.view.layout).toBe("table"); expect(persisted.saved[0].config.layout).toBe("stream");
    await act(async () => store.select(firstId)); expect(store.view.layout).toBe("stream"); expect(store.modified).toBe(false);
    await act(async () => { store.update({ layout: "table" }); store.updateSaved(); });
    expect(store.saved[0].config.layout).toBe("table"); expect(store.modified).toBe(false);
    await act(async () => store.save("工作日志副本")); expect(store.saved).toHaveLength(2); expect(store.activeId).not.toBe(firstId);
    await act(async () => store.update({ query: "new" })); expect(store.saved[0].config.query).toBe("");
  });
  it("navigates without narrowing all-scope, releases explicit day filtering, and never persists a scroll anchor", async () => {
    await render(); await act(async () => store.update({ period: "all", layout: "list" }));
    await act(async () => store.navigate("2024-02-29"));
    expect(store.view.period).toBe("all"); expect(store.view.month).toBe("2024-02"); expect(store.anchor).toBe("2024-02-29");
    expect(JSON.parse(localStorage.getItem(JOURNAL_VIEWS_KEY)!).anchor).toBeUndefined();
    await act(async () => store.update({ period: "day", day: "2024-02-29" }));
    await act(async () => store.navigate("2024-03-01")); expect(store.view.period).toBe("month"); expect(store.view.day).toBe("");
    await act(async () => store.navigate("2024-02-31")); expect(store.anchor).toBe("2024-03-01");
  });
  it("orders, renames, hides and removes only view definitions", async () => {
    await render(); await act(async () => { store.save("A"); store.save("B"); store.save("C"); });
    const [a, b, c] = store.saved.map(s => s.id);
    await act(async () => store.move(c, -1)); expect(store.saved.map(s => s.id)).toEqual([a, c, b]);
    await act(async () => { store.rename(a, "   renamed  "); store.hide(c, true); });
    expect(store.saved[0].name).toBe("renamed"); expect(store.activeId).toBe("");
    await act(async () => store.select(c)); expect(store.activeId).toBe("");
    await act(async () => { store.hide(c, false); store.select(c); }); expect(store.activeId).toBe(c);
    const view = store.view; await act(async () => store.remove(c)); expect(store.activeId).toBe(""); expect(store.view).toBe(view);
  });
  it("enforces the view limit even when many saves arrive in the same event", async () => {
    await render(); await act(async () => { for (let i = 0; i < 35; i++) store.save(`View ${i}`); });
    expect(store.saved).toHaveLength(30); expect(new Set(store.saved.map(s => s.id)).size).toBe(30);
  });
  it("keeps the navigator on the filtered date or month instead of an old anchor",async()=>{
    await render();await act(async()=>store.navigate("2026-11-16"));
    await act(async()=>store.update({month:"2026-09"}));expect(store.anchor).toBe("");expect(store.view.month).toBe("2026-09");
    await act(async()=>store.update({period:"day",day:"2024-02-29"}));expect(store.anchor).toBe("2024-02-29");expect(store.view.month).toBe("2024-02");
    await act(async()=>store.update({query:"正文"}));expect(store.anchor).toBe("2024-02-29");
  });
  it("remains usable when browser storage is unavailable", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("full"); });
    await render(); expect(store.view).toEqual(defaultJournalView());
    await act(async () => { store.update({ layout: "calendar" }); store.save("Calendar"); });
    expect(store.saved).toHaveLength(1); expect(store.view.layout).toBe("calendar");
  });
});
