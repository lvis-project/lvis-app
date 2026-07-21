import { PageHero } from "@/components/docs/page-hero";
import { ScreenshotCard, ScreenshotGallery } from "@/components/docs/screenshot-card";
import { StepList } from "@/components/docs/step-list";
import { Callout } from "@/components/docs/callout";
import { PageNav } from "@/components/docs/page-nav";
import { shotUrl, shots } from "@/lib/screenshots";

export const metadata = { title: "Plugin Permission Grant Flow" };

export default function Page() {
  return (
    <article>
      <PageHero
        eyebrow="Plugins"
        title="Permission grant flow"
        description="When a plugin is activated for the first time, a single unified dialog shows the user every permission element declared in its manifest (capabilities · tools categories · pluginAccess · hostSecrets · agentApprovalScopes) at once."
      />

      <ScreenshotGallery columns={1}>
        <ScreenshotCard src={shotUrl("plugin-permission-grant")} caption={shots["plugin-permission-grant"].captionEn} aspect="wide" />
      </ScreenshotGallery>

      <h2 id="what">Items reviewed from the manifest</h2>
      <ul>
        <li><strong>capabilities</strong>: 12 items in a closed enum — <code>mail-source</code>, <code>calendar-source</code>, <code>meeting-recorder</code>, <code>knowledge-index</code>, <code>background-watcher</code>, <code>external-auth-consumer</code>, <code>document-indexer</code>, <code>routine-provider</code>, <code>lifecycle-observer</code>, <code>worker-client</code>, <code>ms-graph-consumer</code>, <code>host:overlay</code>.</li>
        <li><strong>tools[]</strong>: the list of tool names. Each tool's <code>toolSchemas.&lt;name&gt;.category</code> — <code>read | write | shell | network | meta</code> — is grouped by category and shown to the user.</li>
        <li><strong>pluginAccess</strong>: which other plugin's tools/events this plugin will use (e.g. work-assistant calling ms-graph's <code>msgraph_calendar_today</code>).</li>
        <li><strong>agentApprovalScopes</strong>: standard labels for cross-plugin risky actions (e.g. <code>agent_file_share</code>, <code>agent_task_delegate</code>, <code>agent_external_api_call</code>).</li>
        <li><strong>hostSecrets / llmKeySource</strong>: secret access / LLM key vendor declarations.</li>
        <li><strong>configSchema</strong>: user-editable config fields + defaults.</li>
      </ul>

      <h2 id="flow">What the user sees</h2>
      <StepList
        steps={[
          { title: "Deeplink from Marketplace", body: <p>The "Install" button on the web page fires <code>lvis://install/&lt;slug&gt;</code> or <code>lvis://install/&lt;type&gt;/&lt;slug&gt;</code>. The host receives and handles the URL (<code>lvis-protocol.ts:72</code>).</p> },
          { title: "Package + signature verification", body: <p>The host verifies the Ed25519 signature envelope issued by the Marketplace. It passes once at least one signature matches a known public key (<code>marketplace/server/src/lvis_marketplace/signing.py:219</code>).</p>, badge: "sig" },
          { title: "Permission dialog — everything at once", body: <p>The parsed manifest is grouped by category — capabilities / tools / pluginAccess / secrets — and shown together. The grant is saved once the user confirms.</p> },
          { title: "First activation", body: <p>Its own namespace <code>{"~/.lvis/plugins/<pluginId>/"}</code> is created (0o700). The plugin's <code>start()</code> callback is called — <code>hostApi.registerKeywords</code> is registered if present.</p>, badge: "start()" },
        ]}
      />

      <Callout tone="warn" title="Behavior after revoking a permission">
        Even after installation, a grant can be revoked from Host Settings → Plugins → the plugin → Permission Management.
        Once revoked, an incoming tool call is rejected immediately with no fallback, and a re-grant card is fired (LVIS's no-fallback rule).
      </Callout>

      <PageNav />
    </article>
  );
}
