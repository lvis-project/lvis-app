import { PageHero } from "@/components/docs/page-hero";
import { ScreenshotCard, ScreenshotGallery } from "@/components/docs/screenshot-card";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Callout } from "@/components/docs/callout";
import { PageNav } from "@/components/docs/page-nav";
import { shotUrl, shots } from "@/lib/screenshots";

export const metadata = { title: "LGE EP Plugin" };

export default function Page() {
  return (
    <article>
      <PageHero
        eyebrow="Plugin · LGE EP"
        title="LGE EP — bringing the corporate portal into LVIS"
        description="A single sign-in to the corporate portal EP handles attendance, approvals, parking, meeting room booking, video calls, and the internal search tool LGenie, all inside LVIS chat. Works only on the corporate network."
        tags={["intranet only", "EP unified SSO"]}
      />

      <Tabs defaultValue="login" className="my-6">
        <TabsList className="flex flex-wrap">
          <TabsTrigger value="login">Login</TabsTrigger>
          <TabsTrigger value="attendance">Attendance</TabsTrigger>
          <TabsTrigger value="approval">Approvals</TabsTrigger>
          <TabsTrigger value="parking">Parking</TabsTrigger>
          <TabsTrigger value="facility">Meeting rooms</TabsTrigger>
          <TabsTrigger value="video">Video calls</TabsTrigger>
          <TabsTrigger value="lgenie">LGenie</TabsTrigger>
        </TabsList>

        <TabsContent value="login">
          <ScreenshotGallery columns={1}>
            <ScreenshotCard src={shotUrl("ep-login")} caption={shots["ep-login"].captionEn} aspect="wide" />
          </ScreenshotGallery>
          <p>A single sign-in to EP means every domain afterward shares the same session. LVIS never stores your password.</p>
        </TabsContent>

        <TabsContent value="attendance">
          <ScreenshotGallery columns={3}>
            <ScreenshotCard src={shotUrl("ep-attendance")} caption={shots["ep-attendance"].captionEn} />
            <ScreenshotCard src={shotUrl("ep-attendance-2")} caption={shots["ep-attendance-2"].captionEn} />
            <ScreenshotCard src={shotUrl("ep-attendance-3")} caption={shots["ep-attendance-3"].captionEn} />
          </ScreenshotGallery>
          <p>Check daily/weekly/monthly attendance right in chat, and handle clock-in/out, remote work, and leave requests all on one screen.</p>
        </TabsContent>

        <TabsContent value="approval">
          <ScreenshotGallery columns={1}>
            <ScreenshotCard src={shotUrl("ep-approval")} caption={shots["ep-approval"].captionEn} aspect="wide" />
          </ScreenshotGallery>
          <p>Shows pending / in-progress / completed approvals in a single line. Answers natural-language questions like "how many approvals are pending?" instantly.</p>
        </TabsContent>

        <TabsContent value="parking">
          <ScreenshotGallery columns={1}>
            <ScreenshotCard src={shotUrl("ep-parking")} caption={shots["ep-parking"].captionEn} aspect="wide" />
          </ScreenshotGallery>
          <p>Handles vehicle registration, checking remaining slots, and visitor parking requests all on one screen.</p>
        </TabsContent>

        <TabsContent value="facility">
          <ScreenshotGallery columns={3}>
            <ScreenshotCard src={shotUrl("ep-meeting-room")} caption={shots["ep-meeting-room"].captionEn} />
            <ScreenshotCard src={shotUrl("ep-meeting-room-2")} caption={shots["ep-meeting-room-2"].captionEn} />
            <ScreenshotCard src={shotUrl("ep-meeting-room-3")} caption={shots["ep-meeting-room-3"].captionEn} />
            <ScreenshotCard src={shotUrl("ep-meeting-room-4")} caption={shots["ep-meeting-room-4"].captionEn} />
            <ScreenshotCard src={shotUrl("ep-meeting-room-5")} caption={shots["ep-meeting-room-5"].captionEn} />
          </ScreenshotGallery>
          <p>One flow from room search → checking availability → confirming the booking. Combined with Work Assistant, natural-language requests like "book a main-building room when all 3 of us are free" also work.</p>
        </TabsContent>

        <TabsContent value="video">
          <ScreenshotGallery columns={2}>
            <ScreenshotCard src={shotUrl("ep-video-call")} caption={shots["ep-video-call"].captionEn} />
            <ScreenshotCard src={shotUrl("ep-video-call-2")} caption={shots["ep-video-call-2"].captionEn} />
            <ScreenshotCard src={shotUrl("ep-video-call-3")} caption={shots["ep-video-call-3"].captionEn} />
            <ScreenshotCard src={shotUrl("ep-video-call-4")} caption={shots["ep-video-call-4"].captionEn} />
          </ScreenshotGallery>
          <p>The video call flow, from participants and options through to ending the call. Connect it with the Meeting plugin's STT to automatically generate minutes and a summary.</p>
        </TabsContent>

        <TabsContent value="lgenie">
          <ScreenshotGallery columns={2}>
            <ScreenshotCard src={shotUrl("ep-lgenie")} caption={shots["ep-lgenie"].captionEn} />
            <ScreenshotCard src={shotUrl("ep-lgenie-2")} caption={shots["ep-lgenie-2"].captionEn} />
          </ScreenshotGallery>
          <p>Brings results from the internal search tool LGenie into LVIS chat context. Answers questions about internal policies, regulations, and forms with citations.</p>
        </TabsContent>
      </Tabs>

      <Callout tone="security" title="Intranet only">
        Login is automatically blocked from outside the corporate network. Sessions are kept only inside the plugin's own area and cannot be accessed by other plugins.
      </Callout>

      <h2 id="scenario">Real-world scenario — a morning that starts with one line, "clocking in"</h2>
      <ul>
        <li>Type "clocking in" in chat → attendance is recorded + a preview card of today's schedule appears.</li>
        <li>30 minutes before your first meeting → a card with available room candidates, booked in one click.</li>
        <li>A meeting with external attendees → a video call is created automatically and the link is attached to the event.</li>
      </ul>

      <PageNav />
    </article>
  );
}
