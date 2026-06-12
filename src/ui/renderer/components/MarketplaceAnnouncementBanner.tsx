// Non-blocking, dismissible banner showing marketplace announcements.

import { Button } from "../../../components/ui/button.js";
import type { MarketplaceAnnouncement } from "../../../shared/marketplace-announcements.js";
import { MarqueeText } from "./MarqueeText.js";
import { useTranslation } from "../../../i18n/react.js";

/**
 * Renders the newest active announcement at the top of the app, matching the
 * look-and-feel of {@link MarketplaceUpdateBanner}. When more than one is
 * active, an "외 N건" count is appended; dismissing the visible one (X button)
 * persists its id and reveals the next.
 *
 * The level drives the color scheme using the project's semantic tokens:
 *   - info     → info (same family as the update banner)
 *   - warning  → warning/amber
 *   - critical → destructive
 *
 * Long title/body lines scroll via {@link MarqueeText} instead of truncating.
 */
export function MarketplaceAnnouncementBanner({
  announcements,
  onDismiss,
}: {
  announcements: MarketplaceAnnouncement[];
  onDismiss: (id: number) => void;
}) {
  const { t } = useTranslation();

  if (announcements.length === 0) return null;

  const [current, ...rest] = announcements;
  const palette = LEVEL_PALETTE[current.level];
  const moreCount = rest.length;

  return (
    <div
      className={`flex h-11 items-center justify-between gap-2 overflow-hidden text-sm px-4 py-1.5 rounded-md mx-2 mt-2 lvis-anim-slide-down border ${palette.container}`}
      data-testid="marketplace-announcement-banner"
      data-level={current.level}
    >
      <span className="min-w-0 flex-1">
        <MarqueeText
          text={
            moreCount > 0
              ? `${current.title}  ·  ${t("marketplaceAnnouncementBanner.moreCount", { count: moreCount })}`
              : current.title
          }
          className="leading-4 font-medium"
          data-testid="marketplace-announcement-title"
        />
        <MarqueeText
          text={current.body}
          className={`text-[11px] leading-3 ${palette.body}`}
          data-testid="marketplace-announcement-body"
        />
      </span>
      <div className="flex shrink-0 items-center gap-1">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => onDismiss(current.id)}
          aria-label={t("marketplaceAnnouncementBanner.dismissAriaLabel")}
          className={`h-auto p-1 ${palette.dismiss}`}
          data-testid="marketplace-announcement-dismiss"
        >
          ✕
        </Button>
      </div>
    </div>
  );
}

const LEVEL_PALETTE: Record<
  MarketplaceAnnouncement["level"],
  { container: string; body: string; dismiss: string }
> = {
  info: {
    container: "bg-info/15 border-info/40 text-info",
    body: "text-info/75",
    dismiss: "text-info hover:text-info/80",
  },
  warning: {
    container: "bg-warning/15 border-warning/40 text-warning",
    body: "text-warning/75",
    dismiss: "text-warning hover:text-warning/80",
  },
  critical: {
    container: "bg-destructive/15 border-destructive/40 text-destructive",
    body: "text-destructive/75",
    dismiss: "text-destructive hover:text-destructive/80",
  },
};
