// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const { providerName } = vi.hoisted(() => ({
  providerName: vi.fn(() => "Craft"),
}));

vi.mock("./ProviderLabels", () => ({ providerName }));

import { LibraryIcon } from "./LibraryIcon";

const containers: HTMLElement[] = [];

afterEach(() => {
  containers.splice(0).forEach((container) => container.remove());
  providerName.mockClear();
});

describe("LibraryIcon memoization", () => {
  it("skips equivalent parent updates and reacts to visible prop changes", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    containers.push(container);
    const root = createRoot(container);

    await act(async () => root.render(<LibraryIcon provider="craft" name="Car" compact />));
    expect(providerName).toHaveBeenCalledTimes(1);

    await act(async () => root.render(<LibraryIcon provider="craft" name="Car" compact />));
    expect(providerName).toHaveBeenCalledTimes(1);

    await act(async () => root.render(<LibraryIcon provider="craft" name="Main" compact />));
    expect(providerName).toHaveBeenCalledTimes(2);
    expect(container.querySelector(".library-icon")?.getAttribute("title")).toBe("Main · Craft");
    const image = container.querySelector<HTMLImageElement>(".library-icon img")!;
    const contextMenu = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    expect(image.draggable).toBe(false);
    expect(image.dispatchEvent(contextMenu)).toBe(false);
    expect(contextMenu.defaultPrevented).toBe(true);

    await act(async () => root.unmount());
  });
});
