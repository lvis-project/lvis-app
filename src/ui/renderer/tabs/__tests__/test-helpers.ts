import type { HookTrustRow } from "../../../../hooks/hook-trust-store.js";

export function makeHookTrustRow(name: string): HookTrustRow {
  return {
    fileName: name,
    hookType: "pre",
    sha256: "a".repeat(64),
    state: "disabled",
  };
}
