const nativeKeyboardControls = [
  "button", "a[href]", "input", "textarea", "select", "summary",
  '[contenteditable]:not([contenteditable="false"])',
  '[role="button"]', '[role="link"]', '[role="menuitem"]', '[role="tab"]',
  '[role="combobox"]', '[role="textbox"]', '[role="checkbox"]', '[role="radio"]',
  '[role="switch"]', '[role="slider"]', '[role="spinbutton"]', '[role="separator"]',
].join(",");

export function isInsideKeyboardDialog(target: EventTarget | null): boolean {
  // Explicitly scoped panels, like dialogs, must receive keys before the
  // window capture listener can hide Hub or navigate the cached search result.
  // WebView can retarget a native popup's Escape to the document body.
  return Boolean(document.querySelector('dialog[open], [data-hub-keyboard-scope][data-keyboard-open="true"], details[data-hub-keyboard-scope][open]:not([hidden] *)')) || target instanceof Element && Boolean(target.closest('dialog[open], [role="dialog"], [role="alertdialog"], [data-hub-keyboard-scope]:not([hidden])'));
}

// Search selection can remain cached while another workspace owns the screen.
// Its capture listener must also leave focused controls to their own handlers.
export function canHandleSearchWorkspaceKeyboard(
  event: Pick<KeyboardEvent, "key" | "target" | "defaultPrevented" | "isComposing" | "altKey" | "ctrlKey" | "metaKey">,
  workspaceActive: boolean,
): boolean {
  const previewShortcut = event.key === "F12" || (event.altKey && !event.ctrlKey && !event.metaKey
    && (event.key === "ArrowLeft" || event.key === "ArrowRight" || event.key.toLowerCase() === "p"));
  return workspaceActive
    && !event.defaultPrevented
    && !event.isComposing
    && !isInsideKeyboardDialog(event.target)
    && (!(event.target instanceof Element && event.target.closest(nativeKeyboardControls)) || previewShortcut);
}
