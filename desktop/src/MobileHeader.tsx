import { ChevronLeft, Cloud, SlidersHorizontal } from "lucide-react";
import { JournalCaptureButton } from "./JournalVoice";
import { useState, type ReactNode } from "react";
import { MobileSpaceMenu, type MobileSpaceActions } from "./MobileSpaceMenu";

export function MobileHeader({ title, onBack, onSettings, onAgents, children, spaceActions }: { title?: string; onBack?: () => void; onSettings: () => void; onAgents?: () => void; children?: ReactNode; spaceActions?: MobileSpaceActions }) {
  const [spaceOpen, setSpaceOpen] = useState(false);
  return <><header className={`mobile-hub-header${onBack ? " is-secondary" : ""}`}>
    {onBack && <button type="button" aria-label="返回浏览" onClick={onBack}><ChevronLeft size={22} /></button>}
    <h1 className="mobile-hub-page-title">{title || "Hub"}</h1>
    <div className="mobile-hub-actions">{!onBack && spaceActions && <button className="bw-connection" onClick={spaceActions.onConnections}><i/><i/>连接</button>}{!onBack && <button type="button" aria-label={spaceActions ? "空间与设置" : "设置"} aria-haspopup={spaceActions ? "dialog" : undefined} aria-expanded={spaceActions ? spaceOpen : undefined} onClick={spaceActions ? () => setSpaceOpen(true) : onSettings}><SlidersHorizontal size={17} /></button>}{onAgents && <button type="button" aria-label="助手" onClick={onAgents}><Cloud size={21} /></button>}{children}{!onBack && title!=="复习" && <span className="bw-fab"><JournalCaptureButton label="快速记录" size={14}/></span>}</div>
  </header>{spaceOpen && spaceActions && <MobileSpaceMenu {...spaceActions} onSettings={onSettings} onClose={() => setSpaceOpen(false)} />}</>;
}
