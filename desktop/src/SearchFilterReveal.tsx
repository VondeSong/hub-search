import type { ReactNode } from "react";

/** Keep the same controls mounted so reversing the disclosure never resets filters. */
export function SearchFilterReveal({ open, children }: { open: boolean; children: ReactNode }) {
  return <div className={`search-filter-reveal${open ? " is-open" : ""}`} aria-hidden={!open} inert={!open}>
    <div className="search-filter-reveal-inner">{children}</div>
  </div>;
}
