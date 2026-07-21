import { PageHero } from "@/components/docs/page-hero";
import { ScreenshotCard, ScreenshotGallery } from "@/components/docs/screenshot-card";
import { StepList } from "@/components/docs/step-list";
import { Callout } from "@/components/docs/callout";
import { PageNav } from "@/components/docs/page-nav";
import { shotUrl, shots } from "@/lib/screenshots";

export const metadata = { title: "Meeting Plugin" };

export default function Page() {
  return (
    <article>
      <PageHero
        eyebrow="Plugin · Meeting"
        title="Meeting — recording, live transcription, and summaries"
        description="Start recording a meeting from a small widget, and your speech is transcribed to text in real time. When the meeting ends, minutes and a summary are generated automatically, and action items flow into the work board."
        tags={["real-time STT", "auto summary", "automated follow-up"]}
      />

      <ScreenshotGallery columns={2}>
        <ScreenshotCard src={shotUrl("meeting-upcoming")} caption={shots["meeting-upcoming"].captionEn} />
        <ScreenshotCard src={shotUrl("meeting-record")} caption={shots["meeting-record"].captionEn} />
        <ScreenshotCard src={shotUrl("meeting-record-stt")} caption={shots["meeting-record-stt"].captionEn} />
        <ScreenshotCard src={shotUrl("meeting-minutes")} caption={shots["meeting-minutes"].captionEn} />
      </ScreenshotGallery>

      <h2 id="minutes">Automatically generated meeting minutes</h2>
      <p>
        When a meeting ends, the host LLM automatically produces a one-page set of minutes. Users don't have to write them up every time, and the format stays consistent.
        Everything is handled on one screen — a per-speaker transcript, action items, notes, and sharing.
      </p>
      <ScreenshotGallery columns={2}>
        <ScreenshotCard src={shotUrl("meeting-minutes-2")} caption={shots["meeting-minutes-2"].captionEn} />
        <ScreenshotCard src={shotUrl("meeting-minutes-3")} caption={shots["meeting-minutes-3"].captionEn} />
      </ScreenshotGallery>

      <h2 id="record">From start of recording to meeting minutes</h2>
      <ul>
        <li><strong>One click on the widget</strong> → requests microphone permission, then starts recording.</li>
        <li><strong>Live transcription</strong> → speech is transcribed in short chunks and shown on screen immediately.</li>
        <li><strong>Stop → minutes + summary generated automatically</strong> → the full minutes are stored in a secure per-plugin area.</li>
        <li><strong>Floating window</strong> → can float on top of other windows for taking notes during the meeting.</li>
      </ul>

      <h2 id="scenario">Real-world scenario — one "start meeting" click handles a 30-minute flow unattended</h2>
      <ScreenshotGallery columns={2}>
        <ScreenshotCard src={shotUrl("work-assistant-meeting-end-trigger")} caption={shots["work-assistant-meeting-end-trigger"].captionEn} />
        <ScreenshotCard src={shotUrl("work-assistant-meeting-end-trigger-2")} caption={shots["work-assistant-meeting-end-trigger-2"].captionEn} />
      </ScreenshotGallery>
      <StepList
        steps={[
          { title: "Meeting starts", body: <p>Click "start recording" on the widget → microphone permission → live transcription during the meeting.</p>, badge: "recording" },
          { title: "Transcript shown live", body: <p>Speech streams onto the screen in short chunks. Users can mark or bookmark moments while it's still in progress.</p>, badge: "STT" },
          { title: "Meeting ends → summary generated automatically", body: <p>When the user clicks "end" or the host detects the meeting has ended, the whole meeting is summarized into a paragraph and action items are extracted along with it.</p>, badge: "summary" },
          { title: "Automated follow-up to work board / mail", body: <p>Work Assistant surfaces the action items as a confirmation card, and once approved, registers them simultaneously to the work board and the host TODO list.</p>, badge: "follow-up" },
        ]}
      />

      <Callout tone="info" title="The host chooses the STT model">
        The speech recognition model used for transcription can be chosen in host settings. Keys and cost are managed centrally by the host, and the plugin simply asks for "some transcription, please."
      </Callout>

      <PageNav />
    </article>
  );
}
