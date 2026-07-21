import { PageHero } from "@/components/docs/page-hero";
import { Callout } from "@/components/docs/callout";
import { FeatureGrid } from "@/components/docs/feature-grid";
import { StepList } from "@/components/docs/step-list";
import { PageNav } from "@/components/docs/page-nav";

export const metadata = { title: "Agents — Units That Handle Small Tasks on Their Own" };

export default function Page() {
  return (
    <article>
      <PageHero
        eyebrow="Host · Agents"
        title="Agents — Small Task Units, Handled Autonomously"
        description="If a plugin is an entire domain, an Agent is a single task. It's a small autonomous unit built to do one thing well — like 'create a weekly retro' or 'summarize today's action items.' The host calls these Agents through shortcuts, Hub messages, or automation triggers."
        tags={["One task = one Agent", "The host calls it", "Delegation scope is set by the user"]}
      />

      <h2 id="diff">How is this different from a plugin?</h2>
      <FeatureGrid
        columns={2}
        items={[
          { title: "Plugin", body: <>A large unit that connects an entire domain (mail / calendar / meetings / internal portal) to the host. Has its own area, its own tools, and its own UI panel.</>, tone: "teal" },
          { title: "Agent", body: <>A small unit that does just one task well. Usually borrows a plugin's tools and has no UI of its own. Returns only a single result card.</>, tone: "coral" },
        ]}
      />

      <h2 id="trigger">How does an Agent get started?</h2>
      <StepList
        steps={[
          {
            title: "Shortcut / command palette",
            body: <p>Search directly for the Agent's name in the host's command palette. The most common way to call one.</p>,
          },
          {
            title: "Delegate via an Agent Hub message",
            body: <p>From the work board, choose "hand this task to this Agent" → the Agent produces the result in the background and returns it as a message.</p>,
          },
          {
            title: "Automation trigger",
            body: <p>Also started by automation rules such as "automatically run the meeting-notes Agent when a meeting ends."</p>,
          },
        ]}
      />

      <h2 id="where">Where is it stored?</h2>
      <p>
        An installed Agent is kept as a single text file in the LVIS area on the user's PC. It contains its own behavior, its calling keywords,
        and the user group that can call it. It is never sent to an external server.
      </p>

      <Callout tone="security" title="Safety limits on autonomous execution">
        Even when an Agent calls multiple tools on its own, that scope can never exceed the limit the user set at the time of delegation.
        If an action outside the delegated scope is needed, the Agent stops and asks the user for additional consent.
      </Callout>

      <Callout tone="info" title="Relationship to the Marketplace's 'Agents' catalog">
        The Agents catalog in the Marketplace is the source for publishing and installing. Once an install deeplink reaches the host, a single Agent is stored at the location described above.
      </Callout>

      <PageNav />
    </article>
  );
}
