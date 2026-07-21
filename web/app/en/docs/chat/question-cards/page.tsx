import { PageHero } from "@/components/docs/page-hero";
import { ScreenshotCard, ScreenshotGallery } from "@/components/docs/screenshot-card";
import { Callout } from "@/components/docs/callout";
import { PageNav } from "@/components/docs/page-nav";
import { shotUrl, shots } from "@/lib/screenshots";

export const metadata = { title: "Question Cards" };

export default function Page() {
  return (
    <article>
      <PageHero
        eyebrow="Host · Chat"
        title="Question Cards — Asking More or Offering Choices"
        description="The agent surfaces an inline card whenever it needs to ask the user for more information or have them choose among options. The recommended choice is highlighted, and comparably good alternatives are shown alongside it."
      />

      <ScreenshotGallery columns={1}>
        <ScreenshotCard src={shotUrl("chat-question-card")} caption={shots["chat-question-card"].captionEn} aspect="wide" />
      </ScreenshotGallery>

      <h2 id="when">When do question cards appear?</h2>
      <ul>
        <li>When user intent is ambiguous — "Which emails should I organize?"</li>
        <li>When choosing among several candidates — "Which of the three meeting rooms?"</li>
        <li>Right before a risky action — "Should I overwrite this file?"</li>
        <li>When a plugin suggests a follow-up action — "Add this action item to your TODOs?"</li>
      </ul>

      <h2 id="features">Small conveniences built into the card</h2>
      <ul>
        <li>The <strong>recommended choice</strong> is highlighted with color.</li>
        <li><strong>Comparably good alternatives</strong> are shown too, so you can compare quickly.</li>
        <li>When <strong>free-text input</strong> is allowed, an input box appears alongside the choices.</li>
        <li>When <strong>multi-select</strong> is allowed, the options render as checkboxes.</li>
        <li>Once a choice is made, the card is locked and preserved in the chat history, so you can trace which choice led to which result.</li>
      </ul>

      <Callout tone="info" title="The point">
        Question cards aren't a trick to make the agent look smarter — they're a mechanism that hands decision authority back to the user explicitly.
      </Callout>

      <PageNav />
    </article>
  );
}
