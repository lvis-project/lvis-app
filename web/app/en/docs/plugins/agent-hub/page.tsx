import { PageHero } from "@/components/docs/page-hero";
import { ScreenshotCard, ScreenshotGallery } from "@/components/docs/screenshot-card";
import { Callout } from "@/components/docs/callout";
import { StepList } from "@/components/docs/step-list";
import { PageNav } from "@/components/docs/page-nav";
import { shotUrl, shots } from "@/lib/screenshots";

export const metadata = { title: "Agent Hub Sidebar Plugin" };

export default function Page() {
  return (
    <article>
      <PageHero
        eyebrow="Plugin · Agent Hub"
        title="Agent Hub — work board and inbox on one screen"
        description="Opens a 'work board' panel inside the host that brings together personal tasks, team tasks, received messages, and pending approvals in one place. The board's data is synced with a separate Agent Hub server."
        tags={["My Work · Team Board", "inbox · approvals · reports"]}
      />

      <ScreenshotGallery columns={2}>
        <ScreenshotCard src={shotUrl("agent-hub-my-work")} caption={shots["agent-hub-my-work"].captionEn} />
        <ScreenshotCard src={shotUrl("agent-hub-team-board")} caption={shots["agent-hub-team-board"].captionEn} />
      </ScreenshotGallery>

      <h2 id="boards">Two boards</h2>
      <ul>
        <li><strong>My Work</strong> — items assigned to you or created by you. Connects both ways with the host's TODO panel.</li>
        <li><strong>Team Board</strong> — team-level cards. Only cards you have permission for are visible, and you can "pick up" someone else's card.</li>
        <li>Switch quickly between the two boards with the toggle at the top. You can also pop them out into separate windows to view both at once.</li>
      </ul>

      <h2 id="sync">Syncing with the server</h2>
      <p>
        The host periodically fetches inbox items, boards, and notifications from the Agent Hub server. It syncs gently while the user is actively working,
        and more aggressively during idle periods. All business data lives on the server — only the auth token is kept securely on the local machine.
      </p>

      <h2 id="scenario">Real-world scenario — automatic team distribution right after a meeting</h2>
      <p>
        Agent Hub's real value is that action items <strong>automatically flow to the team</strong> right after a meeting ends.
      </p>
      <StepList
        steps={[
          { title: "Meeting ends → action items extracted", body: <p>The Meeting plugin detects the end of the meeting and pulls out "who / what / by when" candidates from the minutes.</p>, badge: "meeting" },
          { title: "Task auto-registered on the board", body: <p>Work Assistant shows the extracted items as a confirmation card, and once the user approves, registers them as new cards on the Agent Hub board. The due date is filled in automatically too.</p>, badge: "add to board" },
          { title: "Notify teammates", body: <p>At the next sync, the new card appears on teammates' Team Board. If the deadline is within 24 hours, a "due soon" notification fires as well.</p>, badge: "notify" },
          { title: "\"Pick up\" → activity history", body: <p>When someone clicks "pick up", ownership of the task transfers, and the history is recorded on the board in an immutable form.</p>, badge: "history" },
        ]}
      />

      <Callout tone="info" title="The server is a separate component">
        This plugin only acts as the "entry point to the board." The data's home base is the Agent Hub server — see the
        <a href="/en/docs/servers/agent-hub"> Agent Hub server overview</a> for details.
      </Callout>

      <PageNav />
    </article>
  );
}
