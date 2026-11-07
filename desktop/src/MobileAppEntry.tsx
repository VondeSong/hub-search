import type { CSSProperties } from "react";
import { useMobileViewport } from "./useMobileViewport";
import type { AppEntryProps } from "./AppEntryTypes";

export function MobileAppEntry({ children, filtersOpen, previewOpen, style }: AppEntryProps) {
  const { height, keyboardOpen } = useMobileViewport();
  return (
    <main
      className={`app-shell mobile-app-shell ${keyboardOpen ? "mobile-keyboard-open" : ""} ${filtersOpen ? "filters-open" : ""} ${previewOpen ? "mobile-preview-open" : ""}`}
      style={{ ...style, "--mobile-viewport-height": `${height}px` } as CSSProperties}
    >
      {children}
    </main>
  );
}
