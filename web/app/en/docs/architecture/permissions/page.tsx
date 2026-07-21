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
        tags={["3 risk levels", "4 review modes", "5 tool categories"]}
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

      <h2 id="no-fallback">No bypass</h2>
      <Callout tone="security" title="Revoking a permission stops it immediately">
        Once a granted permission is revoked, the tool that needed it stops immediately on its next call, with no fallback.
        No bypass path is left open that could let an action the user thought they'd already approved happen again quietly.
      </Callout>

      <PageNav />
    </article>
  );
}
