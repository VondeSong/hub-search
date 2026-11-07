import { useLayoutEffect, useState } from "react";

function readViewport() {
  const viewport = window.visualViewport;
  const height = viewport?.height ?? window.innerHeight;
  return { height, keyboardOpen: window.innerHeight - height > 120 };
}

// Android WebView can resize only the visual viewport when the keyboard opens.
// Ignore pinch zoom: resizing the layout during zoom would move the content.
export function useMobileViewport() {
  const [viewport, setViewport] = useState(readViewport);
  useLayoutEffect(() => {
    const visual = window.visualViewport;
    const update = () => {
      if (visual && Math.abs(visual.scale - 1) > 0.01) return;
      const next = readViewport();
      setViewport((current) => current.height === next.height && current.keyboardOpen === next.keyboardOpen ? current : next);
    };
    update();
    window.addEventListener("resize", update);
    visual?.addEventListener("resize", update);
    return () => {
      window.removeEventListener("resize", update);
      visual?.removeEventListener("resize", update);
    };
  }, []);
  return viewport;
}
