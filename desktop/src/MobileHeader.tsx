import { ChevronLeft, Cloud, Plus, Settings } from "lucide-react";
import { openQuickJournalCapture } from "./QuickJournalEvents";
import type { ReactNode } from "react";

export function MobileHeader({ title, onBack, onSettings, onAgents, children }: { title?: string; onBack?: () => void; onSettings: () => void; onAgents?: () => void; children?: ReactNode }) {
  return <header className="mobile-hub-header">
    {onBack ? <button type="button" aria-label="返回浏览" onClick={onBack}><ChevronLeft size={22} /></button> : <span className="mobile-hub-brand"><span aria-hidden="true">H</span>{!title&&"Hub"}</span>}
    {title && <span className="mobile-hub-page-title">{title}</span>}
    <div className="mobile-hub-actions"><button type="button" aria-label="设置" onClick={onSettings}><Settings size={21} /></button>{onAgents && <button type="button" aria-label="Agents" onClick={onAgents}><Cloud size={21} /></button>}{children}<button type="button" aria-label="快速记录" onClick={openQuickJournalCapture}><Plus size={23} /></button></div>
  </header>;
}
