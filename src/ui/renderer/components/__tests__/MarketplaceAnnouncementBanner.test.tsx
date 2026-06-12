// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MarketplaceAnnouncementBanner } from "../MarketplaceAnnouncementBanner.js";
import type { MarketplaceAnnouncement } from "../../../../shared/marketplace-announcements.js";

describe("MarketplaceAnnouncementBanner", () => {
  afterEach(() => cleanup());

  it("renders nothing when there are no announcements", () => {
    const { container } = render(
      <MarketplaceAnnouncementBanner announcements={[]} onDismiss={vi.fn()} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("shows the newest announcement and applies the level palette", () => {
    render(
      <MarketplaceAnnouncementBanner
        announcements={[announcement(1, "Scheduled maintenance", "warning")]}
        onDismiss={vi.fn()}
      />,
    );
    const banner = screen.getByTestId("marketplace-announcement-banner");
    expect(banner).toHaveAttribute("data-level", "warning");
    expect(banner.className).toContain("bg-warning/15");
    expect(banner.textContent).toContain("Scheduled maintenance");
  });

  it("uses destructive tokens for critical announcements", () => {
    render(
      <MarketplaceAnnouncementBanner
        announcements={[announcement(1, "Outage", "critical")]}
        onDismiss={vi.fn()}
      />,
    );
    const banner = screen.getByTestId("marketplace-announcement-banner");
    expect(banner.className).toContain("bg-destructive/15");
  });

  it('appends an "외 N건" count when more than one is active', () => {
    render(
      <MarketplaceAnnouncementBanner
        announcements={[
          announcement(3, "Newest", "info"),
          announcement(2, "Older", "info"),
          announcement(1, "Oldest", "info"),
        ]}
        onDismiss={vi.fn()}
      />,
    );
    const title = screen.getByTestId("marketplace-announcement-title");
    expect(title.textContent).toContain("Newest");
    // Korean runtime locale (test setup) → "외 2건".
    expect(title.textContent).toContain("외 2건");
  });

  it("dismisses the currently visible announcement by id", () => {
    const onDismiss = vi.fn();
    render(
      <MarketplaceAnnouncementBanner
        announcements={[announcement(42, "Dismiss me", "info")]}
        onDismiss={onDismiss}
      />,
    );
    screen.getByTestId("marketplace-announcement-dismiss").click();
    expect(onDismiss).toHaveBeenCalledWith(42);
  });

  it("renders the body via MarqueeText (truncate fallback in jsdom)", () => {
    render(
      <MarketplaceAnnouncementBanner
        announcements={[announcement(1, "Title", "info", "a".repeat(400))]}
        onDismiss={vi.fn()}
      />,
    );
    const body = screen.getByTestId("marketplace-announcement-body");
    // jsdom has no layout → MarqueeText falls back to the static truncate path.
    expect(body).toHaveAttribute("data-marquee", "static");
    expect(body.className).toContain("truncate");
  });
});

function announcement(
  id: number,
  title: string,
  level: MarketplaceAnnouncement["level"],
  body = "body text",
): MarketplaceAnnouncement {
  return {
    id,
    title,
    body,
    level,
    createdAt: "2026-06-12T00:00:00Z",
    startsAt: null,
    endsAt: null,
  };
}
