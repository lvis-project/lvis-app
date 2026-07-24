import { PageHero } from "@/components/docs/page-hero";
import { Callout } from "@/components/docs/callout";
import { StepList } from "@/components/docs/step-list";
import { FeatureGrid } from "@/components/docs/feature-grid";
import { PageNav } from "@/components/docs/page-nav";

export const metadata = { title: "Skills — Reusable Bundles of Ability" };

export default function Page() {
  return (
    <article>
      <PageHero
        eyebrow="Host · Skills"
        title="Skills — Call Frequent Tasks with One Line"
        description="A Skill is an instruction bundle shipped by a plugin. The host reads it through an explicit lifecycle to give the model task context, but a Skill never activates a plugin or selects or invokes a Tool."
        tags={["Instruction bundle", "Host-selected Tool scope", "Runs only after user approval"]}
      />

      <h2 id="what">What's inside a single Skill?</h2>
      <FeatureGrid
        columns={2}
        items={[
          { title: "Instructions", body: <>A set of sentences that describes the context, order, and format the LLM should use for a task.</>, tone: "teal" },
          { title: "Bundled declaration", body: <>A plugin declares its artifact-local Skill path with <code>manifest.skills</code>.</> },
          { title: "Tool discovery", body: <>Host-selected scope and <code>tool_search</code> make callable Tools visible to the model.</>, tone: "citron" },
          { title: "Permission boundary", body: <>Tool-level host policy, not the Skill, decides risk and execution permission.</> },
        ]}
      />

      <h2 id="where">Where is it stored?</h2>
      <p>
        A plugin's Skill is stored below <code>skills/</code> in its signed plugin artifact. On install, the host verifies the declared path and
        <code>SKILL.md</code> presence, then reads the metadata and body into the lifecycle. A Skill has no independent execution permission or auto-run state.
      </p>

      <h2 id="get-skill">How do you get a Skill?</h2>
      <StepList
        steps={[
          {
            title: "Bundled with a plugin install",
            body: <p>A plugin can bundle the Skill instructions it needs. For example, the Meeting plugin can supply the context for meeting work.</p>,
          },
          {
            title: "Updated with the plugin",
            body: <p>A verified plugin update can update its bundled Skill instructions. The host validates the changed artifact again.</p>,
          },
          {
            title: "Declared by the plugin author",
            body: <p>A plugin author writes a Skill in the artifact and declares its path in the manifest. The host validates declared contribution paths and callable Tools as separate contracts.</p>,
          },
        ]}
      />

      <Callout tone="security" title="Execution always follows user consent">
        Reading a Skill never selects or invokes a Tool automatically. Callable Tools are discovered through Host-selected scope and
        <code>tool_search</code>; actions such as sending mail or deleting files still go through the Tool's host permission flow.
      </Callout>

      <PageNav />
    </article>
  );
}
