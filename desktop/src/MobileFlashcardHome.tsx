import { ChevronRight, Cloud, FolderOpen, Layers3 } from "lucide-react";
import type { ReactNode } from "react";
import type { FlashcardDeckSummary } from "./FlashcardTypes";

export type MobileFlashcardTab = "review" | "library" | "inbox";

export function MobileFlashcardIntro({ active, inboxCount, onSelect }: {
  active: MobileFlashcardTab; inboxCount: number; onSelect: (tab: MobileFlashcardTab) => void;
}) {
  return <header className="mobile-flashcard-intro">
    <h1>复习</h1><p>翻卡评分，也能回到牌库与收件箱。</p>
    <nav className="mobile-flashcard-tabs" aria-label="闪卡导航">
      {([["review", "今日"], ["library", "牌库"], ["inbox", `收件箱${inboxCount ? ` ${inboxCount}` : ""}`]] as const).map(([key, label]) =>
        <button type="button" key={key} aria-pressed={active === key} onClick={() => onSelect(key)}>{label}</button>)}
    </nav>
  </header>;
}

export function MobileFlashcardDecks({ title, decks, onOpen, today = false, continuing = false }: {
  title: string; decks: FlashcardDeckSummary[]; today?: boolean; continuing?: boolean;
  onOpen: (deck: FlashcardDeckSummary) => void;
}) {
  return <section className="mobile-flashcard-section">
    <h2>{title}</h2><div className="mobile-flashcard-group">
      {decks.map(deck => <button type="button" className="mobile-flashcard-row" key={deck.id} onClick={() => onOpen(deck)}
        title={today && continuing ? "继续当前一轮，不替换已有进度" : undefined}>
        <span className="mobile-flashcard-tile"><Layers3 size={18} aria-hidden="true" /></span>
        <span><strong>{deck.name}</strong><small>{!today && `${deck.cardCount} 张 · `}{deck.dueCount} 张待复习{today && continuing ? " · 继续当前一轮" : ""}</small></span>
        <ChevronRight size={17} aria-hidden="true" />
      </button>)}
      {!decks.length && <p className="mobile-flashcard-empty">{today ? "暂无到期牌组，可以到牌库浏览。" : "暂无牌组。"}</p>}
    </div>{today && <p className="mobile-flashcard-inbox-note">牌组数量包含等待安排的新卡，今日计划另受每日新卡额度限制。</p>}
  </section>;
}

export function MobileFlashcardManagement({ onBackup, onSync, children }: {
  onBackup: () => void; onSync: () => void; children?: ReactNode;
}) {
  return <section className="mobile-flashcard-section mobile-flashcard-management"><h2>管理</h2>
    <div className="mobile-flashcard-group">
      <button type="button" className="mobile-flashcard-row" onClick={onBackup} aria-label="闪卡备份与恢复">
        <span className="mobile-flashcard-tile"><FolderOpen size={18} aria-hidden="true" /></span>
        <span><strong>备份与恢复</strong><small>保存与恢复本机的闪卡和复习进度</small></span><ChevronRight size={17} aria-hidden="true" />
      </button>
      <button type="button" className="mobile-flashcard-row" onClick={onSync} aria-label="云同步设置">
        <span className="mobile-flashcard-tile"><Cloud size={18} aria-hidden="true" /></span>
        <span><strong>同步设置</strong><small>查看本设备闪卡同步范围</small></span><ChevronRight size={17} aria-hidden="true" />
      </button>
    </div>{children}
  </section>;
}

export function MobileFlashcardToday({ count, roundTotal, roundRemaining, label, disabled, onStart }: {
  count: number; roundTotal: number; roundRemaining: number; label: string; disabled: boolean; onStart: () => void;
}) {
  return <section className="mobile-flashcard-today" aria-label="今日复习进度">
    <div><h2>{count} 张待复习</h2><p>{roundTotal > 0 ? `本轮已完成 ${roundRemaining ? Math.max(0, roundTotal - roundRemaining) : 0} / ${roundTotal} 张` : "按自己的节奏开始一轮复习"}</p></div>
    <button type="button" className="mobile-flashcard-primary" disabled={disabled} onClick={onStart}><Layers3 size={16} aria-hidden="true" />{label}</button>
    {roundRemaining > 0 && <small>还剩 {roundRemaining} 张，进度已保存在本机。</small>}
  </section>;
}
