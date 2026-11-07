import { useRef, type ComponentProps } from "react";
import { useMediaLifecycle } from "./MediaLifecycle";

// Leaving the visible reading surface stops playback. Returning preserves the
// position and waits for the user; it never restarts a video automatically.
export function LifecycleVideo(props: ComponentProps<"video">) {
  const ref = useRef<HTMLVideoElement>(null);
  useMediaLifecycle(ref);
  return <video {...props} ref={ref} />;
}
