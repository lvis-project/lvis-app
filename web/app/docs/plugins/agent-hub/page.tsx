import { PageHero } from "@/components/docs/page-hero";
import { ScreenshotCard, ScreenshotGallery } from "@/components/docs/screenshot-card";
import { Callout } from "@/components/docs/callout";
import { StepList } from "@/components/docs/step-list";
import { PageNav } from "@/components/docs/page-nav";
import { shotUrl, shots } from "@/lib/screenshots";

export const metadata = { title: "Agent Hub 사이드바 플러그인" };

export default function Page() {
  return (
    <article>
      <PageHero
        eyebrow="Plugin · Agent Hub"
        title="Agent Hub — 업무 보드와 인박스를 한 화면에"
        description="호스트 안에서 ‘업무 보드’ 패널을 열어 개인 작업 · 팀 작업 · 받은 메시지 · 승인 대기를 한 곳에 모아 보여줍니다. 보드의 데이터는 별도의 Agent Hub 서버와 동기화됩니다."
        tags={["My Work · Team Board", "인박스 · 승인 · 리포트"]}
      />

      <ScreenshotGallery columns={2}>
        <ScreenshotCard src={shotUrl("agent-hub-my-work")} caption={shots["agent-hub-my-work"].caption} />
        <ScreenshotCard src={shotUrl("agent-hub-team-board")} caption={shots["agent-hub-team-board"].caption} />
      </ScreenshotGallery>

      <h2 id="boards">두 가지 보드</h2>
      <ul>
        <li><strong>My Work</strong> — 내가 맡았거나 내가 만든 항목. 호스트의 TODO 패널과 양방향으로 이어집니다.</li>
        <li><strong>Team Board</strong> — 팀 단위 카드. 권한이 있는 카드만 보이고, 다른 사람의 카드를 ‘집어오기’ 할 수 있습니다.</li>
        <li>두 보드는 상단의 토글로 빠르게 전환합니다. 분리 창으로 띄워 두 화면에서 동시에 볼 수도 있습니다.</li>
      </ul>

      <h2 id="sync">서버와의 동기화</h2>
      <p>
        호스트는 일정 주기로 Agent Hub 서버에서 인박스 / 보드 / 알림을 가져옵니다. 사용자가 활발히 작업 중일 때는 부드럽게,
        잠시 쉬어가는 동안에는 더 적극적으로 가져옵니다. 모든 비즈니스 데이터는 서버에 있고, 로컬에는 인증 토큰만 안전하게 보관됩니다.
      </p>

      <h2 id="scenario">실전 시나리오 — 회의 끝나면 자동으로 팀에 분배</h2>
      <p>
        Agent Hub 의 진짜 가치는 회의가 끝난 직후 액션 아이템이 <strong>자동으로 팀에게 흘러가는</strong> 것입니다.
      </p>
      <StepList
        steps={[
          { title: "회의 종료 → 액션 아이템 추출", body: <p>Meeting 플러그인이 회의 끝을 감지하고, 회의록에서 ‘누가 / 무엇을 / 언제까지’ 후보를 뽑아냅니다.</p>, badge: "회의" },
          { title: "보드에 작업 자동 등록", body: <p>업무도우미가 추출된 아이템을 사용자 확인 카드로 띄우고, 사용자가 승인하면 Agent Hub 보드에 새 카드로 등록합니다. 마감일도 함께 자동 채워집니다.</p>, badge: "보드 추가" },
          { title: "팀원에게 알림", body: <p>다음 동기화 시점에 다른 팀원의 Team Board 에 새 카드가 등장합니다. 마감 24시간 전이면 ‘기한 임박’ 알림도 함께 발사됩니다.</p>, badge: "알림" },
          { title: "‘집어오기’ → 처리 기록", body: <p>다른 사람이 ‘집어오기’ 를 누르면 작업의 담당이 옮겨지고, 처리 이력이 변경 불가능한 형태로 보드에 남습니다.</p>, badge: "이력" },
        ]}
      />

      <Callout tone="info" title="서버는 별도 컴포넌트">
        이 플러그인은 ‘보드의 진입점’ 역할만 합니다. 데이터의 본거지는 Agent Hub 서버입니다 — 자세한 내용은
        <a href="/docs/servers/agent-hub"> Agent Hub 서버 개요</a>.
      </Callout>

      <PageNav />
    </article>
  );
}
