import { useEffect, useRef, useState } from "react";
import { writeClipboardText } from "./usePreviewController";

export function usePreviewLinkCopy(onError: (message: string) => void) {
  const [copiedKey, setCopiedKey] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const generation = useRef(0);
  useEffect(() => () => { clearTimeout(timer.current); generation.current++; }, []);
  const copy = async (key: string, getLink: () => string | Promise<string>) => {
    const current = ++generation.current;
    try {
      const link = await getLink();
      if (current !== generation.current) return;
      await writeClipboardText(link);
      if (current !== generation.current) return;
      clearTimeout(timer.current);
      setCopiedKey(key);
      timer.current = setTimeout(() => setCopiedKey(""), 1800);
    } catch (error) {
      if (current === generation.current) onError(`复制链接失败：${String(error)}`);
    }
  };
  return { copiedKey, copy };
}
