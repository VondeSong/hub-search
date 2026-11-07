import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LibrarySwitcher } from "./LibrarySwitcher";
import type { LibrarySummary } from "./SearchTypes";

function library(index: number): LibrarySummary {
  return {
    id: `library-${index}`,
    provider: index % 2 ? "obsidian" : "craft",
    name: `Library ${index}`,
    connected: true,
    documentCount: index,
    excludedPaths: [],
  };
}

describe("LibrarySwitcher", () => {
  it("renders every selected library in the desktop avatar stack", () => {
    const spaces = Array.from({ length: 5 }, (_, index) => library(index + 1));
    const html = renderToStaticMarkup(
      <LibrarySwitcher
        activeSpaces={spaces}
        currentSpaceName="已选 5 个资料库"
        selectedLibraryIds={spaces.map((space) => space.id)}
        spaceMenuOpen={false}
        spaces={spaces}
        providerName={(provider) => provider}
        providerUnavailableLabel={() => "不可用"}
        renderLibraryIcon={(space) => <i data-library-icon={space.id} />}
        setShowConnection={() => undefined}
        setSpaceMenuOpen={() => undefined}
        toggleAllLibraries={() => undefined}
        toggleLibrarySelection={() => undefined}
      />,
    );

    expect(html.match(/data-library-icon=/g)).toHaveLength(5);
    expect(html).toContain("已选 5 个资料库");
  });
});
