import { PageHero } from "@/components/docs/page-hero";
import { Callout } from "@/components/docs/callout";
import { FeatureGrid } from "@/components/docs/feature-grid";
import { PageNav } from "@/components/docs/page-nav";

export const metadata = { title: "Architecture — the HostApi Contract" };

export default function Page() {
  return (
    <article>
      <PageHero
        eyebrow="Architecture"
        title="HostApi — the single channel plugins use to talk to the host"
        description="Every LVIS plugin operates only through a one-line channel the host provides (HostApi), never touching the host's internals directly. This channel is what keeps the host and plugins cleanly isolated, so plugins can be swapped, stopped, or verified at any time."
        tags={["single channel", "static-manifest based", "process boundary rolling out"]}
      />

      <Callout tone="info" title="The tone of this page">
        This document is a general user guide. It introduces callable capabilities only at a broad category level, and does not cover actual signatures, parameters, or code locations.
      </Callout>

      <h2 id="surface">Capabilities the host provides to plugins</h2>
      <FeatureGrid
        columns={2}
        items={[
          { title: "Secure storage", body: <>A plugin can only read and write files within its own area. It cannot access another plugin's area.</>, tone: "teal" },
          { title: "Read / write user settings", body: <>Each plugin can have its own settings keys, and the user can change those values directly from the host settings screen.</> },
          { title: "Register Skill keywords", body: <>Registering natural-language phrases like "sort out meeting minutes" or "request parking" as keywords means the matching plugin is automatically suggested when the user says something similar.</>, tone: "citron" },
          { title: "Send and receive events", body: <>Plugins can send and receive signals like "meeting ended" or "new mail arrived" to and from each other, relayed by the host.</> },
          { title: "Call another plugin's tools", body: <>One plugin can borrow another plugin's capability — for example, Work Assistant calling a tool on the calendar plugin.</> },
          { title: "Call the host LLM", body: <>A plugin can use the host's LLM without holding its own LLM key. Cost and model selection are managed centrally by the host.</>, tone: "coral" },
          { title: "Open an external auth window", body: <>A plugin that needs login/OAuth opens the host's separate auth window to receive a token securely.</> },
          { title: "User confirmation dialogs", body: <>Before performing a risky action, the host shows a standard-format confirmation dialog to get user consent.</>, tone: "coral" },
          { title: "Raise a conversation", body: <>Work progress can be shown as a card in the chat body, so it doesn't block the user from doing other things. There is no overlay window a plugin paints itself — the host's chat body is the only surface.</> },
          { title: "Look up secrets", body: <>Secrets such as API keys are retrieved securely from the OS's secure storage. They are never stored in plaintext on disk. The lookup is asynchronous because it has to be able to cross a process boundary — a plugin does not hold a bundle of secrets up front, it asks the host for one at a time, when it needs it.</> },
        ]}
      />

      <h2 id="boundary">Where a plugin actually runs</h2>
      <p>
        Plugins used to run inside the host process. There is now a path that <strong>confines a plugin to its own child process</strong>, and plugins are being moved onto it one at a time.
        As of today exactly one takes that path: <code>work-assistant</code> (<code>src/plugins/isolation/out-of-process-plugins.ts</code>).
      </p>
      <ul>
        <li><strong>A plugin does not get to choose whether it is isolated.</strong> No setting, environment variable, or manifest field reads that list. It is fixed in source, and changing it means a code change that passes review.</li>
        <li><strong>If the child fails, the call fails.</strong> There is no path that retries the same call back inside the host process.</li>
        <li><strong>The shape of the channel is unchanged.</strong> Storage, settings, event subscriptions, LLM calls, auth windows and secret lookups all carry across the boundary. What changes for a plugin author is that some calls — like the secret lookup above — must be awaited.</li>
      </ul>

      <Callout tone="info" title="Not all of them yet">
        The remaining plugins still run in the host process. This page does not claim that every plugin is isolated — it says the boundary exists and plugins are being moved onto it one at a time.
      </Callout>

      <h2 id="rules">Effects of a single channel</h2>
      <ul>
        <li>Plugins have no knowledge of the host's internal implementation. Plugins are unaffected even if the host changes its internals.</li>
        <li>Risky actions (sending mail, external calls, deleting files) all go through the same permission flow, giving users a consistent experience.</li>
        <li>Adding a new plugin never requires touching host code. The plugin just needs to declare its own capabilities.</li>
        <li>Every action a plugin produces is recorded in the host's audit log.</li>
      </ul>

      <Callout tone="security" title="Direct access to host internals is forbidden">
        Plugin code directly importing the host's internal modules is blocked at LVIS's build stage.
        All integration is possible only through the single channel (HostApi) calls plus the plugin manifest declaration.
      </Callout>

      <PageNav />
    </article>
  );
}
