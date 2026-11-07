import { useRef, type ComponentProps } from "react";
import { useMediaLifecycle } from "./MediaLifecycle";

export function LifecycleAudio(props: ComponentProps<"audio">) {
  const ref = useRef<HTMLAudioElement>(null);
  useMediaLifecycle(ref);
  return <audio {...props} ref={ref} />;
}
