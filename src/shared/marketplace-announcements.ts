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
