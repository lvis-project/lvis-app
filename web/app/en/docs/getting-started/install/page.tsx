import { PageHero } from "@/components/docs/page-hero";
import { StepList } from "@/components/docs/step-list";
import { Callout } from "@/components/docs/callout";
import { FeatureGrid } from "@/components/docs/feature-grid";
import { PageNav } from "@/components/docs/page-nav";
import { Apple, MonitorDown, Terminal } from "lucide-react";

export const metadata = { title: "Install & First Launch" };

export default function Page() {
  return (
    <article>
      <PageHero
        eyebrow="Getting Started"
        title="Install & First Launch"
        description="The LVIS AI host app ships as an Electron desktop build, packaged per OS. This covers install → first launch → right up to Marketplace login."
        tags={["macOS arm64", "Windows x64", "Linux AppImage", "electron-updater"]}
      />

      <FeatureGrid
        items={[
          { icon: <Apple className="h-5 w-5" />, title: "macOS (Apple Silicon)", body: <>Drag the `.dmg` file into Applications. Confirm the Gatekeeper first-run prompt → the main host window opens.</>, tone: "teal" },
          { icon: <MonitorDown className="h-5 w-5" />, title: "Windows 10+", body: <>Double-click the `.exe` installer. It registers in the Start menu and launches automatically.</> },
          { icon: <Terminal className="h-5 w-5" />, title: "Linux", body: <>Grant execute permission (`chmod +x`) to the `.AppImage` file and run it. <code>latest-linux.yml</code> is the update manifest.</> },
        ]}
      />

      <h2 id="install">Installation steps</h2>
      <StepList
        steps={[
          { title: "Download the build for your OS", body: <p>Get macOS arm64 / Windows x64 / Linux AppImage from <a href="https://lvisai.xyz/en#download">lvisai.xyz/#download</a>.</p>, badge: "5 min" },
          { title: "Grant execute permission & double-click", body: <>
            <p>macOS: if a first-run security warning appears, go to <strong>System Settings → Privacy & Security</strong> and choose "Open Anyway."</p>
            <p>Linux: run <code>chmod +x lvis-ai-*.AppImage</code>, then double-click or run it from a terminal.</p>
          </> },
          { title: "Splash screen → main host (App.tsx)", body: <p>Once the LVIS splash screen disappears, the main host opens with an empty chat body (<code>src/ui/renderer/App.tsx:1249-1290</code>). At this point no plugins are registered yet.</p> },
          { title: "Deeplink registration", body: <p>The OS maps the <code>lvis://</code> protocol handler to the host app (<code>src/main/lvis-protocol.ts</code>). After this, clicking "Install" in the Marketplace routes to the host.</p>, badge: "lvis://" },
          { title: "Move on to Marketplace login", body: <p>The next step to get plugins is Marketplace login — via "Log in" at the bottom left or the account icon at the top right.</p> },
        ]}
      />

      <Callout tone="security" title="Permissions at first launch">
        LVIS does not access any external data, the filesystem, or plugins at first launch.
        All permissions are granted through an explicit user-consent dialog at plugin install / activation time.
        See <a href="/en/docs/plugins/permission-grant">the plugin permission grant flow</a> for details.
      </Callout>

      <PageNav />
    </article>
  );
}
