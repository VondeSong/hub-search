import { describe, expect, it } from "vitest";
import { isEditorSaveShortcut } from "./EditorShortcuts";

const event = (overrides: Partial<KeyboardEvent>) => ({
  key: "s", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...overrides,
} as KeyboardEvent);

describe("editor shortcuts", () => {
  it("accepts Windows/Linux Ctrl+S and macOS Command+S", () => {
    expect(isEditorSaveShortcut(event({ ctrlKey: true }))).toBe(true);
    expect(isEditorSaveShortcut(event({ key: "S", metaKey: true }))).toBe(true);
  });

  it("does not intercept Save As or modified system shortcuts", () => {
    expect(isEditorSaveShortcut(event({ ctrlKey: true, shiftKey: true }))).toBe(false);
    expect(isEditorSaveShortcut(event({ ctrlKey: true, altKey: true }))).toBe(false);
    expect(isEditorSaveShortcut(event({ key: "x", ctrlKey: true }))).toBe(false);
  });
});
