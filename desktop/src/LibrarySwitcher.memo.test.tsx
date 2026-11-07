// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LibrarySwitcher } from "./LibrarySwitcher";
import type { LibrarySummary } from "./SearchTypes";

function library(index: number): LibrarySummary {
  return {
    id: `library-${index}`,
    provider: "craft",
    name: `Library ${index}`,
    connected: true,
    documentCount: index,
    excludedPaths: [],
  };
}

const containers: HTMLElement[] = [];

afterEach(() => {
  containers.splice(0).forEach((container) => container.remove());
});

describe("LibrarySwitcher memoization", () => {
  it("skips unrelated parent updates and reacts to visible prop changes", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    containers.push(container);
    const root = createRoot(container);
    const spaces = [library(1), library(2)];
    const renderLibraryIcon = vi.fn((space: LibrarySummary) => <i>{space.name}</i>);
    const props = {
      activeSpaces: spaces,
      currentSpaceName: "已选 2 个资料库",
      selectedLibraryIds: spaces.map((space) => space.id),
      spaceMenuOpen: false,
      spaces,
      providerName: () => "Craft",
      providerUnavailableLabel: () => "不可用",
      renderLibraryIcon,
      setShowConnection: () => undefined,
      setSpaceMenuOpen: () => undefined,
      toggleAllLibraries: () => undefined,
      toggleLibrarySelection: () => undefined,
    };

    await act(async () => root.render(<LibrarySwitcher {...props} />));
    expect(renderLibraryIcon).toHaveBeenCalledTimes(2);

    await act(async () => root.render(<LibrarySwitcher {...props} />));
    expect(renderLibraryIcon).toHaveBeenCalledTimes(2);

    await act(async () => root.render(<LibrarySwitcher {...props} currentSpaceName="两个资料库" />));
    expect(renderLibraryIcon).toHaveBeenCalledTimes(4);
    expect(container.querySelector(".space-button")?.textContent).toContain("两个资料库");

    await act(async () => root.unmount());
  });
});
