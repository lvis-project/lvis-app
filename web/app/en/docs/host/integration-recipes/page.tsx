import { PageHero } from "@/components/docs/page-hero";
import { Callout } from "@/components/docs/callout";
import { StepList } from "@/components/docs/step-list";
import { ScreenshotCard, ScreenshotGallery } from "@/components/docs/screenshot-card";
import { PageNav } from "@/components/docs/page-nav";
import { shotUrl, shots } from "@/lib/screenshots";

export const metadata = { title: "Integration Recipes — Plugin Combination Scenarios" };

export default function Page() {
  return (
    <article>
      <PageHero
        eyebrow="Host · Integration Recipes"
        title="A Collection of Plugin Combination Scenarios"
        description="What matters more than using a single plugin is the 'chain' where several plugins work together. This page lays out four commonly used combination scenarios as short flows. Every chain goes through a user consent card, and any step that runs automatically is marked explicitly."
        tags={["Meeting + Work Assistant + MS-Graph", "Local Indexer + Meeting + Agent Hub", "MS-Graph + LGE EP", "Agent Hub + Meeting + EP"]}
      />

      <h2 id="recipe-1">Recipe 1 — Meeting → Action → Schedule → Reply</h2>
      <p>The most frequent chain. Decisions made in a meeting flow naturally into a schedule entry and a reply.</p>
      <StepList
        steps={[
          { title: "Meeting ends", body: <p>The <strong>Meeting</strong> plugin ends the recording → automatically extracts meeting notes and candidate action items.</p>, badge: "Meeting" },
          { title: "Follow-up card appears", body: <p><strong>Work Assistant</strong> surfaces the action item candidates as a user confirmation card. Choose from "add as TODO / reply by mail / add to schedule."</p>, badge: "Work Assistant" },
          { title: "Schedule entry + reply draft", body: <p>If the user picks "schedule + reply" → the event is added to the <strong>Microsoft 365</strong> calendar, and a reply draft appears in chat. It is only actually sent the moment "Send" is pressed.</p>, badge: "MS-Graph" },
          { title: "Records preserved", body: <p>Every step is logged in the audit trail, and extracted action items are also synced as work-board cards.</p> },
        ]}
      />

      <ScreenshotGallery columns={2}>
        <ScreenshotCard src={shotUrl("meeting-outlook-mail")} caption={shots["meeting-outlook-mail"].captionEn} />
        <ScreenshotCard src={shotUrl("meeting-outlook-mail-2")} caption={shots["meeting-outlook-mail-2"].captionEn} />
      </ScreenshotGallery>

      <h2 id="recipe-2">Recipe 2 — From "Where was that file?" to a Presentation Slide</h2>
      <p>The Local Indexer is the core here — one flow from search, to path lookup, to content summary, to a presentation-ready reformat.</p>
      <StepList
        steps={[
          { title: "Natural language search", body: <p>Ask in chat, "where was the material about OOO?" → <strong>Local Indexer</strong> answers with candidate files and its reasoning.</p>, badge: "Local Indexer" },
          { title: "Path lookup", body: <p>Ask for the "exact file path" → the absolute path (including NAS mounts) is printed as-is. Open it directly from the OS file manager.</p> },
          { title: "Summarize + reformat", body: <p>On the same file, ask to "format this into one slide for a presentation" → the host LLM reuses the same match result and reformats it for a presentation.</p>, badge: "Reused" },
          { title: "Send to a work-board card", body: <p>Register the summary as a "prepare presentation material" card on the <strong>Agent Hub</strong> work board to share with the team.</p>, badge: "Agent Hub" },
        ]}
      />

      <h2 id="recipe-3">Recipe 3 — All the Way to Booking an Internal Meeting Room</h2>
      <p>The chain that links ordinary meeting scheduling to the internal portal. Works only inside the internal network.</p>
      <StepList
        steps={[
          { title: "Meeting request mail arrives", body: <p><strong>Microsoft 365</strong> detects a new meeting request. Candidate times are extracted from the body.</p>, badge: "MS-Graph" },
          { title: "Available room suggested", body: <p><strong>Work Assistant</strong> checks the user's calendar together with room availability from the internal system, then surfaces a candidate card.</p>, badge: "Work Assistant" },
          { title: "Room booked + video call added", body: <p>The chosen room is confirmed with <strong>LGE EP</strong>'s room booking tool. If there are external attendees, a video call link is generated automatically and attached to the event body.</p>, badge: "LGE EP" },
          { title: "Reply sent", body: <p>A card showing "booking complete + room + video call link" is shown to the meeting requester in chat → it is only actually sent the moment the user presses "Reply."</p>, badge: "Sent after confirmation" },
        ]}
      />

      <h2 id="recipe-4">Recipe 4 — Video Call → Automatic Meeting Notes → Team Board</h2>
      <p>Wrapping up a meeting with external attendees. Notes, action items, and team sharing, all in one pass.</p>
      <StepList
        steps={[
          { title: "Join the video call", body: <p>Start the video call from the link attached to the event — <strong>LGE EP</strong>'s video call flow.</p>, badge: "LGE EP" },
          { title: "Automatic meeting notes", body: <p>During the meeting, the <strong>Meeting</strong> plugin runs live transcription. On end, it automatically generates notes, a summary, and action items.</p>, badge: "Meeting" },
          { title: "Distributed to the team board", body: <p>Action item cards are registered automatically on the <strong>Agent Hub</strong> work board. Candidate assignees are filled in automatically, and cards nearing their deadline are sent as notifications.</p>, badge: "Agent Hub" },
          { title: "Notes stay in their own area", body: <p>The original meeting notes are kept only inside the Meeting plugin's own area. They are not automatically sent to an external server.</p>, badge: "Only on your PC" },
        ]}
      />

      <Callout tone="info" title="Make a recipe your own">
        Each recipe can be registered as an "automation rule." When a trigger arrives — a meeting ending, new mail arriving, a specific time — the host fires the same flow automatically, and the user only needs to check the resulting card.
      </Callout>

      <Callout tone="security" title="Every chain goes through a consent card">
        Separately from the word "automation," risky steps (sending mail, calling external services, submitting an approval) always go through a consent card.
        Being registered under automation once does not mean risky steps afterward are handled without asking.
      </Callout>

      <PageNav />
    </article>
  );
}
