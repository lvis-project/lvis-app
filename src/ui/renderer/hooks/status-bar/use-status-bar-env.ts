import { useEffect } from "react";
import type { LvisApi } from "../../types.js";
import type { PersistentItem } from "./types.js";

interface Options {
  api: LvisApi;
  upsertPersistent: (item: PersistentItem) => void;
}

export function useStatusBarEnv({ api, upsertPersistent }: Options): void {
  useEffect(() => {
    if (typeof api.getRuntimeEnv !== "function") return;
    let cancelled = false;
    (async () => {
      try {
        const env = await api.getRuntimeEnv();
        if (cancelled) return;
        upsertPersistent({
          id: "runtime:env",
          severity: "info",
          label: "Env",
          value: `${env.platform} · ${env.user}@${env.hostname}`,
        });
      } catch {
        // Non-fatal.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, upsertPersistent]);
}
