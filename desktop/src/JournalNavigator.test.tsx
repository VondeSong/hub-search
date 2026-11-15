// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JournalNavigator } from "./JournalNavigator";

let container: HTMLDivElement;
let root: Root;
const onSelect = vi.fn();
function Fixture({ initial = "" }) {
  const [selected, setSelected] = useState(initial);
  return <JournalNavigator availableDates={[{ date: "2026-10-07", sources: 3 }, { date: "2026-10-06", sources: 2 }, { date: "2024-02-29", sources: 1 }]}
    selectedDate={selected} onSelectDate={date => { setSelected(date); onSelect(date); }} />;
}
async function click(selector: string) {
  await act(async () => container.querySelector<HTMLButtonElement>(selector)!.click());
}
async function key(selector: string, value: string) {
  await act(async () => {
    const button = container.querySelector<HTMLButtonElement>(selector)!;
    button.focus();
    button.dispatchEvent(new KeyboardEvent("keydown", { key: value, bubbles: true }));
  });
}
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 9, 13, 12));
  onSelect.mockReset();
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); });

describe("Journal calendar navigation", () => {
  it("marks today and recorded days independently from the selected date, with one grid tab stop", async () => {
    await act(async () => root.render(<Fixture />));
    expect(container.querySelector('[data-date="2026-10-13"]')?.getAttribute("aria-current")).toBe("date");
    expect(container.querySelector('[data-date="2026-10-07"]')?.getAttribute("aria-label")).toContain("3个资料库");
    expect(container.querySelectorAll('.journal-date[tabindex="0"]')).toHaveLength(1);
    await click('[data-date="2026-10-07"]');
    await click('[data-date="2026-10-07"]');
    expect(onSelect).toHaveBeenLastCalledWith("2026-10-07");
    expect(container.querySelector('[aria-selected="true"] .journal-date')?.getAttribute("data-date")).toBe("2026-10-07");
  });
  it("browses across a year without changing the active filter, then applies the visible month", async () => {
    await act(async () => root.render(<Fixture initial="2026-12-31" />));
    await click('[aria-label="下个月"]');
    expect(container.querySelector('[role="grid"]')?.getAttribute("aria-label")).toBe("2027年1月");
    expect(onSelect).not.toHaveBeenCalled();
    await click('.journal-month-label');
    expect(onSelect).not.toHaveBeenCalled();
    await click('.journal-period-picker button[type="submit"]');
    expect(onSelect).toHaveBeenLastCalledWith("2027-01");
    await click('.journal-today-button');
    expect(onSelect).toHaveBeenLastCalledWith("2026-10-13");
  });
  it("selects a leap-year month from its compact heading and keeps day selection reachable", async () => {
    await act(async () => root.render(<Fixture initial="2024-02-29" />));
    expect(container.querySelector('.journal-month-label strong')?.textContent).toBe("2024年2月");
    await click('.journal-month-label');
    await click('.journal-period-picker button[type="submit"]');
    expect(onSelect).toHaveBeenLastCalledWith("2024-02");
    expect(container.querySelector('[data-date="2024-02-29"]')).not.toBeNull();
    await click('[data-date="2024-02-29"]');
    expect(onSelect).toHaveBeenLastCalledWith("2024-02-29");
    expect(container.querySelectorAll('.journal-date[tabindex="0"]')).toHaveLength(1);
  });
  it("moves keyboard focus across months and clamps PageDown at the end of February", async () => {
    await act(async () => root.render(<Fixture initial="2024-01-31" />));
    await key('[data-date="2024-01-31"]', "PageDown");
    expect(document.activeElement?.getAttribute("data-date")).toBe("2024-02-29");
    expect(onSelect).not.toHaveBeenCalled();
    await key('[data-date="2024-02-29"]', "ArrowRight");
    expect(document.activeElement?.getAttribute("data-date")).toBe("2024-03-01");
    expect(container.querySelectorAll('.journal-date[tabindex="0"]')).toHaveLength(1);
  });
});
