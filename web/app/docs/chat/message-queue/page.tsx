import { PageHero } from "@/components/docs/page-hero";
import { ScreenshotCard, ScreenshotGallery } from "@/components/docs/screenshot-card";
import { Callout } from "@/components/docs/callout";
import { PageNav } from "@/components/docs/page-nav";
import { shotUrl, shots } from "@/lib/screenshots";

export const metadata = { title: "메시지 큐 & TODO" };

export default function Page() {
  return (
    <article>
      <PageHero
        eyebrow="Host · Chat"
        title="메시지 큐 & TODO 패널"
        description="ChatView 본문 옆에 항상 표시되는 두 개의 패널 — MessageQueuePanel (대기 외부 신호) + SessionTodoPanel (세션 TODO). 둘 다 React 컴포넌트로 ChatView.tsx 에서 렌더되고, 데이터는 workflowApi 가 관리합니다."
        tags={[
          "ChatView.tsx:1417 MessageQueuePanel",
          "ChatView.tsx:1416 SessionTodoPanel",
        ]}
      />

      <ScreenshotGallery columns={1}>
        <ScreenshotCard src={shotUrl("chat-todo-queue")} caption={shots["chat-todo-queue"].caption} aspect="wide" />
      </ScreenshotGallery>

      <h2 id="queue">MessageQueuePanel</h2>
      <p>
        외부 신호 (Outlook 새 메일, meeting 종료, Agent Hub 메시지 등) 가 들어오면 ChatView 본문을 막지 않고 패널에 카드 형태로 쌓입니다.
        구현: <code>src/ui/renderer/components/MessageQueuePanel.tsx</code>. 사용자가 카드를 클릭하면 채팅 본문에 ask-user question card 또는 도구 호출로 전환.
      </p>

      <h2 id="todo">SessionTodoPanel</h2>
      <p>
        세션 단위 TODO. 사용자가 직접 추가한 항목과 에이전트가 컨텍스트에서 만든 항목이 같은 리스트.
        구현: <code>src/ui/renderer/components/SessionTodoPanel.tsx</code>. 각 항목은 출처 라벨이 함께 표시.
      </p>

      <h2 id="dispatch">신호가 패널에 닿기까지</h2>
      <ol>
        <li>플러그인 (예: ms-graph) 이 <code>hostApi.emitEvent('email.new', payload)</code> 호출.</li>
        <li>구독 중인 work-assistant 가 <code>onEvent('email.new', …)</code> 에서 detector 평가.</li>
        <li>detector 가 surface 결정 시 <code>hostApi.triggerConversation({"{ …spec }"})</code> 또는 <code>showOverlay({"{ …input }"})</code> 호출.</li>
        <li>host UI가 MessageQueuePanel 또는 카드로 노출.</li>
        <li>모든 흐름 → <code>{"~/.lvis/audit/<YYYY-MM-DD>.jsonl"}</code> 한 줄 JSONL append.</li>
      </ol>

      <Callout tone="info" title="enqueueMessage 같은 API는 없다">
        SDK 표면에 <code>hostApi.enqueueMessage</code> 가 존재하지 않습니다.
        패널에 항목을 넣는 표준 경로는 <strong>이벤트 emit → host UI 가 감지 → 렌더</strong> 또는
        <strong> triggerConversation / showOverlay</strong> 입니다.
      </Callout>

      <PageNav />
    </article>
  );
}
