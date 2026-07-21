import { PageHero } from "@/components/docs/page-hero";
import { Callout } from "@/components/docs/callout";
import { PageNav } from "@/components/docs/page-nav";
import { RoadmapTimeline, AxisCards } from "@/components/docs/timeline";
import { versions, axes } from "@/lib/roadmap";

export const metadata = { title: "Roadmap" };

export default function Page() {
  return (
    <article>
      <PageHero
        eyebrow="Roadmap"
        title="Static Integration Today, Autonomous Collaboration Next"
        description="LVIS's next direction is growing plugins from simple tool-calling modules into companions capable of their own workspace, autonomous action, and delegation between people. This is a declaration of direction, not a schedule commitment."
        tags={["v1 → v4 evolution", "Declaration — not a schedule commitment"]}
      />

      <h2 id="vision">Vision</h2>
      <p>
        Every change falls under one of the six directions below. A single version can advance several directions at once,
        and each direction matures gradually across multiple versions.
      </p>
      <AxisCards axes={axes} locale="en" />

      <h2 id="timeline">Flow by version</h2>
      <p>
        Starting from v1 "Foundation" through to v4 "Frontier." Each version carries a single tone.
      </p>
      <RoadmapTimeline versions={versions} locale="en" />

      <Callout tone="warn" title="How to read this page">
        The v1–v4 entries on this page are a <strong>direction of evolution, not a promise</strong>. As priorities shift,
        an item's status (exploring / planned / in progress / shipping) is updated freely. Please don't cite this as the basis for an external contract or SLA.
      </Callout>

      <PageNav />
    </article>
  );
}
