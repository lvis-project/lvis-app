import { PageHero } from "@/components/docs/page-hero";
import { ScreenshotCard, ScreenshotGallery } from "@/components/docs/screenshot-card";
import { FeatureGrid } from "@/components/docs/feature-grid";
import { Callout } from "@/components/docs/callout";
import { PageNav } from "@/components/docs/page-nav";
import { shotUrl, shots } from "@/lib/screenshots";

export const metadata = { title: "채팅 화면 구성" };

export default function Page() {
  return (
    <article>
      <PageHero
        eyebrow="Host · Chat"
        title="채팅 화면 구성"
        description="메인 화면은 App.tsx 가 CustomTitleBar + MainToolbar 를 두르고, 접이식 Sidebar 를 띄우고, 그 안의 메인 콘텐츠 영역이 ChatView 를 마운트하는 구조입니다. SessionTasksPanel · MessageQueuePanel 은 컴포저 바로 위에 쌓이고, ChatView 는 useChatContext() 로 세션/큐/TODO state 를 함께 읽습니다."
        tags={[
          "App + Sidebar + 메인 콘텐츠 영역",
          "ChatView",
          "MessageQueuePanel + SessionTasksPanel",
        ]}
      />

      <FeatureGrid
        columns={3}
        items={[
          { title: "① CustomTitleBar + MainToolbar", body: <>창 컨트롤 + 세션/플러그인/권한 toolbar. <code>src/ui/renderer/App.tsx</code> 가 마운트.</>, tone: "teal" },
          { title: "② ChatView 본문", body: <>대화 + 도구 카드 + thinking + 질문 카드. <code>src/ui/renderer/ChatView.tsx</code>.</> },
          { title: "③ Queue + Tasks 패널", body: <>외부 신호 큐 + 세션 Tasks. 컴포저 바로 위 (<code>src/ui/renderer/components/ChatComposerDock.tsx</code>) 에 놓이고, 항목이 없으면 그려지지 않습니다.</>, tone: "citron" },
        ]}
      />

      <h2 id="screen">실제 화면</h2>
      <ScreenshotGallery columns={2}>
        <ScreenshotCard src={shotUrl("chat-todo-queue")} caption={shots["chat-todo-queue"].caption} />
        <ScreenshotCard src={shotUrl("chat-tool-thinking")} caption={shots["chat-tool-thinking"].caption} />
      </ScreenshotGallery>

      <h2 id="panels">사이드 패널들</h2>
      <ul>
        <li><code>PluginGridButton.tsx</code> — 플러그인 진입 버튼 그리드 (host UI plugin manifest의 ui[] 슬롯이 여기에 결합).</li>
        <li><code>RoutinePanel.tsx</code> — RoutineEngine 의 등록 루틴 목록 + on/off.</li>
        <li><code>PermissionReviewStatusCard.tsx</code> — Reviewer 모드/상태 카드.</li>
      </ul>

      <Callout tone="info" title="사이드바는 두 개가 따로 있습니다">
        채팅 메인에는 <strong>접이식 플로팅 Sidebar</strong> 가 있습니다 — 세션 · 프로젝트 · 플러그인 뷰가 여기에 들어가고, 접기와 폭 조절이 가능합니다.
        <code>src/ui/renderer/App.tsx</code> 가 이것을 그립니다.
        설정 화면은 그것과 별개로 <strong>자체 nav 컬럼</strong> 을 가집니다 (<code>src/ui/renderer/SettingsContent.tsx</code>).
      </Callout>

      <PageNav />
    </article>
  );
}
