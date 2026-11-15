// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MobileFlashcardDecks, MobileFlashcardIntro, MobileFlashcardManagement, MobileFlashcardToday } from "./MobileFlashcardHome";

let host: HTMLDivElement, root: Root;
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

it("keeps the three review tabs in the page and navigates without starting a review", async () => {
  const select = vi.fn();
  await act(async () => root.render(<MobileFlashcardIntro active="review" inboxCount={77} onSelect={select} />));
  expect(host.querySelector("h1")?.textContent).toBe("复习");
  const tabs = host.querySelectorAll<HTMLButtonElement>("nav button");
  expect(tabs[0].getAttribute("aria-pressed")).toBe("true");
  await act(async () => tabs[1].click());
  expect(select).toHaveBeenCalledWith("library");
  expect(tabs[2].textContent).toBe("收件箱 77");
});

it("distinguishes the real daily total from the existing round and resumes once", async () => {
  const start = vi.fn();
  await act(async () => root.render(<MobileFlashcardToday count={96} roundTotal={8} roundRemaining={4} label="继续复习" disabled={false} onStart={start} />));
  expect(host.textContent).toContain("96 张待复习");
  expect(host.textContent).toContain("本轮已完成 4 / 8 张");
  expect(host.textContent).toContain("还剩 4 张");
  await act(async () => host.querySelector<HTMLButtonElement>("button")!.click());
  expect(start).toHaveBeenCalledTimes(1);
});

it("opens the chosen real deck and explains how its count relates to daily limits", async () => {
  const deck = { id: "deck-1", name: "牌组", cardCount: 185, dueCount: 120, newCount: 100, updatedAt: 1 };
  const open = vi.fn();
  await act(async () => root.render(<MobileFlashcardDecks title="接着复习" decks={[deck]} today continuing onOpen={open} />));
  expect(host.textContent).toContain("120 张待复习");
  expect(host.textContent).toContain("今日计划另受每日新卡额度限制");
  await act(async () => host.querySelector<HTMLButtonElement>("button")!.click());
  expect(open).toHaveBeenCalledWith(deck);
});

it("uses the native backup and sync entry points", async () => {
  const backup = vi.fn(), sync = vi.fn();
  await act(async () => root.render(<MobileFlashcardManagement onBackup={backup} onSync={sync} />));
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="闪卡备份与恢复"]')!.click());
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="云同步设置"]')!.click());
  expect(backup).toHaveBeenCalledTimes(1); expect(sync).toHaveBeenCalledTimes(1);
});
