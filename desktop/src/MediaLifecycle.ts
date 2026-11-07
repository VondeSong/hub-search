import { useEffect, type RefObject } from "react";
import { isWindowVisible, subscribeWindowVisibility } from "./WindowVisibility";

// The element owns decoding/network resources. A host hide, collapsed section
// or departure from the reading surface pauses it; return never starts playback.
export function useMediaLifecycle<T extends HTMLMediaElement>(ref: RefObject<T | null>) {
  useEffect(() => {
    const media = ref.current; if (!media) return;
    let onSurface = true;
    const toggles: HTMLDetailsElement[] = [];
    for (let parent = media.parentElement; parent; parent = parent.parentElement) {
      if (parent instanceof HTMLDetailsElement) toggles.push(parent);
    }
    const pauseIfHidden = () => {
      if (!isWindowVisible() || !onSurface || toggles.some(toggle => !toggle.open)) media.pause();
    };
    const observer = typeof IntersectionObserver === "undefined" ? null : new IntersectionObserver(entries => {
      const entry = entries.find(item => item.target === media);
      if (entry) { onSurface = entry.isIntersecting; pauseIfHidden(); }
    });
    observer?.observe(media);
    const unsubscribe = subscribeWindowVisibility(pauseIfHidden);
    media.addEventListener("play", pauseIfHidden);
    toggles.forEach(toggle => toggle.addEventListener("toggle", pauseIfHidden));
    pauseIfHidden();
    return () => {
      observer?.disconnect(); unsubscribe();
      media.removeEventListener("play", pauseIfHidden);
      toggles.forEach(toggle => toggle.removeEventListener("toggle", pauseIfHidden));
      media.pause(); media.removeAttribute("src");
      media.querySelectorAll("source").forEach(source => source.removeAttribute("src"));
      media.load();
    };
  }, [ref]);
}
