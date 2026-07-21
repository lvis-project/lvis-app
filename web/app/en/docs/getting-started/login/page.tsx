import { PageHero } from "@/components/docs/page-hero";
import { StepList } from "@/components/docs/step-list";
import { ScreenshotCard, ScreenshotGallery } from "@/components/docs/screenshot-card";
import { Callout } from "@/components/docs/callout";
import { PageNav } from "@/components/docs/page-nav";
import { shotUrl, shots } from "@/lib/screenshots";

export const metadata = { title: "Login & First Screen" };

export default function Page() {
  return (
    <article>
      <PageHero
        eyebrow="Getting Started"
        title="Marketplace Login & First Screen"
        description="The host app itself is local-first, but a Marketplace account plus Agent Hub server authentication is required for the plugin catalog, downloads, and signature verification. Auth is handled on the plugin side via hostApi.openAuthWindow / hostApi.openAuthPartitionViewer."
      />

      <h2 id="why">Why do I need to log in?</h2>
      <ul>
        <li><strong>Marketplace</strong> — plugin catalog reads + package downloads (the <code>lvis://install/&lt;slug&gt;</code> deeplink routes to the host).</li>
        <li><strong>Agent Hub</strong> — Work Board / Inbox sync (HTTPBearer token, <code>agent-hub.lvisai.xyz</code>).</li>
        <li><strong>ms-graph, lge-api</strong> — each plugin's own OAuth (MSAL · EP SSO). Tokens are isolated to the plugin namespace.</li>
      </ul>

      <h2 id="flow">Login flow</h2>
      <StepList
        steps={[
          { title: "Main host → Marketplace SSO", body: <p>Enter the Marketplace LoginPage in a web browser. The Marketplace server (<code>marketplace.lvisai.xyz</code>) responds via <code>/api/v1/auth/*</code>.</p> },
          { title: "API key issuance", body: <p>On successful login an ApiKey (publisher/admin role) is issued, and the client verifies that the key's sha256 hash matches <code>api_keys.key_hash</code> in the server DB.</p>, badge: "one-time" },
          { title: "Agent Hub token", body: <p>Using the Work Board requires a separate Agent Hub <code>/auth/exchange/issue</code> + <code>/auth/exchange/redeem</code> flow (<code>lvis-agent-hub/src/.../api/auth_exchange.py</code>). PKCE-like.</p> },
          { title: "Plugin OAuth — when needed", body: <p>ms-graph (MSAL) / lge-api (EP SSO) are handled separately via <code>hostApi.openAuthWindow</code> on first use after plugin install.</p> },
        ]}
      />

      <h2 id="first-screen">First screen — what does it look like?</h2>
      <ScreenshotGallery columns={2}>
        <ScreenshotCard src={shotUrl("chat-plugin-panel")} caption={shots["chat-plugin-panel"].captionEn} />
        <ScreenshotCard src={shotUrl("chat-question-card")} caption={shots["chat-question-card"].captionEn} />
      </ScreenshotGallery>

      <Callout tone="tip" title="What works without logging in">
        The host chat and local plugins (e.g. Local Indexer's pre-indexed folders) work without logging in.
        However, installing new plugins, the Marketplace catalog, and Agent Hub board sync are disabled.
      </Callout>

      <PageNav />
    </article>
  );
}
