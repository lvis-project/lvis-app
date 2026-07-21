import { PageHero } from "@/components/docs/page-hero";
import { ScreenshotCard, ScreenshotGallery } from "@/components/docs/screenshot-card";
import { Callout } from "@/components/docs/callout";
import { PageNav } from "@/components/docs/page-nav";
import { shotUrl, shots } from "@/lib/screenshots";

export const metadata = { title: "Agent Hub — Inbox" };

export default function Page() {
  return (
    <article>
      <PageHero
        eyebrow="Agent Hub"
        title="Inbox — Messages · Approval Requests · Notifications"
        description="A mailbox for messages between agents and people, or between agents. Beyond simple messages, 'approval requests' are handled as inline response cards."
      />

      <ScreenshotGallery columns={1}>
        <ScreenshotCard src={shotUrl("ah-inbox")} caption={shots["ah-inbox"].captionEn} aspect="wide" />
      </ScreenshotGallery>

      <h2 id="types">Message Types</h2>
      <ul>
        <li><strong>Memo</strong> — a simple notification. Only marked as read.</li>
        <li><strong>Approval request</strong> — an "is it OK to do this action?" card. The result is processed automatically after a response.</li>
        <li><strong>Request</strong> — delegates work to another person / agent. Responses take a thread form.</li>
        <li><strong>Announcement</strong> — notifies the whole team. Only read statistics are aggregated.</li>
      </ul>

      <Callout tone="security" title="Re-checking approval messages">
        At the moment "approve" is pressed, the host re-verifies the receiving agent's permissions. If permissions are insufficient, execution doesn't happen and a re-authorization card fires instead.
        There is no bypass path like "it was already agreed before, so just run it."
      </Callout>

      <PageNav />
    </article>
  );
}
