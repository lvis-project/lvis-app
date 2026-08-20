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

      <h2 id="auto">Letting the host extract memories itself — off by default</h2>
      <p>
        The host can read the conversation and pick out facts worth remembering. There are three settings.
      </p>
      <FeatureGrid
        columns={3}
        items={[
          { title: "Off", body: <><strong>This is the default.</strong> The host does not extract memories from the conversation.</>, tone: "teal" },
          { title: "Review", body: <>Candidates are extracted but not saved — they are shown as a card first, and only stay if the user confirms.</>, tone: "citron" },
          { title: "Auto", body: <>Saved straight away with no confirmation card. Read the rest of this page before turning it on.</>, tone: "coral" },
        ]}
      />
      <p>
        This <em>automatic</em> extraction, in any of the three modes above, considers <strong>only turns the user typed at the keyboard</strong>. Attachment bodies, messages from other agents,
        and turns that arrived through an external surface are filtered out at the candidate stage — otherwise a sentence someone else wrote could harden into a permanent fact about the user.
        (A user explicitly saying "remember this" is a separate path from this automatic extraction.)
      </p>

      <h2 id="project">It also reads instructions the project carries</h2>
      <p>
        If the project folder you are working in has a team-shared <code>AGENTS.md</code>, the host reads that too and takes it into account.
        It is treated as a <strong>separate layer</strong> from the user's personal instructions, and it sits <em>below</em> the personal one.
        There is no path that rewrites that project file — the one place the host writes an <code>AGENTS.md</code> is in the user's own area (<code>~/.lvis</code>).
      </p>

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
