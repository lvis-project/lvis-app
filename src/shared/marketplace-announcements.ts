export const MARKETPLACE_ANNOUNCEMENT_LEVELS = [
  "info",
  "warning",
  "critical",
] as const;

export type MarketplaceAnnouncementLevel =
  typeof MARKETPLACE_ANNOUNCEMENT_LEVELS[number];

/**
 * Marketplace announcement payload pushed from main to renderer.
 *
 * Mirrors the public `GET /api/v1/announcements` contract after the cloud
 * fetcher has normalized trust-boundary values.
 */
export interface MarketplaceAnnouncement {
  id: number;
  title: string;
  body: string;
  level: MarketplaceAnnouncementLevel;
  createdAt: string;
  startsAt: string | null;
  endsAt: string | null;
}

export type MarketplaceAnnouncementPayload = MarketplaceAnnouncement[];

export function isMarketplaceAnnouncementLevel(
  value: unknown,
): value is MarketplaceAnnouncementLevel {
  return (
    typeof value === "string" &&
    (MARKETPLACE_ANNOUNCEMENT_LEVELS as readonly string[]).includes(value)
  );
}

/**
 * Normalize the persisted `settings.marketplace.dismissedAnnouncementIds` list
 * — the single definition of "what counts as a valid dismissed id".
 *
 * Shared because the renderer WRITES the list (`useMarketplaceAnnouncements`
 * dismiss) and main FILTERS every announcement push against it
 * (`wireAnnouncementCheck`), so the two sides must agree on which entries
 * survive and in what order. Order is load-bearing on the renderer side: the
 * dismiss path compares the normalized next list against the normalized
 * existing one element-by-element to decide whether to write at all, and on
 * the main side it feeds the broadcast dedup key.
 *
 * Accepts anything: a non-array input yields an empty list. Keeps only safe
 * integers, deduplicates, and sorts ascending.
 */
export function normalizeDismissedAnnouncementIds(ids: unknown): number[] {
  if (!Array.isArray(ids)) return [];
  const validIds = new Set<number>();
  for (const id of ids) {
    if (typeof id === "number" && Number.isSafeInteger(id)) {
      validIds.add(id);
    }
  }
  return Array.from(validIds).sort((a, b) => a - b);
}
