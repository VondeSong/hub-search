import { BookOpenCheck, ChevronLeft, Filter, LoaderCircle, PanelRight } from "lucide-react";
import type { Dispatch, SetStateAction } from "react";
import { StandaloneAgentLauncher } from "./StandaloneAgentLauncher";
import { CloudAgentsLauncher } from "./CloudAgentsLauncher";

type SearchHeaderActionsProps = {
  showAgent?: boolean;
  hidePreviewToggle?: boolean;
  activeFilterCount: number;
  filtersOpen: boolean;
  hasSelectedResult: boolean;
  isMobileLayout: boolean;
  mobilePreviewOpen: boolean;
  searching: boolean;
  showPreviewPane: boolean;
  flashcardsActive?: boolean;
  onOpenFlashcards?: () => void;
  setFiltersOpen: Dispatch<SetStateAction<boolean>>;
  setMobilePreviewOpen: Dispatch<SetStateAction<boolean>>;
  setPreviewOpen: Dispatch<SetStateAction<boolean>>;
};

export function SearchHeaderActions({
  showAgent = true,
  hidePreviewToggle = false,
  activeFilterCount,
  filtersOpen,
  hasSelectedResult,
  isMobileLayout,
  mobilePreviewOpen,
  searching,
  showPreviewPane,
  flashcardsActive = false,
  onOpenFlashcards,
  setFiltersOpen,
  setMobilePreviewOpen,
  setPreviewOpen,
}: SearchHeaderActionsProps) {
  return (
    <div className="search-header-actions">
      {!isMobileLayout && showAgent && <><StandaloneAgentLauncher /><CloudAgentsLauncher /></>}
      {searching && <LoaderCircle className="spin muted" size={20} />}
      {!isMobileLayout && onOpenFlashcards && <button
        className={`icon-button flashcards-toggle ${flashcardsActive ? "active" : ""}`}
        title="打开闪卡复习"
        aria-label="打开闪卡复习"
        onClick={onOpenFlashcards}
      ><BookOpenCheck size={21} /></button>}
      {!isMobileLayout && !hidePreviewToggle && <button
        className={`icon-button preview-toggle ${showPreviewPane ? "active" : ""}`}
        title={isMobileLayout ? (mobilePreviewOpen ? "返回结果列表" : "打开预览") : "显示预览窗格"}
        onClick={() => {
          if (isMobileLayout) {
            if (!hasSelectedResult) return;
            setPreviewOpen(true);
            setMobilePreviewOpen((open) => !open);
          } else {
            setPreviewOpen((value) => !value);
          }
        }}
      >
        {isMobileLayout && mobilePreviewOpen ? <ChevronLeft size={22} /> : <PanelRight size={22} />}
      </button>}
      <button
        className={`icon-button filter-toggle ${filtersOpen ? "active filled" : ""} ${activeFilterCount > 0 ? "has-filters" : ""}`}
        title={filtersOpen ? "收起筛选" : activeFilterCount > 0 ? `展开筛选（${activeFilterCount} 项已生效）` : "展开筛选"}
        aria-label={filtersOpen ? "收起筛选" : "展开筛选"}
        aria-expanded={filtersOpen}
        onClick={() => setFiltersOpen((value) => !value)}
      >
        <Filter size={21} />
        {activeFilterCount > 0 && <span className="filter-count" aria-label={`${activeFilterCount} 项筛选已生效`}>{activeFilterCount}</span>}
      </button>
    </div>
  );
}
