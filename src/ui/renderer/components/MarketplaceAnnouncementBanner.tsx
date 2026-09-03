// Non-blocking, dismissible banner showing marketplace announcements.

import { Button } from "../../../components/ui/button.js";
import type {
  MarketplaceAnnouncement,
  MarketplaceAnnouncementActionTarget,
} from "../../../shared/marketplace-announcements.js";
import { MarqueeText } from "./MarqueeText.js";
import { useTranslation } from "../../../i18n/react.js";




export function MarketplaceAnnouncementBanner({
  announcements,
  onDismiss,
  onAction,
}: {
  announcements: MarketplaceAnnouncement[];
  onDismiss: (id: number) => void;
  /** Take the reader to the action's destination. Navigation only — the banner
   *  has no way to change a setting, and neither does the announcement. */
  onAction: (target: MarketplaceAnnouncementActionTarget) => void;
}) {
  const { t, locale } = useTranslation();

  if (announcements.length === 0) return null;

  const [current, ...rest] = announcements;
  const palette = LEVEL_PALETTE[current.level];
  const moreCount = rest.length;

  return (
    <div
      className={`flex h-11 items-center justify-between gap-2 overflow-hidden text-sm px-4 py-1.5 rounded-md mx-2 mt-2 shadow-lg lvis-anim-slide-down border bg-popover ${palette.container}`}
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
        {current.actions.map((action, index) => (
          <Button
            key={index}
            variant="outline"
            size="sm"
            onClick={() => onAction(action.target)}
            className={`h-auto px-2 py-0.5 text-xs ${palette.action}`}
            data-testid={`marketplace-announcement-action-${index}`}
          >
            {action.label[locale]}
          </Button>
        ))}
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
  { container: string; body: string; dismiss: string; action: string }
> = {
  info: {
    container: "border-info/(--opacity-medium) text-info",
    body: "text-info/(--opacity-emphatic)",
    dismiss: "text-info hover:text-info/(--opacity-intense)",
    action: "border-info/(--opacity-medium) text-info hover:text-info/(--opacity-intense)",
  },
  warning: {
    container: "border-warning/(--opacity-medium) text-warning",
    body: "text-warning/(--opacity-emphatic)",
    dismiss: "text-warning hover:text-warning/(--opacity-intense)",
    action:
      "border-warning/(--opacity-medium) text-warning hover:text-warning/(--opacity-intense)",
  },
  critical: {
    container: "border-destructive/(--opacity-medium) text-destructive",
    body: "text-destructive/(--opacity-emphatic)",
    dismiss: "text-destructive hover:text-destructive/(--opacity-intense)",
    action:
      "border-destructive/(--opacity-medium) text-destructive "
      + "hover:text-destructive/(--opacity-intense)",
  },
};
