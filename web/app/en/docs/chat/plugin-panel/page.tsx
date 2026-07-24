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
        <li><strong>LLM tool names</strong>: <code>^[a-zA-Z_][a-zA-Z0-9_]*$</code> (<code>src/plugins/runtime/manifest-validation.ts:289</code>). No leading digits or dashes — a common vendor requirement (OpenAI / Gemini / Claude alike).</li>
        <li><strong>Skill / agent / session id</strong>: separate — <code>^[a-zA-Z0-9_-]+$</code> (<code>src/core/skill-store.ts:30</code>). Dashes allowed.</li>
        <li><strong>Plugin id</strong>: typically kebab-case (e.g. <code>local-indexer</code>, <code>ms-graph</code>). The manifest's <code>id</code> field.</li>
      </ul>

      <Callout tone="info" title="There's no runtime registration API">
        At host boot, <code>src/boot.ts:703-736</code> registers every plugin manifest's <code>tools[]</code> into the Tool Registry.
        There is no API to add tools dynamically at runtime — changing tools requires redeploying and restarting the plugin.
      </Callout>

      <PageNav />
    </article>
  );
}
