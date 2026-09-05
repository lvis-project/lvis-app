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
        description="On first run the host shows a six-step guide. While it is up the screen dims, only the element being pointed at keeps its original brightness with a highlight ring drawn around it, and the explanation card opens attached to that element. The ring and the card follow their target even when the card grows or a notice band opens and moves the layout."
        tags={["Six steps", "One-time", "Skippable"]}
      />

      <h2 id="what">The six places the guide points at</h2>
      <ol>
        <li><strong>Step 1 · Start a conversation</strong> — the composer, along with ⌘+Enter to stop an answer in progress.</li>
        <li><strong>Step 2 · Tools always require your approval</strong> — where the approval card appears. Once you allow or deny an action, that decision is remembered for the session.</li>
        <li><strong>Step 3 · ⌘+K command palette</strong> — the shared entry point for switching sessions, settings, and running plugins.</li>
        <li><strong>Step 4 · Recent chats and pinned items</strong> — the panel the search icon (⌘+F) opens.</li>
        <li><strong>Step 5 · Settings · Routines · Memory</strong> — the hamburger menu.</li>
        <li><strong>Step 6 · The model in use</strong> — the model name in the status row under the composer. A model you switch to applies from your next message.</li>
      </ol>

      <h2 id="state">Progress and context</h2>
      <p>
        The host remembers tour progress as a small single line inside the LVIS area on the user's PC. If the same user opens LVIS again,
        the tour doesn't repeat. It is never sent to an external server.
      </p>

      <StepList
        steps={[
          { title: "Steps that advance on their own", body: <p>Step 1 advances once you type a line in the composer, and step 3 once you press ⌘+K. You move through the rest yourself.</p> },
          { title: "The lit spot is safe to click", body: <p>Clicking the highlighted composer moves focus into it without closing the guide, so you can follow the "try typing here" step without losing your place. The button the guide is describing is not pressed on your behalf.</p> },
          { title: "Skipping", body: <p>Clicking outside the highlighted area closes the guide.</p> },
        ]}
      />

      <Callout tone="tip" title="Plugins carry their own guides">
        Meeting, document search, and Work Assistant each have a separate guide that points at their own screen elements, shown when that plugin's screen is up.
        The user information worth filling in ahead of time is covered on the <a href="/en/docs/host/memory">MEMORY</a> page.
      </Callout>

      <PageNav />
    </article>
  );
}
