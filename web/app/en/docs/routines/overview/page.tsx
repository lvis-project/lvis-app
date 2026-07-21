import { PageHero } from "@/components/docs/page-hero";
import { StepList } from "@/components/docs/step-list";
import { FeatureGrid } from "@/components/docs/feature-grid";
import { Callout } from "@/components/docs/callout";
import { MockupFrame } from "@/components/docs/mockup-frame";
import { PageNav } from "@/components/docs/page-nav";
import { Clock, PowerOff } from "lucide-react";

export const metadata = { title: "Routine Registration and Trigger Flow" };

export default function Page() {
  return (
    <article>
      <PageHero
        eyebrow="Routines"
        title="RoutineEngineV2 — Two Triggers"
        description="LVIS's routine engine is a single implementation at src/routines/v2/routine-engine-v2.ts (v2-only). Only two triggers exist: 'shutdown' and 'schedule.' Each routine fire creates a brand-new dedicated ConversationLoop instance, isolated from the interactive main loop."
        tags={["src/routines/v2/routine-engine-v2.ts", "trigger: shutdown | schedule", "per-fire fresh loop"]}
      />

      <FeatureGrid
        columns={2}
        items={[
          { icon: <Clock className="h-5 w-5" />, title: "schedule", body: <>Uses a cron-like expression. Evaluator: <code>src/routines/cron-evaluator.ts</code>. Examples: every day at 09:00, every Friday at 17:00.</>, tone: "teal" },
          { icon: <PowerOff className="h-5 w-5" />, title: "shutdown", body: <>Fired by the host right before it exits. Used for daily cleanup, daily backups, or reporting.</>, tone: "citron" },
        ]}
      />

      <Callout tone="info" title="Event/combination triggers belong to the detector, not the routine">
        Event-based automation such as a mail arriving or a meeting ending is handled by the <a href="/en/docs/plugins/work-assistant">Work Assistant</a>'s detector, not a routine.
        A Routine is a simple engine with only two triggers: "time" or "shutdown."
      </Callout>

      <h2 id="register">Registering a Routine (mockup)</h2>
      <MockupFrame title="Routine — schedule type example" tone="white">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-md border border-border bg-secondary/40 p-3">
            <p className="text-[11px] font-bold uppercase tracking-wider text-teal">Trigger</p>
            <div className="mt-2 grid gap-1.5 text-[13px]">
              <div className="rounded border border-teal/30 bg-white px-2.5 py-1.5 font-mono">trigger: "schedule"</div>
              <div className="rounded border border-border bg-white px-2.5 py-1.5 font-mono">cron: "0 9 * * 1-5"</div>
            </div>
          </div>
          <div className="rounded-md border border-border bg-secondary/40 p-3">
            <p className="text-[11px] font-bold uppercase tracking-wider text-coral">Conversation seed</p>
            <ol className="mt-2 grid gap-1.5 text-[13px]">
              <li className="rounded border border-border bg-white px-2.5 py-1.5">user: "Put together the daily briefing"</li>
              <li className="rounded border border-border bg-white px-2.5 py-1.5 text-muted-foreground">→ work_assistant_generate_daily_briefing</li>
              <li className="rounded border border-border bg-white px-2.5 py-1.5 text-muted-foreground">→ Result shown as a card in the chat body</li>
            </ol>
          </div>
        </div>
      </MockupFrame>

      <h2 id="lifecycle">Firing stages</h2>
      <StepList
        steps={[
          { title: "Registration — UI or plugin manifest", body: <p>The user adds one from the RoutinePanel, or a plugin manifest provides the <code>routine-provider</code> capability together with a recommended routine.</p> },
          { title: "Scheduler registration", body: <p><code>src/main/routines-scheduler.ts</code> books the time trigger with an OS timer. The shutdown trigger is registered on the host's lifecycle hook.</p> },
          { title: "Per-fire fresh ConversationLoop", body: <p>A new ConversationLoop instance is created at fire time. It is isolated from the interactive main loop's memory / permissions / TODOs.</p>, badge: "isolation" },
          { title: "Session recording", body: <p>The message stream and tool calls for a single fire are appended as JSONL to <code>{"~/.lvis/routine/sessions/<routineId>/<firedAt>.jsonl"}</code>.</p> },
          { title: "Result surfaced", body: <p>On completion, a "routine run complete" card appears in the chat body. On failure, it goes to the audit log and the next fire proceeds normally.</p> },
        ]}
      />

      <Callout tone="warn" title="The 'Q9 isolation lock' name doesn't exist in code">
        The concept older docs / CLAUDE.md refer to as "Q9 isolation lock" is implemented in code as the "per-fire fresh ConversationLoop" pattern (comment at <code>routine-engine-v2.ts:5-7</code>).
        The literal identifier <code>Q9</code> does not appear anywhere in the source.
      </Callout>

      <PageNav />
    </article>
  );
}
