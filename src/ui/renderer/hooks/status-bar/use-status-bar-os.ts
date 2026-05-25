import { useEffect } from "react";
import { STATUS_BAR_OS_EMOJIS } from "../../../../shared/status-bar-emojis.js";
import type { LvisApi } from "../../types.js";
import type { PersistentItem } from "./types.js";

interface Options {
  api: LvisApi;
  upsertPersistent: (item: PersistentItem) => void;
}

/**
 * OS platform indicator for the status bar.
 *
 * Replaces the previous `useStatusBarEnv` producer which also exposed
 * `<user>@<hostname>` (account info). Users requested the account fields be
 * dropped while keeping the OS marker visible.
 *
 * Renders an OS glyph (🍎 / 🪟 / 🐧 / 💻 fallback) only — the prior textual
 * short-name ("macOS"/"Win"/"Linux") was dropped per user feedback to keep
 * the indicator OS-name-agnostic. Screen readers receive a generic Korean
 * label "운영체제" via `a11yLabel` so the emoji's Unicode name is not announced.
 */
export function useStatusBarOs({ api, upsertPersistent }: Options): void {
  useEffect(() => {
    if (typeof api.getRuntimeEnv !== "function") return;
    let cancelled = false;
    (async () => {
      try {
        const env = await api.getRuntimeEnv();
        if (cancelled) return;
        const emoji = osEmoji(env.platform);
        upsertPersistent({
          id: "runtime:os",
          severity: "info",
          label: emoji,
          value: "",
          a11yLabel: "운영체제",
        });
      } catch {
        // Non-fatal — the OS marker is decorative.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, upsertPersistent]);
}

function osEmoji(platform: string): string {
  switch (platform) {
    case "darwin":
      return STATUS_BAR_OS_EMOJIS.darwin;
    case "win32":
      return STATUS_BAR_OS_EMOJIS.win32;
    case "linux":
      return STATUS_BAR_OS_EMOJIS.linux;
    default:
      return STATUS_BAR_OS_EMOJIS.fallback;
  }
}
