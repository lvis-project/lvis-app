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
        tags={["single channel", "static-manifest based"]}
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
          { title: "Show overlays and cards", body: <>Work progress can be shown as a card or small overlay over the chat, so it doesn't block the user from doing other things.</> },
          { title: "Look up secrets", body: <>Secrets such as API keys are retrieved securely from the OS's secure storage. They are never stored in plaintext on disk.</> },
        ]}
      />

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
