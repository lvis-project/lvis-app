import { PageHero } from "@/components/docs/page-hero";
import { ScreenshotCard, ScreenshotGallery } from "@/components/docs/screenshot-card";
import { Callout } from "@/components/docs/callout";
import { PageNav } from "@/components/docs/page-nav";
import { shotUrl, shots } from "@/lib/screenshots";

export const metadata = { title: "Marketplace — MCP Servers" };

export default function Page() {
  return (
    <article>
      <PageHero
        eyebrow="Marketplace"
        title="MCP Server Catalog (plugin_type=mcp)"
        description="A directory of servers compatible with Anthropic's Model Context Protocol. Hosts register MCP servers from the catalog to expose additional tool sets in the Tool Registry as source='mcp'. Registration info is kept in ~/.lvis/mcp/servers.json."
      />

      <ScreenshotGallery columns={1}>
        <ScreenshotCard src={shotUrl("mp-mcp")} caption={shots["mp-mcp"].captionEn} aspect="wide" />
      </ScreenshotGallery>

      <h2 id="what">What Is MCP?</h2>
      <p>
        Model Context Protocol — an open spec proposed by Anthropic defining "how an LLM calls an external server's tools/resources/prompts through a standard interface."
        Besides native plugins, the LVIS host can register MCP servers to easily bring in additional tools.
      </p>

      <h2 id="register">Registration Flow</h2>
      <ol>
        <li>Fire the <code>lvis://mcp-login/&lt;slug&gt;</code> deeplink from the Storefront (PluginDetailPage:178), or enter the endpoint directly.</li>
        <li>The host performs an MCP handshake to fetch server metadata / tool list, then stores metadata under <code>~/.lvis/mcp/&lt;slug&gt;/</code>.</li>
        <li>Registers into <code>~/.lvis/mcp/servers.json</code> (boot.ts:1012-1016).</li>
        <li>Registered in the Tool Registry as source='mcp'. The reviewer classifies it as <code>medium</code> RiskLevel by default.</li>
      </ol>

      <Callout tone="security" title="RiskLevel for MCP tools">
        Tools from external MCP servers default to <strong>medium</strong>. Even if the publisher supplies risk metadata, it gets reclassified at the admin stage.
        Exposure as auto-executable (low) requires explicit admin approval.
      </Callout>

      <PageNav />
    </article>
  );
}
