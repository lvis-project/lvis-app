import { PageHero } from "@/components/docs/page-hero";
import { Callout } from "@/components/docs/callout";
import { FeatureGrid } from "@/components/docs/feature-grid";
import { StepList } from "@/components/docs/step-list";
import { PageNav } from "@/components/docs/page-nav";

export const metadata = { title: "Trust & Security — What Protects the User" };

export default function Page() {
  return (
    <article>
      <PageHero
        eyebrow="Host · Trust & Security"
        title="What Protects the User"
        description="The more automation LVIS does, the more the question 'is this safe?' matters to the user. This page gathers, in one place, the safety limits LVIS has in place to protect the user."
        tags={["Source verification", "Secret protection", "Runs after consent", "Only on your PC"]}
      />

      <FeatureGrid
        columns={2}
        items={[
          {
            title: "Only source-verified packages are installed",
            body: <>Every plugin, Agent, MCP, and Skill bundle from the Marketplace carries a publisher signature, and the host re-verifies that signature right before install. A mismatched signature is rejected automatically.</>,
            tone: "teal",
          },
          {
            title: "A withdrawn version does not come back",
            body: <>When the distributor marks a specific version "do not use," that version will not install, and will not load on the next launch even if it is already on disk. That withdrawal list is signed, and the host refuses <strong>an older list replayed to undo a withdrawal</strong> — a list issued earlier than the newest one already accepted is discarded. Conversely, while <em>no</em> signed list has ever been received, this path blocks nothing.</>,
            tone: "ink",
          },
          {
            title: "Secrets live in the OS secure store",
            body: <>Secrets like API keys, tokens, and internal session cookies are encrypted and kept in the operating system's secure storage. They are never stored in plaintext on the LVIS disk.</>,
            tone: "ink",
          },
          {
            title: "Risky actions always ask for user confirmation",
            body: <>Actions such as sending mail, calling external services, deleting files, or submitting approvals trigger an inline confirmation card or a full dialog, depending on risk level, to get user consent.</>,
            tone: "coral",
          },
          {
            title: "Data stays only on your PC",
            body: <>Conversations, meeting notes, indexed material, memory, and automation records are all kept in the LVIS area on the user's PC. External server sync is limited to features the user has explicitly turned on.</>,
            tone: "citron",
          },
          {
            title: "Delegation consent is preserved as a chain",
            body: <>Consent given when delegating autonomous execution to an Agent is preserved as an immutable record chain. Who consented, when, and within what scope can always be reviewed later exactly as it happened.</>,
          },
          {
            title: "Internal-only plugins work only on the internal network",
            body: <>Internal-only plugins, such as an internal portal, automatically block login itself when accessed from outside the corporate network. This is a safeguard against internal credentials leaking out over the wrong network.</>,
          },
        ]}
      />

      <h2 id="plugin-boundary">When a plugin fails</h2>
      <ul>
        <li><strong>It leaves a reason instead of disappearing.</strong> An installed plugin that fails to load does not silently vanish — it stays in the sidebar's plugin list as <strong>an entry naming why it failed</strong>. A manifest that does not match the schema, an app version that is too old, a version the distributor withdrew, and installed files that no longer match their install record each show as a distinct reason, and the ones a reinstall can repair are distinguished from the ones it cannot.</li>
        <li><strong>Some of them run in a separate process.</strong> There is a path that confines a plugin to a child process separate from the host, and plugins are being moved onto it one at a time. The details — and <strong>how many take that path today</strong> — are in the <a href="/en/docs/architecture/host-api#boundary">HostApi document</a>.</li>
      </ul>

      <h2 id="audit">Audit log — every action, one line at a time</h2>
      <p>
        Every action LVIS performs automatically (tool calls, permission grants, mail sent, automation fired) is recorded as a single line in
        secure storage. Users can open this log anytime to check things like "how many times did LVIS touch my mail today?" or "who turned on this automation?"
      </p>
      <ul>
        <li>Split by date, one file per day — easy to search.</li>
        <li>No automatic cleanup by the host. Records are preserved as-is unless the user deletes them directly.</li>
        <li>Sandbox actions (running external code) are kept in a separate log and stored even more conservatively.</li>
      </ul>

      <h2 id="no-fallback">No workarounds</h2>
      <StepList
        steps={[
          {
            title: "Revoked permission stops execution immediately",
            body: <p>Once a granted permission is revoked by the user, any tool that needed it stops immediately on the next call, with no fallback, and asks the user to grant it again.</p>,
          },
          {
            title: "What's disallowed stays disallowed",
            body: <p>Risky actions are never routed around under the name of a "plan B." A disallowed action stays disallowed — this prevents an action the user thought they'd consented to "a while back" from quietly happening again.</p>,
          },
          {
            title: "Only allowed sources are trusted",
            body: <p>External domains, external tools, and external servers are trusted only when the user has explicitly registered them. There's no such thing as an allow-listed domain hardcoded into the code.</p>,
          },
        ]}
      />

      <Callout tone="security" title="Summary — what the user can check">
        <ul className="my-1 list-disc pl-5">
          <li>Every action LVIS took today — the audit log.</li>
          <li>Currently active permissions / delegations / automations — the settings screen.</li>
          <li>The types of secrets each plugin holds — Settings → Plugins → Permission management.</li>
          <li>The time of the last automatic update and the version before it — Settings → App → Update status.</li>
        </ul>
      </Callout>

      <PageNav />
    </article>
  );
}
