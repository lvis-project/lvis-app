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
      <MarketplaceAnnouncementBanner announcements={[]} onDismiss={vi.fn()} onAction={vi.fn()} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("shows the newest announcement and applies the level palette", () => {
    render(
      <MarketplaceAnnouncementBanner
        announcements={[announcement(1, "Scheduled maintenance", "warning")]}
        onDismiss={vi.fn()}
        onAction={vi.fn()}
      />,
    );
    const banner = screen.getByTestId("marketplace-announcement-banner");
    expect(banner).toHaveAttribute("data-level", "warning");
    // Card fill is the opaque popover surface so chat content cannot bleed
    // through the floating overlay; the level color rides on the border/text.
    expect(banner.className).toContain("bg-popover");
    expect(banner.className).toContain("border-warning/(--opacity-medium)");
    expect(banner.textContent).toContain("Scheduled maintenance");
  });

  it("uses destructive tokens for critical announcements", () => {
    render(
      <MarketplaceAnnouncementBanner
        announcements={[announcement(1, "Outage", "critical")]}
        onDismiss={vi.fn()}
        onAction={vi.fn()}
      />,
    );
    const banner = screen.getByTestId("marketplace-announcement-banner");
    expect(banner.className).toContain("bg-popover");
    expect(banner.className).toContain("border-destructive/(--opacity-medium)");
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
        onAction={vi.fn()}
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
        onAction={vi.fn()}
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
        onAction={vi.fn()}
      />,
    );
    const body = screen.getByTestId("marketplace-announcement-body");
    // jsdom has no layout → MarqueeText falls back to the static truncate path.
    expect(body).toHaveAttribute("data-marquee", "static");
    expect(body.className).toContain("truncate");
  });

  it("draws no action buttons when the announcement carries none", () => {
    render(
      <MarketplaceAnnouncementBanner
        announcements={[announcement(1, "Plain notice", "info")]}
        onDismiss={vi.fn()}
        onAction={vi.fn()}
      />,
    );
    expect(screen.queryByTestId("marketplace-announcement-action-0")).toBeNull();
  });

  it("labels each action in the active language", () => {
    render(
      <MarketplaceAnnouncementBanner
        announcements={[
          announcement(1, "Sandbox", "info", "body text", [
            {
              label: { ko: "샌드박스 설정 열기", en: "Open sandbox settings" },
              target: { kind: "settings", settingsTab: "permissions" },
            },
            {
              label: { ko: "안내 문서", en: "Read the guide" },
              target: { kind: "url", url: "https://example.com/guide" },
            },
          ]),
        ]}
        onDismiss={vi.fn()}
        onAction={vi.fn()}
      />,
    );
    // Korean runtime locale (test setup).
    expect(screen.getByTestId("marketplace-announcement-action-0").textContent)
      .toBe("샌드박스 설정 열기");
    expect(screen.getByTestId("marketplace-announcement-action-1").textContent)
      .toBe("안내 문서");
  });

  it("hands the target back on click without touching the dismiss path", () => {
    const onAction = vi.fn();
    const onDismiss = vi.fn();
    render(
      <MarketplaceAnnouncementBanner
        announcements={[
          announcement(9, "Sandbox", "info", "body text", [
            {
              label: { ko: "열기", en: "Open" },
              target: { kind: "settings", settingsTab: "permissions" },
            },
          ]),
        ]}
        onDismiss={onDismiss}
        onAction={onAction}
      />,
    );
    screen.getByTestId("marketplace-announcement-action-0").click();
    expect(onAction).toHaveBeenCalledWith({
      kind: "settings",
      settingsTab: "permissions",
    });
    // Following a button is not dismissing the notice.
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("draws the actions of the visible announcement, not of the ones behind it", () => {
    render(
      <MarketplaceAnnouncementBanner
        announcements={[
          announcement(3, "Newest", "info"),
          announcement(2, "Older", "info", "body text", [
            {
              label: { ko: "숨은 버튼", en: "Hidden button" },
              target: { kind: "url", url: "https://example.com/hidden" },
            },
          ]),
        ]}
        onDismiss={vi.fn()}
        onAction={vi.fn()}
      />,
    );
    expect(screen.queryByTestId("marketplace-announcement-action-0")).toBeNull();
  });
});

function announcement(
  id: number,
  title: string,
  level: MarketplaceAnnouncement["level"],
  body = "body text",
  actions: MarketplaceAnnouncement["actions"] = [],
): MarketplaceAnnouncement {
  return {
    id,
    title,
    body,
    level,
    createdAt: "2026-06-12T00:00:00Z",
    startsAt: null,
    endsAt: null,
    actions,
  };
}
