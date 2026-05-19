import { useEffect } from "react";
import type { LvisApi } from "../../types.js";
import type { PersistentItem } from "./types.js";

interface Options {
  api: LvisApi;
  upsertPersistent: (item: PersistentItem) => void;
  removePersistent: (id: string) => void;
}

export function useStatusBarMarketplace({ api, upsertPersistent, removePersistent }: Options): void {
  useEffect(() => {
    if (typeof api.pingMarketplace !== "function") return;
    let cancelled = false;
    let pingToken = 0;
    let intervalId: ReturnType<typeof setInterval> | null = null;
    const refreshMarketplace = async () => {
      const my = ++pingToken;
      try {
        const result = await api.pingMarketplace();
        if (cancelled || my !== pingToken) return;
        if (!result.configured) {
          removePersistent("marketplace:online");
          return;
        }
        upsertPersistent({
          id: "marketplace:online",
          severity: result.online ? "success" : "error",
          dot: true,
          a11yLabel: result.online ? "Marketplace: Online" : "Marketplace: Offline",
          tooltip: result.online ? "Marketplace: Online" : "Marketplace: Offline",
        });
      } catch {
        if (cancelled || my !== pingToken) return;
        upsertPersistent({
          id: "marketplace:online",
          severity: "error",
          dot: true,
          a11yLabel: "Marketplace: Offline",
          tooltip: "Marketplace: Offline",
        });
      }
    };
    const start = () => {
      if (intervalId !== null) return;
      void refreshMarketplace();
      intervalId = setInterval(() => void refreshMarketplace(), 30_000);
    };
    const stop = () => {
      if (intervalId !== null) {
        clearInterval(intervalId);
        intervalId = null;
      }
    };
    if (document.hasFocus()) start();
    const onFocus = () => start();
    const onBlur = () => stop();
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    return () => {
      cancelled = true;
      stop();
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
    };
  }, [api, upsertPersistent, removePersistent]);
}
