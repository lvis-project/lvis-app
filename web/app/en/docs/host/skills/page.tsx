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
        description="A Skill is a saved bundle for a frequent task — things like 'clean up meeting notes,' 'request parking,' or 'show today's schedule.' When a registered keyword shows up in chat, the host automatically recommends the best-matching Skill."
        tags={["Keyword-based auto recommendation", "Stored on your PC", "Runs only after user approval"]}
      />

      <h2 id="what">What's inside a single Skill?</h2>
      <FeatureGrid
        columns={2}
        items={[
          { title: "Trigger keywords", body: <>Phrases users say often, like "clean up meeting notes" or "request parking."</>, tone: "teal" },
          { title: "Prompt", body: <>The set of sentences defining the tone and format the LLM should use for this task.</> },
          { title: "Tool mapping", body: <>Which plugin's which tool to call when this Skill runs.</>, tone: "citron" },
          { title: "Risk level", body: <>The default setting for whether user confirmation is required, or the task can finish automatically.</> },
        ]}
      />

      <h2 id="where">Where is it stored?</h2>
      <p>
        Registered Skills are stored as single-line text files inside the secure LVIS area on the user's PC. They are never sent to an
        external server, and can be freely deleted or backed up per domain. A Skill's approval state (auto-run allowed / confirm every time / blocked)
        is also managed in the same area.
      </p>

      <h2 id="get-skill">How do you get a Skill?</h2>
      <StepList
        steps={[
          {
            title: "Bundled with a plugin install",
            body: <p>Most plugins come with a default set of Skills. Example: installing the Meeting plugin automatically registers a "Start meeting recording" Skill.</p>,
          },
          {
            title: "Add from the Marketplace",
            body: <p>You can install a Skill bundle separately from any plugin. Grab a bundle another user made, like "Weekly retro summary," as-is.</p>,
          },
          {
            title: "Write your own",
            body: <p>Advanced users can write and save their own Skills. The host validates the format and checks that the risk level is appropriate.</p>,
          },
        ]}
      />

      <Callout tone="security" title="Execution always follows user consent">
        Being registered as a Skill doesn't mean risky actions run automatically. Actions like sending mail or deleting files
        still go through the host's permission flow for user confirmation, regardless of the Skill's risk setting.
      </Callout>

      <PageNav />
    </article>
  );
}
