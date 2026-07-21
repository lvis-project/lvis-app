import { PageHero } from "@/components/docs/page-hero";
import { ScreenshotCard, ScreenshotGallery } from "@/components/docs/screenshot-card";
import { Callout } from "@/components/docs/callout";
import { PageNav } from "@/components/docs/page-nav";
import { shotUrl, shots } from "@/lib/screenshots";

export const metadata = { title: "App Updates" };

export default function Page() {
  return (
    <article>
      <PageHero
        eyebrow="Getting Started"
        title="App Updates"
        description="LVIS periodically checks in the background for new versions. Nothing is downloaded or force-installed without your consent."
        tags={["No auto-download", "You choose to restart", "Rollback available"]}
      />

      <ScreenshotGallery columns={1}>
        <ScreenshotCard src={shotUrl("chat-app-update")} caption={shots["chat-app-update"].captionEn} aspect="wide" />
      </ScreenshotGallery>

      <h2 id="how">How updates are applied</h2>
      <ul>
        <li>The host only checks for a new version at regular intervals.</li>
        <li>Even when a new version is detected, it is not downloaded automatically.</li>
        <li>Once the download completes, a "Restart to update" card appears at the top of the chat area.</li>
        <li>The new build is applied only the moment you click "Restart."</li>
      </ul>

      <Callout tone="info" title="Rollback">
        If something goes wrong after an update, the host guides you through reverting to the previous version.
        Marketplace also has an operator-side rollback, so if an issue is widespread, operators can revert the package in bulk.
      </Callout>

      <PageNav />
    </article>
  );
}
