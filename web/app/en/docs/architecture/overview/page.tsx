import { PageHero } from "@/components/docs/page-hero";
import { Callout } from "@/components/docs/callout";
import { PageNav } from "@/components/docs/page-nav";
import { StepList } from "@/components/docs/step-list";
import { Reveal } from "@/components/motion/reveal";

export const metadata = { title: "Architecture — System at a Glance" };

// Same layer-stack visual language as the landing architecture section —
// tag column + hairline card + chip row (docs and landing must not diverge).
const layers = [
  {
    tag: "Desktop Host",
    band: "Electron host",
    boxes: [
      "App.tsx · MainToolbar · ChatView",
      "MessageQueuePanel · SessionTodoPanel",
      "Reviewer (risk-classifier)",
      "Tool Registry · ConversationLoop",
      "RoutineEngineV2 (shutdown · schedule)",
    ],
  },
  {
    tag: "Plugin Runtime",
    band: "boot/steps/plugin-runtime.ts",
    boxes: [
      "ms-graph (mail+calendar)",
      "local-indexer (kiwi · pymupdf4llm · LanceDB · FTS5)",
      "meeting (Whisper STT)",
      "work-assistant (proactive · detectors)",
      "agent-hub (sidebar · 43 tools)",
      "lge-api (EP · 24 tools)",
    ],
  },
  {
    tag: "Storage",
    band: "~/.lvis/ (0o700 / 0o600)",
    boxes: [
      "sessions/",
      "routine/",
      "audit/<YYYY-MM-DD>.jsonl",
      "plugins/<id>/",
      "secrets/",
      "permissions.json",
      "settings.json",
      "memories/MEMORY.md",
    ],
  },
  {
    tag: "Servers",
    band: "Marketplace · Agent Hub · external",
    boxes: [
      "Marketplace (FastAPI · plugin/agent/mcp/skill catalog)",
      "Agent Hub (FastAPI + asyncpg + alembic)",
      "MCP servers (external)",
      "ms-graph · LGE EP · LGenie (external APIs)",
    ],
  },
];

const flowSteps = [
  { title: "User input", body: <>User input → <code>ChatView</code>.</> },
  { title: "Scope selection", body: <>The Host selects enabled plugin scope from explicit activation and carried session state.</> },
  { title: "Tool call decision", body: <>The model uses eager Tool schemas or promotes deferred Tools through <code>tool_search</code>.</> },
  { title: "Reviewer evaluation", body: <>Decides auto / card / dialog from the grid of tool RiskLevel × Category × the user's grant.</> },
  { title: "Execution", body: <>On approval, the plugin handler runs (cross-plugin calls possible via <code>callTool</code>).</> },
  { title: "Response streaming", body: <>Tool results + thinking tokens → LLM context → streamed into the chat body.</> },
  { title: "Audit logging", body: <>Every step is appended to <code>{"~/.lvis/audit/<YYYY-MM-DD>.jsonl"}</code>.</> },
];

export default function Page() {
  return (
    <article>
      <PageHero
        eyebrow="Architecture"
        title="LVIS system at a glance"
        description="LVIS is structured around four layers — the Electron host, the plugin runtime, local storage (~/.lvis), and servers — all operating on the same user signals. Every domain feature is split out into plugins, and the host never imports domain-specific code (enforced at the CI stage)."
        tags={["6 active plugins", "static manifest", "no fallback"]}
      />

      <Reveal>
        <div className="my-7 grid gap-2.5" role="figure" aria-label="LVIS stack — 4 layers (source-verified)">
          {layers.map((l) => (
            <div
              key={l.tag}
              className="grid gap-3 rounded-2xl border border-border bg-white p-5 sm:grid-cols-[130px_1fr]"
            >
              <span className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
                {l.tag}
              </span>
              <div>
                <p className="font-mono text-[13px] font-semibold text-ink">{l.band}</p>
                <div className="mt-2.5 flex flex-wrap gap-1.5">
                  {l.boxes.map((b) => (
                    <span
                      key={b}
                      className="rounded-full border border-border bg-secondary/50 px-2.5 py-1 text-[12px] font-medium text-ink-soft"
                    >
                      {b}
                    </span>
                  ))}
                </div>
              </div>
            </div>
          ))}
          <p className="mt-1 text-[12.5px] text-muted-foreground">
            ↑ decision · approval flow &nbsp;·&nbsp; ↓ signal · data flow — every layer is separated by an explicit permission boundary.
          </p>
        </div>
      </Reveal>

      <h2 id="data-flow">Data flow — one user message turn</h2>
      <StepList steps={flowSteps} />

      <Callout tone="info" title="6 active plugins (2026-05-20)">
        ms-graph (v0.3.28) · local-indexer (v0.4.11) · meeting (v0.4.18) · work-assistant (v0.7.0) ·
        agent-hub (v0.8.1) · lge-api (v0.12.9). Archived: lvis-plugin-email (2026-04-28), lvis-plugin-calendar (2026-04-30) — both consolidated into ms-graph.
      </Callout>

      <Callout tone="security" title="Architecture doc consistency">
        Every implementation is rooted in <code>lvis-app/docs/architecture/architecture.md</code> (v4 Final), and
        no pattern, structure, or approach that contradicts the document is introduced — LVIS Project CLAUDE.md rule.
      </Callout>

      <PageNav />
    </article>
  );
}
