import { PageHero } from "@/components/docs/page-hero";
import { ScreenshotCard, ScreenshotGallery } from "@/components/docs/screenshot-card";
import { FeatureGrid } from "@/components/docs/feature-grid";
import { PageNav } from "@/components/docs/page-nav";
import { shotUrl, shots } from "@/lib/screenshots";
import { Callout } from "@/components/docs/callout";

export const metadata = { title: "Plugin Panel" };

export default function Page() {
  return (
    <article>
      <PageHero
        eyebrow="Host · Chat"
        title="The Plugin Panel Inside Chat"
        description="Active plugins are surfaced in the sidebar. Each plugin exposes UI slots, instruction Skills, and callable Tools through one validated manifest. The host core never imports plugin-specific code directly."
      />

      <ScreenshotGallery columns={1}>
        <ScreenshotCard src={shotUrl("chat-plugin-panel")} caption={shots["chat-plugin-panel"].captionEn} aspect="wide" />
      </ScreenshotGallery>

      <FeatureGrid
        columns={3}
        items={[
          { title: "Bundled Skills", body: <>A manifest <code>skills[]</code> entry installs a verified <code>SKILL.md</code> instruction bundle. Natural-language text never invokes or preloads a Tool implicitly.</>, tone: "teal" },
          { title: "ui[] slots", body: <>plugin.json's <code>ui[]</code> declares <code>slot</code> (sidebar/chat/popover/embedded) · <code>kind</code> (embedded-module/url) · <code>entry</code> · <code>exportName</code> · <code>window</code>.</> },
          { title: "Tools list", body: <>Tools are statically declared in the manifest's <code>tools[]</code>. Handlers live in the <code>RuntimePlugin.handlers</code> map. Tool name regex: <code>^[a-zA-Z_][a-zA-Z0-9_]*$</code>.</>, tone: "citron" },
        ]}
      />

      <h2 id="naming">Naming conventions — three namespaces</h2>
      <ul>
        <li><strong>LLM tool names</strong>: <code>^[a-zA-Z_][a-zA-Z0-9_]*$</code> (<code>src/plugins/runtime/manifest-validation.ts</code>). No leading digits or dashes — a common vendor requirement (OpenAI / Gemini / Claude alike).</li>
        <li><strong>Skill / agent / session id</strong>: separate — <code>^[a-zA-Z0-9_-]+$</code> (<code>src/main/skill-store.ts</code>). Dashes allowed.</li>
        <li><strong>Plugin id</strong>: typically kebab-case (e.g. <code>local-indexer</code>, <code>ms-graph</code>). The manifest's <code>id</code> field.</li>
      </ul>

      <Callout tone="info" title="Plugin tools come from the manifest">
        The host runs each plugin as an <strong>in-process MCP server</strong> and reads the tool list that server offers into the Tool Registry.
        The server is projected straight from the plugin manifest (<code>src/mcp/plugin-server-projection.ts</code>), and the wiring happens during boot (<code>src/mcp/plugin-loopback-manager.ts</code> · <code>src/boot/steps/plugin-runtime.ts</code>).
      </Callout>

      <Callout tone="info" title="That list is fixed per server generation">
        A plugin's server does not advertise that it will announce list changes — it has no channel to send the notification on, so it reports <code>listChanged: false</code> (<code>src/mcp/plugin-server-projection.ts</code>).
        Changing a plugin's tools means redeploying it and bringing its server up again.
        <strong>External MCP servers differ</strong> — an external server can send a list-changed notification, and on receiving one the host re-fetches the tool list (<code>src/mcp/mcp-client.ts</code>).
      </Callout>

      <PageNav />
    </article>
  );
}
