import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { PageHero } from "@/components/docs/page-hero";
import { Callout } from "@/components/docs/callout";
import { PageNav } from "@/components/docs/page-nav";
import { Badge } from "@/components/ui/badge";

const plugins = [
  { slug: "local-indexer", title: "Local Indexer", id: "local-indexer", ver: "0.4.11", scope: "Local · RAG", desc: "kiwipiepy Korean morphological analysis + pymupdf4llm + FTS5 + LanceDB. Folder watching via chokidar.", color: "from-teal/10 to-transparent" },
  { slug: "ms-graph", title: "Microsoft 365 (Outlook)", id: "ms-graph", ver: "0.3.28", scope: "Mail · Calendar", desc: "MSAL OAuth + Electron safeStorage tokens. 31 mail + calendar tools.", color: "from-accent/60 to-transparent" },
  { slug: "meeting", title: "Meeting", id: "meeting", ver: "0.4.18", scope: "Audio · STT", desc: "OpenAI Whisper API (gpt-4o-transcribe) + PCM16LE 16kHz/3sec chunks.", color: "from-coral/10 to-transparent" },
  { slug: "work-assistant", title: "Work Assistant", id: "work-assistant", ver: "0.7.0", scope: "Proactive", desc: "10+ detectors → triggerConversation + showOverlay. Unifies mail/calendar/meeting signals.", color: "from-citron/30 to-transparent" },
  { slug: "agent-hub", title: "Agent Hub Sidebar", id: "agent-hub", ver: "0.8.1", scope: "Host UI Plugin", desc: "Work board sidebar + 43 tools + 5-minute polling. Talks to agent-hub.lvisai.xyz.", color: "from-ink/[0.06] to-transparent" },
  { slug: "lge-api", title: "LGE EP", id: "lge-api", ver: "0.12.9", scope: "Corporate portal", desc: "EP/Space/NHRS/LGenie/parking — 24 tools. openAuthWindow session + intranet DNS gate.", color: "from-coral/10 to-transparent" },
];

export const metadata = { title: "Plugins — Overview" };

export default function Page() {
  return (
    <article>
      <PageHero
        eyebrow="Plugins"
        title="Plugins — the unit for adding what the host doesn't know about"
        description="Every domain feature in LVIS (mail, calendar, meetings, documents, corporate APIs) is split out into plugins. The host core never imports plugin-specific code (SDK type-only + CI enforced)."
        tags={["6 active plugins", "static manifest", "lvis-plugin-sdk"]}
      />

      <Callout tone="info" title="Plugin registration model — static manifest">
        Tools, Skills, Hooks, MCP servers, events, and UI slots are all declared statically in the <code>plugin.json</code> manifest.
        There is no runtime API like <code>registerTool</code>/<code>registerSkill</code>/<code>registerCommand</code> in the SDK.
        Skills provide instructions; only pure manifest <code>Tool</code> objects are callable.
      </Callout>

      <div className="my-8 grid gap-3 sm:grid-cols-2">
        {plugins.map((p) => (
          <Link
            key={p.slug}
            href={`/en/docs/plugins/${p.slug}`}
            className="group relative overflow-hidden rounded-2xl border border-border bg-white p-5 transition hover:-translate-y-0.5 hover:border-ink/15 hover:shadow-md"
          >
            <div className={`pointer-events-none absolute inset-0 bg-gradient-to-br ${p.color}`} />
            <div className="relative">
              <div className="mb-1.5 flex items-center justify-between">
                <Badge variant="muted">{p.scope}</Badge>
                <ArrowRight className="h-4 w-4 text-muted-foreground group-hover:text-ink" />
              </div>
              <p className="text-[16px] font-semibold text-ink">{p.title}</p>
              <p className="mt-0.5 text-[11.5px] font-mono text-muted-foreground">id: {p.id} · v{p.ver}</p>
              <p className="mt-1.5 text-[13.5px] leading-relaxed text-muted-foreground">{p.desc}</p>
            </div>
          </Link>
        ))}
      </div>

      <h2 id="install">Install flow</h2>
      <ol>
        <li>Pick a plugin from the Marketplace catalog → "Install".</li>
        <li>The web page fires an <code>lvis://install/&lt;slug&gt;</code> deeplink.</li>
        <li>The host (<code>src/main/lvis-protocol.ts</code>) parses the URL, validates the manifest, and verifies the Ed25519 signature.</li>
        <li>A plugin permission dialog appears → user confirms → its own namespace <code>{"~/.lvis/plugins/<pluginId>/"}</code> is created.</li>
        <li>The validated declarative bundle is activated as one unit and the plugin's <code>start()</code> callback is called.</li>
      </ol>

      <Callout tone="info" title="Past → present consolidation history">
        <ul className="my-1 list-disc pl-5">
          <li><strong>lvis-plugin-email</strong> + <strong>lvis-plugin-calendar</strong> merged into <strong>ms-graph</strong> (archived 2026-04-28/04-30).</li>
          <li><strong>work-assistant</strong> now handles proactive work suggestions.</li>
        </ul>
      </Callout>

      <PageNav />
    </article>
  );
}
