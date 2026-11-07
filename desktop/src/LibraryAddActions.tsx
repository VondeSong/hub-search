import { LoaderCircle } from "lucide-react";
import { INHERIT_LIBRARY_POLICY, type LibraryAddOptions, type LibraryContentOverrides } from "./LibraryManagement";
import "./LibraryManagement.css";

export function LibraryAddActions({ busy, disabled = false, contentPolicy = INHERIT_LIBRARY_POLICY, onAdd, label = "添加", busyLabel = "正在添加…" }: {
  busy: boolean; disabled?: boolean; contentPolicy?: LibraryContentOverrides;
  onAdd: (options?: LibraryAddOptions) => void | Promise<void>; label?: string; busyLabel?: string;
}) {
  return <div className="library-add-actions">
    <button type="button" className="connect-button" disabled={busy || disabled} onClick={() => void onAdd({ startNow: true, contentPolicy })}>{busy ? <><LoaderCircle className="spin" size={16} />{busyLabel}</> : `${label}并开始处理`}</button>
    <button type="button" className="connect-button secondary" disabled={busy || disabled} onClick={() => void onAdd({ startNow: false, contentPolicy })}>{label}，稍后处理</button>
  </div>;
}
