import type { ReactNode } from "react";
import type { LibrarySummary } from "./SearchTypes";
import { providerUnavailableHint } from "./ProviderLabels";

export function LibraryStatusIcon({ space, children }: { space: LibrarySummary; children: ReactNode }) {
  return <span className={`library-status-icon${space.connected ? "" : " unavailable"}`} title={space.connected ? undefined : providerUnavailableHint(space.provider)}>
    {children}
    {!space.connected && <span className="library-status-badge" aria-label={providerUnavailableHint(space.provider)}>!</span>}
  </span>;
}
