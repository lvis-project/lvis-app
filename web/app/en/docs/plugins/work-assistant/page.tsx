import { PageHero } from "@/components/docs/page-hero";
import { ScreenshotCard, ScreenshotGallery } from "@/components/docs/screenshot-card";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Callout } from "@/components/docs/callout";
import { StepList } from "@/components/docs/step-list";
import { PageNav } from "@/components/docs/page-nav";
import { shotUrl, shots } from "@/lib/screenshots";

export const metadata = { title: "Work Assistant Plugin" };

export default function Page() {
  return (
    <article>
      <PageHero
        eyebrow="Plugin · Work Assistant"
        title="Work Assistant — quietly helping with schedules, meetings, and mail"
        description="Without being explicitly asked, it automatically detects situations like schedule conflicts, upcoming reminders, and meeting follow-up actions, and suggests them with a single quiet card at the moment it would help most."
        tags={["quiet suggestions", "schedule · meeting · mail integration"]}
      />

      <h2 id="screens">Auto-detection → card sequence</h2>
      <Tabs defaultValue="conflict" className="my-6">
        <TabsList className="flex flex-wrap">
          <TabsTrigger value="conflict">Schedule conflict</TabsTrigger>
          <TabsTrigger value="reminder">Advance reminder</TabsTrigger>
          <TabsTrigger value="meeting-end">Meeting ends → action</TabsTrigger>
        </TabsList>
        <TabsContent value="conflict">
          <ScreenshotGallery columns={2}>
            <ScreenshotCard src={shotUrl("work-assistant-conflict")} caption={shots["work-assistant-conflict"].captionEn} />
            <ScreenshotCard src={shotUrl("work-assistant-conflict-2")} caption={shots["work-assistant-conflict-2"].captionEn} />
          </ScreenshotGallery>
          <p>When a new event overlaps with an existing one, a notification card appears letting you choose "reschedule / decline / ignore".</p>
        </TabsContent>
        <TabsContent value="reminder">
          <ScreenshotGallery columns={2}>
            <ScreenshotCard src={shotUrl("work-assistant-reminder")} caption={shots["work-assistant-reminder"].captionEn} />
            <ScreenshotCard src={shotUrl("work-assistant-reminder-2")} caption={shots["work-assistant-reminder-2"].captionEn} />
          </ScreenshotGallery>
          <p>N minutes before a meeting starts, a single card shows the room location, video call link, and an agenda summary.</p>
        </TabsContent>
        <TabsContent value="meeting-end">
          <ScreenshotGallery columns={2}>
            <ScreenshotCard src={shotUrl("work-assistant-meeting-end-trigger")} caption={shots["work-assistant-meeting-end-trigger"].captionEn} />
            <ScreenshotCard src={shotUrl("work-assistant-meeting-end-trigger-2")} caption={shots["work-assistant-meeting-end-trigger-2"].captionEn} />
          </ScreenshotGallery>
          <p>When a meeting ends, action items automatically extracted from the minutes are suggested as a single card → moved to the board after user confirmation.</p>
        </TabsContent>
      </Tabs>

      <h2 id="detectors">Signals it watches automatically</h2>
      <ul>
        <li><strong>Mail</strong> — approval requests / meeting requests / needs-a-reply / general action items</li>
        <li><strong>Calendar</strong> — upcoming meetings / new events added / schedule conflicts</li>
        <li><strong>Meeting</strong> — minutes finished being written</li>
        <li><strong>Work board</strong> — tasks with an approaching deadline</li>
        <li><strong>Meeting rooms · video calls</strong> — recommending an available room / detecting a missing video link</li>
      </ul>

      <h2 id="scenario">Real-world scenario — daily briefing</h2>
      <StepList
        steps={[
          { title: "Fires automatically once a day", body: <p>Runs only once, at the same time each day. It records the last run time in its own area so it never fires twice on the same day.</p>, badge: "once/day" },
          { title: "Gathering today's signals", body: <p>Collects today's schedule, recent meetings, unhandled mail, and active work items all at once to build candidate paragraphs.</p>, badge: "collect" },
          { title: "Summarized into 3-5 Korean sentences", body: <p>Automatically trims the body if it's too long, and falls back to a plain list if tokens run short.</p>, badge: "summary" },
          { title: "The \"Today's Briefing\" card", body: <p>Appears gently in the chat body. If the user wasn't present, it's shown with priority the next time they're active.</p>, badge: "quiet suggestion" },
        ]}
      />

      <Callout tone="security" title="Allowed domains are set by the user">
        Rules like "only recognize mail from this domain as a meeting" aren't hardcoded — they can be changed directly in user settings.
        The default is empty, which prevents unintended behavior.
      </Callout>

      <PageNav />
    </article>
  );
}
