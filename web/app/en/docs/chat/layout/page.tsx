import { PageHero } from "@/components/docs/page-hero";
import { ScreenshotCard, ScreenshotGallery } from "@/components/docs/screenshot-card";
import { FeatureGrid } from "@/components/docs/feature-grid";
import { Callout } from "@/components/docs/callout";
import { PageNav } from "@/components/docs/page-nav";
import { shotUrl, shots } from "@/lib/screenshots";

export const metadata = { title: "Chat Screen Layout" };

export default function Page() {
  return (
    <article>
      <PageHero
        eyebrow="Host · Chat"
        title="Chat Screen Layout"
        description="The main screen mounted by App.tsx is CustomTitleBar + MainToolbar + ChatView. MessageQueuePanel · SessionTodoPanel always float beside the ChatView body, and useChatContext() manages session/queue/TODO state together."
        tags={[
          "App.tsx:1249-1290",
          "ChatView.tsx:222",
          "MessageQueuePanel + SessionTodoPanel",
        ]}
      />

      <FeatureGrid
        columns={3}
        items={[
          { title: "① CustomTitleBar + MainToolbar", body: <>Window controls + session/plugin/permission toolbar. Imported in <code>App.tsx:33</code>.</>, tone: "teal" },
          { title: "② ChatView body", body: <>Conversation + tool cards + thinking + question cards. <code>ChatView.tsx:222</code>.</> },
          { title: "③ Queue + TODO panels", body: <>External signal queue + session TODOs. <code>ChatView.tsx:1416-1417</code>.</>, tone: "citron" },
        ]}
      />

      <h2 id="screen">The actual screen</h2>
      <ScreenshotGallery columns={2}>
        <ScreenshotCard src={shotUrl("chat-todo-queue")} caption={shots["chat-todo-queue"].captionEn} />
        <ScreenshotCard src={shotUrl("chat-tool-thinking")} caption={shots["chat-tool-thinking"].captionEn} />
      </ScreenshotGallery>

      <h2 id="panels">Side panels</h2>
      <ul>
        <li><code>PluginGridButton.tsx</code> — grid of plugin entry buttons (the host UI plugin manifest's ui[] slots attach here).</li>
        <li><code>RoutinePanel.tsx</code> — RoutineEngineV2's list of registered routines + on/off toggles.</li>
        <li><code>PermissionReviewStatusCard.tsx</code> — reviewer mode/status card.</li>
      </ul>

      <Callout tone="info" title="Settings screen — a separate sidebar">
        The SettingsContent screen has its own Sidebar column (<code>SettingsContent.tsx:214</code>).
        The main chat is a single-column + toolbar + panels layout, so there is no separate sidebar there.
      </Callout>

      <PageNav />
    </article>
  );
}
