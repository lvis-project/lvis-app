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
        description="App.tsx 가 마운트하는 메인 화면은 CustomTitleBar + MainToolbar + ChatView. ChatView 본문 옆에 MessageQueuePanel · SessionTodoPanel 이 항상 떠 있고, useChatContext() 가 세션/큐/TODO state를 함께 관리합니다."
        tags={[
          "App.tsx:1249-1290",
          "ChatView.tsx:222",
          "MessageQueuePanel + SessionTodoPanel",
        ]}
      />

      <FeatureGrid
        columns={3}
        items={[
          { title: "① CustomTitleBar + MainToolbar", body: <>창 컨트롤 + 세션/플러그인/권한 toolbar. <code>App.tsx:33</code>에서 import.</>, tone: "teal" },
          { title: "② ChatView 본문", body: <>대화 + 도구 카드 + thinking + 질문 카드. <code>ChatView.tsx:222</code>.</> },
          { title: "③ Queue + TODO 패널", body: <>외부 신호 큐 + 세션 TODO. <code>ChatView.tsx:1416-1417</code>.</>, tone: "citron" },
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
        <li><code>RoutinePanel.tsx</code> — RoutineEngineV2 의 등록 루틴 목록 + on/off.</li>
        <li><code>PermissionReviewStatusCard.tsx</code> — Reviewer 모드/상태 카드.</li>
      </ul>

      <Callout tone="info" title="설정 화면 — 별도 sidebar">
        SettingsContent 화면은 자체 Sidebar 컬럼이 있습니다 (<code>SettingsContent.tsx:214</code>).
        채팅 메인은 single-column + toolbar + panels 구성이라 사이드바가 별도 존재하지 않습니다.
      </Callout>

      <PageNav />
    </article>
  );
}
