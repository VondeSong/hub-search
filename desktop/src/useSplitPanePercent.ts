import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";
import { userProfileStorage } from "./UserProfileStorage";

const DRAG_THRESHOLD_PX = 3;

function clampPercent(value: number, min: number, max: number): number {
  return Math.round(Math.min(max, Math.max(min, value)) * 10) / 10;
}

function loadStoredPercent(storageKey: string, defaultPercent: number, min: number, max: number): number {
  try {
    const raw = userProfileStorage.getItem(storageKey);
    if (raw === null) return defaultPercent;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? clampPercent(parsed, min, max) : defaultPercent;
  } catch {
    return defaultPercent;
  }
}

function saveStoredPercent(storageKey: string, value: number) {
  try {
    userProfileStorage.setItem(storageKey, String(value));
  } catch {
    // Ignore storage errors so resizing remains responsive.
  }
}

/** Manages a persisted right-side split-pane percentage with pointer drag, keyboard, and double-click reset. */
export function useSplitPanePercent({
  storageKey,
  defaultPercent,
  minPercent,
  maxPercent,
  containerRef,
}: {
  storageKey: string;
  defaultPercent: number;
  minPercent: number;
  maxPercent: number;
  containerRef: RefObject<HTMLElement | null>;
}) {
  const [percent, setPercent] = useState<number>(() =>
    loadStoredPercent(storageKey, defaultPercent, minPercent, maxPercent),
  );
  const cleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => () => {
    cleanupRef.current?.();
  }, []);

  const commit = useCallback((next: number) => {
    const clamped = clampPercent(next, minPercent, maxPercent);
    setPercent(clamped);
    saveStoredPercent(storageKey, clamped);
  }, [maxPercent, minPercent, storageKey]);

  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const container = containerRef.current;
    if (!container) return;
    const bounds = container.getBoundingClientRect();
    if (bounds.width <= 0) return;

    event.preventDefault();
    const handle = event.currentTarget;
    const pointerId = event.pointerId;
    const startX = event.clientX;
    const handleRect = handle.getBoundingClientRect();
    const basePercent =
      handleRect.width > 0 && handleRect.right >= bounds.left && handleRect.right <= bounds.right
        ? clampPercent(((bounds.right - handleRect.right) / bounds.width) * 100, minPercent, maxPercent)
        : percent;

    handle.setPointerCapture?.(pointerId);
    cleanupRef.current?.();

    const computeFromDrag = (clientX: number) =>
      clampPercent(basePercent + ((startX - clientX) / bounds.width) * 100, minPercent, maxPercent);

    let dragged = false;
    let latest = basePercent;
    const onMove = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) return;
      if (!dragged) {
        if (Math.abs(moveEvent.clientX - startX) < DRAG_THRESHOLD_PX) return;
        dragged = true;
        document.body.classList.add("resizing-panes");
      }
      latest = computeFromDrag(moveEvent.clientX);
      setPercent(latest);
    };
    const finish = (endEvent: PointerEvent) => {
      if (endEvent.pointerId !== pointerId) return;
      if (dragged) {
        latest = computeFromDrag(endEvent.clientX);
        setPercent(latest);
        saveStoredPercent(storageKey, latest);
      }
      cleanup();
    };
    const cancel = (cancelEvent: PointerEvent) => {
      if (cancelEvent.pointerId !== pointerId) return;
      if (dragged) {
        saveStoredPercent(storageKey, latest);
      }
      cleanup();
    };
    const cleanup = () => {
      document.body.classList.remove("resizing-panes");
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", cancel);
      if (handle.hasPointerCapture?.(pointerId)) {
        handle.releasePointerCapture(pointerId);
      }
      cleanupRef.current = null;
    };

    cleanupRef.current = cleanup;
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", cancel);
  }, [containerRef, maxPercent, minPercent, percent, storageKey]);

  const onKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      commit(percent + 2);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      commit(percent - 2);
    } else if (event.key === "Home") {
      event.preventDefault();
      commit(minPercent);
    } else if (event.key === "End") {
      event.preventDefault();
      commit(maxPercent);
    } else if (event.key === "Enter") {
      event.preventDefault();
      commit(defaultPercent);
    }
  }, [commit, defaultPercent, maxPercent, minPercent, percent]);

  const onDoubleClick = useCallback(() => {
    commit(defaultPercent);
  }, [commit, defaultPercent]);

  return {
    percent,
    onPointerDown,
    onKeyDown,
    onDoubleClick,
  };
}
