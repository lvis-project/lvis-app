import { PageHero } from "@/components/docs/page-hero";
import { ScreenshotCard, ScreenshotGallery } from "@/components/docs/screenshot-card";
import { StepList } from "@/components/docs/step-list";
import { Callout } from "@/components/docs/callout";
import { PageNav } from "@/components/docs/page-nav";
import { shotUrl, shots } from "@/lib/screenshots";

export const metadata = { title: "Meeting End → Automatic Tasks" };

export default function Page() {
  return (
    <article>
      <PageHero
        eyebrow="Event-driven flow"
        title="Meeting End → Action Item Extraction (Not a Routine)"
        description="This flow is handled by work-assistant's meeting-summary detector, not RoutineEngineV2 — when the meeting plugin emits meeting.summary.created, the detector decides whether to surface it and shows the user a card."
        tags={["event-driven", "meeting.summary.created", "meeting-summary-detector"]}
      />

      <ScreenshotGallery columns={2}>
        <ScreenshotCard src={shotUrl("work-assistant-meeting-end-trigger")} caption={shots["work-assistant-meeting-end-trigger"].captionEn} />
        <ScreenshotCard src={shotUrl("work-assistant-meeting-end-trigger-2")} caption={shots["work-assistant-meeting-end-trigger-2"].captionEn} />
      </ScreenshotGallery>

      <h2 id="flow">One cycle</h2>
      <StepList
        steps={[
          { title: "Meeting end detected", body: <p>The meeting plugin emits <code>meeting.ended</code> on user stop / floating window close → the full transcript is saved to SessionStore.</p>, badge: "meeting" },
          { title: "Summary generated", body: <p>The meeting plugin summarizes the transcript and extracts <code>actionItems</code> using the host LLM (<code>callLlm</code>). The result is emitted as <code>meeting.summary.created</code>.</p> },
          { title: "Work Assistant detector kicks in", body: <p><code>src/decision/meeting-summary-detector.ts</code> subscribes to the event. It evaluates policy (allow-listed domains, etc.) and then decides whether to surface it.</p>, badge: "work-assistant" },
          { title: "Proactive card", body: <p>When surfacing is decided, <code>hostApi.triggerConversation</code> or <code>showOverlay</code> shows a card in the chat body or overlay. User options are displayed (TODO / mail / save summary).</p> },
          { title: "Follow-up action", body: <p>Once the user chooses, work-assistant carries out the actual task using ms-graph / agent-hub tools (e.g. adding a calendar entry, creating a work item).</p>, badge: "Final" },
        ]}
      />

      <Callout tone="tip" title="To turn this flow off">
        <ul className="my-1 list-disc pl-5">
          <li><strong>Plugin level</strong>: set meeting <code>autoSummarize=false</code> to block the summary itself.</li>
          <li><strong>Detector level</strong>: <code>work_assistant_set_detector_enabled({"{ id: 'meeting-summary', enabled: false }"})</code></li>
          <li><strong>Config level</strong>: an empty <code>meetingDetectorAllowedSenderDomains</code> array means fail-closed.</li>
        </ul>
      </Callout>

      <PageNav />
    </article>
  );
}
