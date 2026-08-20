import { PageHero } from "@/components/docs/page-hero";
import { FeatureGrid } from "@/components/docs/feature-grid";
import { Callout } from "@/components/docs/callout";
import { PageNav } from "@/components/docs/page-nav";

export const metadata = { title: "Architecture — Permission Model" };

export default function Page() {
  return (
    <article>
      <PageHero
        eyebrow="Architecture"
        title="Permission model — 3 risk levels × 4 review modes"
        description="LVIS's permission decisions run along two axes: a tool's risk level (low/medium/high) and the automatic review mode (disabled / rule / LLM-assisted / strict). Users can directly control how much automation they want."
        tags={["3 risk levels", "4 review modes", "5 tool categories", "parent-decided sub-agent asks"]}
      />

      <h2 id="risk">Risk level — low, medium, high</h2>
      <p>
        Every tool has a predetermined "how risky is this tool" rating. This risk level cannot be changed arbitrarily by the tool's author — only a value that has passed the host's review is valid.
      </p>

      <h2 id="modes">Review modes — controlling automation intensity</h2>
      <FeatureGrid
        columns={2}
        items={[
          { title: "Disabled", body: <>Automatic review is not used. Every tool branches purely by category.</> },
          { title: "Rule", body: <>Judged quickly using only static rules. No LLM call.</>, tone: "teal" },
          { title: "LLM-assisted", body: <>For medium/high-risk calls, an LLM also reviews the arguments and context to add a recommendation.</>, tone: "citron" },
          { title: "Strict", body: <>Shows a dialog for both medium and high risk. Minimizes automation.</>, tone: "coral" },
        ]}
      />

      <h2 id="categories">Tool categories</h2>
      <ul>
        <li><strong>Read</strong> — only fetches information. The safest category.</li>
        <li><strong>Write</strong> — makes changes to an external system or file.</li>
        <li><strong>Execute</strong> — runs external commands or external code. The most conservatively handled category.</li>
        <li><strong>Network</strong> — communicates externally.</li>
        <li><strong>Internal</strong> — LVIS's own meta operations (e.g. changing settings).</li>
      </ul>

      <h2 id="subagent">When a sub-agent asks — the parent answers first</h2>
      <p>
        An agent can spawn sub-agents. When a sub-agent asks to use a tool, the question does not go straight to the user:
        <strong> the parent agent that spawned it answers first</strong>. Only what the parent cannot answer is escalated to the user. This ships on by default.
      </p>
      <ul>
        <li><strong>There is a ceiling on what a parent may decide.</strong> The default is up to medium, and <strong>high risk goes to the user under every setting</strong>. The ceiling is applied <em>before</em> the parent is asked, not by trimming its answer afterwards.</li>
        <li><strong>The parent never reads prose the sub-agent wrote.</strong> The evidence shown to the parent is host-composed. A sub-agent cannot argue for its own approval.</li>
        <li><strong>There are limits on time and count.</strong> One adjudication has a time bound, and one sub-agent run has a budget of adjudications. Past either, the ask escalates to the user.</li>
        <li><strong>Conversation content does not leave by default.</strong> There is a setting that quotes the parent conversation's recent turns into the evidence, but <strong>its default is zero turns</strong>. Raising it sends the user's own words to the reviewing model, so it only works if it is deliberately turned on.</li>
        <li>These values are visible under Settings → Permissions, and each one only narrows the lane.</li>
      </ul>

      <Callout tone="security" title="This lane does not skip any check">
        A parent's decision sits below every hard check the host runs. A parent answer cannot re-open something already refused, and it applies to that one call only —
        it is never remembered as "allow from now on". Every decision is recorded in the audit log along with who answered it.
      </Callout>

      <h2 id="no-fallback">No bypass</h2>
      <Callout tone="security" title="Revoking a permission stops it immediately">
        Once a granted permission is revoked, the tool that needed it stops immediately on its next call, with no fallback.
        No bypass path is left open that could let an action the user thought they'd already approved happen again quietly.
      </Callout>

      <PageNav />
    </article>
  );
}
