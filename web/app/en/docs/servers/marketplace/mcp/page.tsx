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
        <li>Fire the <code>lvis://mcp-login/&lt;slug&gt;</code> deeplink from the Storefront, or enter the endpoint directly. (The Storefront is the marketplace web app, which lives in a separate repository.)</li>
        <li>The host performs an MCP handshake to fetch server metadata / tool list, then stores metadata under <code>~/.lvis/mcp/&lt;slug&gt;/</code>.</li>
        <li>Registers into <code>~/.lvis/mcp/servers.json</code> (host path: <code>src/mcp/mcp-manager.ts</code>).</li>
        <li>Registered in the Tool Registry as source=&apos;mcp&apos;. The host places that origin at the lowest of its three trust levels (<code>src/tools/types.ts</code>).</li>
      </ol>

      <Callout tone="security" title="Registering one does not make it auto-run">
        The host treats tools from an external MCP server at the lowest of its three trust levels, and <strong>filters them out of the risk-band auto-allow path into a confirmation card</strong> — read-only tools included.
        Which cases skip that prompt, and how far each one reaches, is set out on the <a href="/en/docs/host/mcp#beyond-tools">MCP servers page</a>.
      </Callout>

      <PageNav />
    </article>
  );
}
