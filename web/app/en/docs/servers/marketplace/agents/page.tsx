import { PageHero } from "@/components/docs/page-hero";
import { ScreenshotCard, ScreenshotGallery } from "@/components/docs/screenshot-card";
import { Callout } from "@/components/docs/callout";
import { PageNav } from "@/components/docs/page-nav";
import { shotUrl, shots } from "@/lib/screenshots";

export const metadata = { title: "Marketplace — Agents" };

export default function Page() {
  return (
    <article>
      <PageHero
        eyebrow="Marketplace"
        title="Agents (plugin_type=agent)"
        description="A view over the same catalog API filtered by plugin_type=agent. Shows smaller, single-task packages than Plugins. Not a separate REST resource/model — the same Plugin row with a plugin_type discriminator."
      />

      <ScreenshotGallery columns={1}>
        <ScreenshotCard src={shotUrl("mp-agents")} caption={shots["mp-agents"].captionEn} aspect="wide" />
      </ScreenshotGallery>

      <h2 id="how">Data Model</h2>
      <p>
        The Marketplace DB has exactly one <code>Plugin</code> model (<code>server/src/lvis_marketplace/models.py:31</code>). The <code>plugin_type</code> column distinguishes plugin / agent / mcp / skill.
        Cards on the Agents page render the <code>GET /api/v1/catalog?plugin_type=agent</code> response as-is.
      </p>

      <Callout tone="info" title="Install deeplink format differs">
        agent / mcp / skill use a deeplink that includes a type prefix: <code>lvis://install/&lt;type&gt;/&lt;slug&gt;</code>.
        Example: <code>lvis://install/agent/weekly-retro</code>. The host applies additional manifest verification + different sandbox settings depending on type.
      </Callout>

      <PageNav />
    </article>
  );
}
