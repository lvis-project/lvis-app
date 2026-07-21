import { PageHero } from "@/components/docs/page-hero";
import { ScreenshotCard, ScreenshotGallery } from "@/components/docs/screenshot-card";
import { StepList } from "@/components/docs/step-list";
import { Callout } from "@/components/docs/callout";
import { PageNav } from "@/components/docs/page-nav";
import { shotUrl, shots } from "@/lib/screenshots";

export const metadata = { title: "Microsoft 365 (Outlook) Plugin" };

export default function Page() {
  return (
    <article>
      <PageHero
        eyebrow="Plugin · Microsoft 365"
        title="Microsoft 365 — Outlook mail + calendar"
        description="Sign in to your Microsoft account once, and your mail and calendar come into LVIS. Natural-language requests like 'sort out the meeting requests' or 'show me today's schedule' are handled right in chat."
        tags={["Outlook mail", "Outlook calendar", "sign in once"]}
      />

      <h2 id="login">Login flow</h2>
      <ScreenshotGallery columns={2}>
        <ScreenshotCard src={shotUrl("outlook-login-trigger")} caption={shots["outlook-login-trigger"].captionEn} />
        <ScreenshotCard src={shotUrl("outlook-login-window")} caption={shots["outlook-login-window"].captionEn} />
        <ScreenshotCard src={shotUrl("outlook-login-after")} caption={shots["outlook-login-after"].captionEn} />
        <ScreenshotCard src={shotUrl("outlook-logout")} caption={shots["outlook-logout"].captionEn} />
      </ScreenshotGallery>

      <ul>
        <li>Click the "Sign in to Microsoft 365" card → the standard Microsoft login window opens to collect consent securely.</li>
        <li>Once you sign in, the token is stored encrypted in LVIS's secure storage.</li>
        <li>Signing out deletes the token immediately, and you'll sign in again the next time you use it.</li>
      </ul>

      <h2 id="features">Feature summary</h2>
      <ul>
        <li><strong>Mail</strong> — browse inbox, search, generate reply drafts, send (after user confirmation), watch for new mail.</li>
        <li><strong>Calendar</strong> — view today's schedule, find free time, create/update/delete events, detect recurrence patterns, detect conflicts.</li>
      </ul>

      <h2 id="scenario">Real-world scenario — one meeting-request email becomes a scheduled event plus a reply</h2>
      <StepList
        steps={[
          { title: "A meeting request email arrives", body: <p>When a new email contains a keyword like "meeting", the host detects the incoming mail.</p>, badge: "mail" },
          { title: "Body analysis → candidate times extracted", body: <p>Automatically pulls out the proposed dates, times, and attendees from the body.</p>, badge: "analysis" },
          { title: "Free-time search", body: <p>Checks the calendar for the proposed time slots — moves on if free, or shows a confirmation card if there's a conflict.</p>, badge: "calendar" },
          { title: "Reply draft generated automatically", body: <p>A reply draft appears as a card in chat. It's only actually sent the moment the user clicks "Send".</p>, badge: "confirm before send" },
        ]}
      />

      <Callout tone="security" title="Risky actions like sending always require confirmation">
        "Write" actions such as sending mail or creating events go through a confirmation card or dialog, and stop immediately with no fallback if the permission has been revoked.
      </Callout>

      <Callout tone="info" title="Consolidation of two former plugins">
        Mail and calendar used to be separate plugins. Now they're merged into one, so a single sign-in covers both.
      </Callout>

      <PageNav />
    </article>
  );
}
