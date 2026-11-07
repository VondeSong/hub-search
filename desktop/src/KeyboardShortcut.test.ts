import { describe, expect, it } from "vitest";
import { shortcutFromKeyboardEvent } from "./KeyboardShortcut";

const event = (key: string, overrides: Partial<KeyboardEvent> = {}) => ({
  key, code: key, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...overrides,
});

describe("shortcut recording", () => {
  it("records every supported standalone function key", () => {
    for (let number = 1; number <= 24; number++) {
      const key = `F${number}`;
      expect(shortcutFromKeyboardEvent(event(key))).toBe(key);
    }
  });

  it("rejects ordinary standalone keys and out-of-range function keys", () => {
    for (const key of ["a", "9", " ", "Enter", "F0", "F25", "F01", "Control", "Alt", "Shift", "Meta"]) {
      expect(shortcutFromKeyboardEvent(event(key))).toBeNull();
    }
  });

  it("preserves modifier combinations and physical letter keys", () => {
    expect(shortcutFromKeyboardEvent(event("F9", { ctrlKey: true }))).toBe("Ctrl+F9");
    expect(shortcutFromKeyboardEvent(event(" ", { ctrlKey: true, altKey: true }))).toBe("Ctrl+Alt+Space");
    expect(shortcutFromKeyboardEvent(event("k", { code: "KeyK", ctrlKey: true, shiftKey: true }))).toBe("Ctrl+Shift+K");
  });
});
