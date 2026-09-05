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
        description="App.tsx wraps the main screen in CustomTitleBar + MainToolbar, floats a collapsible Sidebar, and the main content region inside it mounts PaneFrame. PaneFrame splits the conversation area into as many as four tiles, and each tile is a ChatGroupSession that provides its own ChatContext and draws ChatView. SessionTasksPanel · MessageQueuePanel stack directly above that tile's composer."
        tags={[
          "App + Sidebar + PaneFrame",
          "ChatGroupSession → ChatView",
          "MessageQueuePanel + SessionTasksPanel",
        ]}
      />

      <FeatureGrid
        columns={3}
        items={[
          { title: "① CustomTitleBar + MainToolbar", body: <>Window controls + session/plugin/permission toolbar. Mounted by <code>src/ui/renderer/App.tsx</code>.</>, tone: "teal" },
          { title: "② PaneFrame tiles", body: <>Splits the conversation area into as many as four tiles (<code>src/ui/renderer/components/PaneFrame.tsx</code>). Each tile is a <code>ChatGroupSession.tsx</code> that provides its own ChatContext and draws <code>ChatView.tsx</code>.</> },
          { title: "③ Queue + Tasks panels", body: <>External signal queue + session tasks. They sit directly above the composer (<code>src/ui/renderer/components/ChatComposerDock.tsx</code>) and draw nothing when they have no items.</>, tone: "citron" },
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
        <li><code>RoutinePanel.tsx</code> — RoutineEngine's list of registered routines + on/off toggles.</li>
        <li><code>PermissionReviewStatusCard.tsx</code> — reviewer mode/status card.</li>
        <li><code>ApprovalDock.tsx</code> · <code>QuestionOverlay.tsx</code> — tool approvals and question cards. They are answered inside the tile that holds their conversation, and while one waits <code>PendingAnswerDot.tsx</code> puts a yellow dot on that conversation&apos;s row in the sidebar.</li>
      </ul>

      <Callout tone="info" title="There are two separate sidebars">
        The main chat screen has a <strong>collapsible floating Sidebar</strong> — session, project, and plugin views live in it, and it can be collapsed and resized.
        <code>src/ui/renderer/App.tsx</code> renders it.
        The settings screen has its own <strong>nav column</strong>, separate from that one (<code>src/ui/renderer/SettingsContent.tsx</code>).
      </Callout>

      <PageNav />
    </article>
  );
}
