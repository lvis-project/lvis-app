import { PageHero } from "@/components/docs/page-hero";
import { Callout } from "@/components/docs/callout";
import { FeatureGrid } from "@/components/docs/feature-grid";
import { PageNav } from "@/components/docs/page-nav";

export const metadata = { title: "MEMORY — What You've Told LVIS" };

export default function Page() {
  return (
    <article>
      <PageHero
        eyebrow="Host · Memory"
        title="MEMORY — What LVIS Remembers About You"
        description="A single place where LVIS keeps information like 'my job title / my typical scheduling patterns / my preferred meeting times / colleagues I meet often.' Once you tell LVIS something, it naturally refers back to that fact in every conversation after."
        tags={["Managed directly by the user", "Stored only on your PC", "Viewable / editable anytime"]}
      />

      <h2 id="what">What kinds of things get stored?</h2>
      <FeatureGrid
        columns={2}
        items={[
          { title: "Role / responsibilities", body: <>Simple facts like "I'm a backend developer and I lead the OOO team."</>, tone: "teal" },
          { title: "Preferences and habits", body: <>Habits such as preferring meetings after 3pm, or one-page summaries for reports.</> },
          { title: "Frequently handled people", body: <>Teammates you exchange mail with at least weekly, direct reports, and so on.</>, tone: "citron" },
          { title: "Things you'd rather it not do", body: <>Restrictions like "never send an automatic mail reply."</>, tone: "coral" },
        ]}
      />

      <h2 id="how">How do you add to it?</h2>
      <ul>
        <li>Say "remember this" mid-conversation and the host surfaces a memory candidate as a card. Press confirm to save it.</li>
        <li>Add or edit entries one line at a time directly from the settings screen.</li>
        <li>Even when a plugin discovers a new fact, it is never saved automatically — it always goes through a user confirmation card.</li>
      </ul>

      <h2 id="where">Where is it stored?</h2>
      <p>
        All memory is kept only inside the LVIS area on the user's PC. It is never sent to an external server, the Marketplace, or the Agent Hub.
        Because it's a plain single-line text file, users can also open and edit the file directly.
      </p>

      <Callout tone="security" title="Forgetting is explicit too">
        Say "forget this" and the host shows the matching memory candidate, removing it only after user confirmation. No memory disappears automatically.
      </Callout>

      <Callout tone="info" title="Memory seeding on first use">
        On LVIS's first run, the host shows a memory-seed input screen so you can enter the most basic facts (role / team / frequently used tools) all at once.
      </Callout>

      <PageNav />
    </article>
  );
}
