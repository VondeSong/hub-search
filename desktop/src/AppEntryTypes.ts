import type { CSSProperties, ReactNode } from "react";

export type AppEntryProps = {
  children: ReactNode;
  filtersOpen: boolean;
  previewOpen?: boolean;
  style: CSSProperties;
  sidebarEnabled?: boolean;
  sidebarMode?: string;
  workspaceView?: string;
  sidebarDrawerOpen?: boolean;
};
