import { PageHero } from "@/components/docs/page-hero";
import { ScreenshotCard, ScreenshotGallery } from "@/components/docs/screenshot-card";
import { Callout } from "@/components/docs/callout";
import { PageNav } from "@/components/docs/page-nav";
import { shotUrl, shots } from "@/lib/screenshots";

export const metadata = { title: "Marketplace — Plugin Catalog" };

export default function Page() {
  return (
    <article>
      <PageHero
        eyebrow="Marketplace"
        title="Plugin Catalog"
        description="Shows installable plugins on a single screen. Each card displays the id · latest version · required permission summary · publisher · download statistics."
      />

      <ScreenshotGallery columns={1}>
        <ScreenshotCard src={shotUrl("mp-plugin")} caption={shots["mp-plugin"].captionEn} aspect="wide" />
      </ScreenshotGallery>

      <h2 id="install">Install Flow</h2>
      <ul>
        <li>Pressing the "Install" button on the web page sends a registration request to the LVIS host.</li>
        <li>The host re-verifies the package's origin signature and shows the user the list of required permissions.</li>
        <li>Once the user confirms, the plugin is installed into a secure area of the host and first activation proceeds.</li>
        <li>Nothing happens automatically right after install. Every risky action only starts when the user directly triggers it.</li>
      </ul>

      <Callout tone="security" title="Immediate rejection on verification failure">
        If the manifest or signature fails verification, the host immediately rejects the install and records a rejection event in the audit log. There is no bypass path.
      </Callout>

      <PageNav />
    </article>
  );
}
