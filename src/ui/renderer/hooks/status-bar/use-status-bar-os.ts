import { useEffect } from "react";
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
 * Renders an OS glyph (🍎 macOS, 🪟 Windows, 🐧 Linux, 💻 fallback) followed
 * by a short OS short-name. Screen readers receive a semantic Korean label
 * via `a11yLabel` so the emoji's Unicode name ("red apple") is not announced.
 */
export function useStatusBarOs({ api, upsertPersistent }: Options): void {
  useEffect(() => {
    if (typeof api.getRuntimeEnv !== "function") return;
    let cancelled = false;
    (async () => {
      try {
        const env = await api.getRuntimeEnv();
        if (cancelled) return;
        const os = describeOs(env.platform);
        upsertPersistent({
          id: "runtime:os",
          severity: "info",
          label: os.emoji,
          value: os.shortName,
          a11yLabel: os.a11y,
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

function describeOs(platform: string): { emoji: string; shortName: string; a11y: string } {
  switch (platform) {
    case "darwin":
      return { emoji: "🍎", shortName: "macOS", a11y: "운영체제: macOS" };
    case "win32":
      return { emoji: "🪟", shortName: "Win", a11y: "운영체제: Windows" };
    case "linux":
      return { emoji: "🐧", shortName: "Linux", a11y: "운영체제: Linux" };
    default:
      return { emoji: "💻", shortName: platform, a11y: `운영체제: ${platform}` };
  }
}
