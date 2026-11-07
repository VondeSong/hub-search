import { invoke } from "@tauri-apps/api/core";
import { useCallback, useRef, useState } from "react";
import type { IndexStatus } from "./IndexStatusTypes";
import { useVisiblePolling } from "./useVisiblePolling";
import { ViewRequest } from "./ViewRequest";

export function useIndexStatus(ready: boolean, spaceId: string | null) {
  const [indexStatus, setIndexStatus] = useState<IndexStatus | null>(null);
  const requests = useRef(new ViewRequest());
  const key = spaceId ?? "all";
  requests.current.select(key);

  const refreshStatus = useCallback((fresh = true) => requests.current.run(key, () => invoke<IndexStatus>("index_status", { spaceId }), setIndexStatus, fresh), [key, spaceId]);

  useVisiblePolling(() => refreshStatus(false), ready, 3_000, { refreshKey: key });

  return { indexStatus, refreshStatus };
}
