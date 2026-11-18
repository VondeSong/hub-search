import type { ReactNode } from "react";
import "./CloudMarkdownTable.css";

export function CloudMarkdownTable({ children }: { children?: ReactNode }) {
  return <div className="cloud-markdown-table" role="region" aria-label="表格，可横向滚动" tabIndex={0}>
    <table>{children}</table>
  </div>;
}
