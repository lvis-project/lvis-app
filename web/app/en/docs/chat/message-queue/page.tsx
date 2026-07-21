import { PageHero } from "@/components/docs/page-hero";
import { ScreenshotCard, ScreenshotGallery } from "@/components/docs/screenshot-card";
import { Callout } from "@/components/docs/callout";
import { PageNav } from "@/components/docs/page-nav";
import { shotUrl, shots } from "@/lib/screenshots";

export const metadata = { title: "Message Queue & TODO" };

export default function Page() {
  return (
    <article>
      <PageHero
        eyebrow="Host · Chat"
        title="Message Queue & TODO Panels"
        description="Two panels always shown beside the ChatView body — MessageQueuePanel (pending external signals) + SessionTodoPanel (session TODOs). Both are React components rendered from ChatView.tsx, with data managed by workflowApi."
        tags={[
          "ChatView.tsx:1417 MessageQueuePanel",
          "ChatView.tsx:1416 SessionTodoPanel",
        ]}
      />

      <ScreenshotGallery columns={1}>
        <ScreenshotCard src={shotUrl("chat-todo-queue")} caption={shots["chat-todo-queue"].captionEn} aspect="wide" />
      </ScreenshotGallery>

      <h2 id="queue">MessageQueuePanel</h2>
      <p>
        When an external signal arrives (a new Outlook email, a meeting ending, an Agent Hub message, etc.), it stacks up as a card in the panel without blocking the ChatView body.
        Implementation: <code>src/ui/renderer/components/MessageQueuePanel.tsx</code>. Clicking a card switches the chat body to an ask-user question card or a tool call.
      </p>

      <h2 id="todo">SessionTodoPanel</h2>
      <p>
        Session-scoped TODOs. Items added directly by the user and items created by the agent from context share the same list.
        Implementation: <code>src/ui/renderer/components/SessionTodoPanel.tsx</code>. Each item is shown with a source label.
      </p>

      <h2 id="dispatch">How a signal reaches the panel</h2>
      <ol>
        <li>A plugin (e.g. ms-graph) calls <code>hostApi.emitEvent('email.new', payload)</code>.</li>
        <li>The subscribed work-assistant evaluates it via a detector in <code>onEvent('email.new', …)</code>.</li>
        <li>When the detector decides on a surface, it calls <code>hostApi.triggerConversation({"{ …spec }"})</code> or <code>showOverlay({"{ …input }"})</code>.</li>
        <li>The host UI exposes it via the MessageQueuePanel or a card.</li>
        <li>Every flow appends one line to <code>{"~/.lvis/audit/<YYYY-MM-DD>.jsonl"}</code>.</li>
      </ol>

      <Callout tone="info" title="There's no API like enqueueMessage">
        There is no <code>hostApi.enqueueMessage</code> on the SDK surface.
        The standard path for putting an item on the panel is <strong>emit an event → host UI detects it → render</strong>, or
        <strong> triggerConversation / showOverlay</strong>.
      </Callout>

      <PageNav />
    </article>
  );
}
