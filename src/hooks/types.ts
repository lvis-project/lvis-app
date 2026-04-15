/**
 * Portions adapted from OpenHarness (MIT License)
 * https://github.com/HKUDS/OpenHarness/blob/main/src/openharness/hooks/types.py
 * Copyright (c) 2026 HKU Data Intelligence Lab
 */
export interface ExternalHookResult {
  hookType: "command" | "http";
  success: boolean;
  output?: string;
  blocked: boolean;
  reason?: string;
  metadata?: Record<string, unknown>;
}

export interface AggregatedExternalHookResult {
  results: ExternalHookResult[];
  get blocked(): boolean;
  get reason(): string;
}

export function aggregateExternal(results: ExternalHookResult[]): AggregatedExternalHookResult {
  return {
    results,
    get blocked() {
      return results.some((r) => r.blocked);
    },
    get reason() {
      for (const r of results) {
        if (r.blocked) return r.reason ?? r.output ?? "";
      }
      return "";
    },
  };
}
