import { PageHero } from "@/components/docs/page-hero";
import { Callout } from "@/components/docs/callout";
import { StepList } from "@/components/docs/step-list";
import { PageNav } from "@/components/docs/page-nav";

export const metadata = { title: "Onboarding — Getting Started for the First Time" };

export default function Page() {
  return (
    <article>
      <PageHero
        eyebrow="Host · Onboarding"
        title="The First Time You Open LVIS — A Short Tour"
        description="On first run, the host shows a short tour that walks through LVIS's most common actions all at once. The tour appears only once, and its progress is stored only on the user's PC."
        tags={["One-time", "Skippable", "Reopenable anytime"]}
      />

      <h2 id="what">What the tour covers</h2>
      <ul>
        <li>The chat screen's three areas (left sidebar, main body, right queue/TODO).</li>
        <li>Where and how "today's suggestion" cards appear.</li>
        <li>The location of the plugin panel and command palette.</li>
        <li>The default response flow when a permission card or dialog appears.</li>
        <li>The one-time memory-seed input (role / team / frequently used tools).</li>
      </ul>

      <h2 id="state">Progress and context</h2>
      <p>
        The host remembers tour progress as a small single line inside the LVIS area on the user's PC. If the same user opens LVIS again,
        the tour doesn't repeat. It is never sent to an external server.
      </p>

      <StepList
        steps={[
          { title: "Skip", body: <p>Even if you press "Skip," the memory-seed input step is still asked once more. It helps to fill that part in the first time.</p> },
          { title: "Replay", body: <p>Go to Settings → Help → "Replay tour" to bring up the same flow again anytime.</p> },
          { title: "Reset", body: <p>Pressing Settings → Help → "Reset tour" starts the tour again on the next launch, as if you were a first-time user.</p> },
        ]}
      />

      <Callout tone="tip" title="The user memory seed during the tour">
        Entering a short line of information up front — role / frequently used tools / preferred meeting time — noticeably improves the quality of every conversation afterward.
        See the <a href="/en/docs/host/memory">MEMORY</a> page for details.
      </Callout>

      <PageNav />
    </article>
  );
}
