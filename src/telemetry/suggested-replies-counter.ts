




export type SuggestedRepliesEvent =
  | "shown"
  | "accepted-best"
  | "accepted-chip"
  | "dismissed"
  | "ignored";

const counters: Record<SuggestedRepliesEvent, number> = {
  shown: 0,
  "accepted-best": 0,
  "accepted-chip": 0,
  dismissed: 0,
  ignored: 0,
};

/**
 * Increment the counter for `event`. Safe to call before any reader is
 * attached — the counter map is initialized at module load.
 */
export function recordSuggestedRepliesEvent(event: SuggestedRepliesEvent): void {
  counters[event] += 1;
}

/**
 * Read a snapshot of every counter. Returns a fresh object so callers can
 * compare across samples without leaking the live map.
 */
export function getSuggestedRepliesCounters(): Record<SuggestedRepliesEvent, number> {
  return { ...counters };
}

/**
 * Reset every counter. Test-only helper — production code never needs to
 * clear the in-process counters.
 */
export function resetSuggestedRepliesCountersForTesting(): void {
  for (const k of Object.keys(counters) as SuggestedRepliesEvent[]) {
    counters[k] = 0;
  }
}
