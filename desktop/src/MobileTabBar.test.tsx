// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { Search, Layers3 } from "lucide-react";
import { expect, it, vi } from "vitest";
import { MobileTabBar } from "./MobileTabBar";

it("keeps each destination reachable and announces selection on both tab counts", async () => {
  const host = document.createElement("div");
  const root = createRoot(host);
  const onSelect = vi.fn();
  const items = [{ key: "search", label: "搜索", icon: Search }, { key: "library", label: "牌库", icon: Layers3, count: 120 }];
  try {
    await act(async () => root.render(<MobileTabBar items={items} active="search" label="主要导航" onSelect={onSelect} />));
    const buttons = host.querySelectorAll("button");
    expect(buttons[0].getAttribute("aria-current")).toBe("page");
    expect(buttons[1].getAttribute("aria-current")).toBeNull();
    expect(buttons[1].getAttribute("aria-label")).toBe("牌库");
    expect(buttons[1].querySelector("small")?.textContent).toBe("99+");
    await act(async () => buttons[1].click());
    expect(onSelect).toHaveBeenCalledWith("library");
    await act(async () => root.render(<MobileTabBar items={items} active="library" label="闪卡导航" onSelect={onSelect} className="flashcards-mobile-nav" />));
    expect(host.querySelector("button[aria-current='page']")?.getAttribute("aria-label")).toBe("牌库");
    expect(host.querySelector("nav")?.getAttribute("aria-label")).toBe("闪卡导航");
  } finally { await act(async () => root.unmount()); }
});
