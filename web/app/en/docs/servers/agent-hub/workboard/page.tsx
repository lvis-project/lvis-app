import { PageHero } from "@/components/docs/page-hero";
import { ScreenshotCard, ScreenshotGallery } from "@/components/docs/screenshot-card";
import { Callout } from "@/components/docs/callout";
import { PageNav } from "@/components/docs/page-nav";
import { shotUrl, shots } from "@/lib/screenshots";

export const metadata = { title: "Agent Hub — Workboard" };

export default function Page() {
  return (
    <article>
      <PageHero
        eyebrow="Agent Hub"
        title="Workboard — Team-Level Work Cards"
        description="A board of work cards shared by a team, separate from personal TODOs. Each card carries an assignee / status / due date / creator, and its processing history is preserved separately as an immutable chain."
      />

      <ScreenshotGallery columns={2}>
        <ScreenshotCard src={shotUrl("ah-workboard")} caption={shots["ah-workboard"].captionEn} />
        <ScreenshotCard src={shotUrl("ah-worklog")} caption={shots["ah-worklog"].captionEn} />
      </ScreenshotGallery>

      <h2 id="board">Two Views: Board ↔ Log</h2>
      <ul>
        <li><strong>Workboard</strong> — current progress state. Columns like "To Do / In Progress / Done".</li>
        <li><strong>Worklog</strong> — processing history for the same card. Preserved append-only as an immutable chain.</li>
        <li>Both views show the same card from a different angle — one data set, two viewpoints.</li>
      </ul>

      <h2 id="lifecycle">One Cycle of a Card</h2>
      <ol>
        <li><strong>Creation</strong> — created by an agent or registered directly by a user. The assignee can be auto-filled.</li>
        <li><strong>Handoff</strong> — when another team member clicks "pick up," the assignment moves and a history entry is added to the worklog.</li>
        <li><strong>Completion / reopening</strong> — the worklog isn't erased after completion; it stays preserved as-is.</li>
        <li><strong>Notification</strong> — as the deadline approaches, a notification fires automatically to the assignee.</li>
      </ol>

      <Callout tone="security" title="Processing history in a secure chain">
        The worklog preserves who did what action and when as an immutable chain.
        Even traces that look like "an attempt to delete a record" remain visible for auditing.
      </Callout>

      <PageNav />
    </article>
  );
}
