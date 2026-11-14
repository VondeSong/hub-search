export const OPEN_QUICK_JOURNAL = "hub:open-quick-journal";
export const QUICK_JOURNAL_UPDATED = "hub:quick-journal-updated";

export function openQuickJournalCapture() {
  window.dispatchEvent(new CustomEvent(OPEN_QUICK_JOURNAL));
}
