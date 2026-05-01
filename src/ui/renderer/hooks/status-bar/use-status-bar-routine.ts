import { useEffect } from "react";
import type { LvisApi } from "../../types.js";
import type { PersistentItem } from "./types.js";

interface Options {
  api: LvisApi;
  upsertPersistent: (item: PersistentItem) => void;
  removePersistent: (id: string) => void;
}

export function useStatusBarRoutine({ api, upsertPersistent, removePersistent }: Options): void {
  useEffect(() => {
    let cancelled = false;
    const refreshNextRoutine = async () => {
      try {
        const s = await api.getSettings();
        if (cancelled) return;
        const t = s.routine?.scheduleTimeKst;
        const enabled = s.routine?.enableWakeupRoutine === true;
        if (enabled && typeof t === "string" && t.length > 0) {
          upsertPersistent({
            id: "routine:next",
            severity: "info",
            label: "다음 루틴",
            value: `${t} KST`,
          });
        } else {
          removePersistent("routine:next");
        }
      } catch {
        // Non-fatal — status bar without the next-routine hint is fine.
      }
    };
    void refreshNextRoutine();
    const onFocus = () => void refreshNextRoutine();
    window.addEventListener("focus", onFocus);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", onFocus);
    };
  }, [api, upsertPersistent, removePersistent]);
}
