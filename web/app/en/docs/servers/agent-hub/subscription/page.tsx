import { PageHero } from "@/components/docs/page-hero";
import { ScreenshotCard, ScreenshotGallery } from "@/components/docs/screenshot-card";
import { Callout } from "@/components/docs/callout";
import { PageNav } from "@/components/docs/page-nav";
import { shotUrl, shots } from "@/lib/screenshots";

export const metadata = { title: "Agent Hub — Team Feed Subscription" };

export default function Page() {
  return (
    <article>
      <PageHero
        eyebrow="Agent Hub"
        title="Team Feed Subscription"
        description="A per-user opt-in relationship of 'I want to receive this team's feed.' Work cards from subscribed teams flow into the user's board and inbox alongside their own."
        tags={["Opt-in relationship", "Per-user", "Unsubscribe anytime"]}
      />

      <ScreenshotGallery columns={1}>
        <ScreenshotCard src={shotUrl("ah-subscription")} caption={shots["ah-subscription"].captionEn} aspect="wide" />
      </ScreenshotGallery>

      <h2 id="manage">Subscribe / Unsubscribe</h2>
      <ul>
        <li>Pick a team you're interested in and click "Subscribe" — that team's activity starts flowing into your board and inbox.</li>
        <li>Clicking "Unsubscribe" stops the feed immediately. Previously received cards remain as-is.</li>
        <li>Unless an admin forcibly cuts a subscription, it's a model where the user turns it on and off themselves.</li>
      </ul>

      <Callout tone="info" title="Subscription is not a 'plan'">
        The "subscription" referred to on this page is not a license or billing plan — it's a feed opt-in relationship between a user and a team.
      </Callout>

      <PageNav />
    </article>
  );
}
