export type SaveShortcutEvent = Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey">;

export function isEditorSaveShortcut(event: SaveShortcutEvent): boolean {
  return event.key.toLowerCase() === "s"
    && (event.ctrlKey || event.metaKey)
    && !event.altKey
    && !event.shiftKey;
}
