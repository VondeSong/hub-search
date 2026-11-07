type ShortcutKeyboardEvent = Pick<KeyboardEvent, "key" | "code" | "ctrlKey" | "altKey" | "shiftKey" | "metaKey">;

export function shortcutFromKeyboardEvent(event: ShortcutKeyboardEvent): string | null {
  if (["Control", "Alt", "Shift", "Meta"].includes(event.key)) return null;
  const modifiers = [
    event.ctrlKey ? "Ctrl" : "",
    event.altKey ? "Alt" : "",
    event.shiftKey ? "Shift" : "",
    event.metaKey ? "Super" : "",
  ].filter(Boolean);
  if (!modifiers.length && !/^F([1-9]|1[0-9]|2[0-4])$/.test(event.key)) return null;
  let key = event.key;
  if (key === " ") key = "Space";
  else if (/^Key[A-Z]$/.test(event.code)) key = event.code.slice(3);
  else if (/^Digit[0-9]$/.test(event.code)) key = event.code.slice(5);
  else if (key.length === 1) key = key.toUpperCase();
  return [...modifiers, key].join("+");
}
