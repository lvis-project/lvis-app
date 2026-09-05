import { PageHero } from "@/components/docs/page-hero";
import { Callout } from "@/components/docs/callout";
import { StepList } from "@/components/docs/step-list";
import { PageNav } from "@/components/docs/page-nav";

export const metadata = { title: "온보딩 — 처음 시작할 때의 안내" };

export default function Page() {
  return (
    <article>
      <PageHero
        eyebrow="Host · Onboarding"
        title="처음 LVIS를 켜면 — 작은 투어"
        description="첫 실행 때 호스트가 여섯 단계짜리 짧은 안내를 띄웁니다. 안내가 켜지면 화면이 어두워지고 지금 가리키는 요소만 원래 밝기로 남아 둘레에 강조 테두리가 그려지며, 설명 카드가 그 요소에 붙어 열립니다. 카드가 커지거나 상단 알림 띠가 열려 화면이 움직여도 강조와 카드가 대상을 따라갑니다."
        tags={["6단계", "1회성", "건너뛰기 가능"]}
      />

      <h2 id="what">안내가 짚는 여섯 곳</h2>
      <ol>
        <li><strong>1단계 · 대화 시작</strong> — 입력창. 진행 중인 답을 멈추는 ⌘+Enter 도 함께 알려 줍니다.</li>
        <li><strong>2단계 · 도구는 항상 사용자 승인</strong> — 승인 카드가 나타나는 자리. 한 번 허용/거부한 결정은 그 세션 동안 기억됩니다.</li>
        <li><strong>3단계 · ⌘+K 명령 팔레트</strong> — 세션 전환 · 설정 · 플러그인 실행의 공통 진입점.</li>
        <li><strong>4단계 · 최근 대화와 핀</strong> — 검색 아이콘(⌘+F)이 여는 패널.</li>
        <li><strong>5단계 · 설정 · 루틴 · 메모리</strong> — 햄버거 메뉴.</li>
        <li><strong>6단계 · 지금 쓰는 모델</strong> — 입력창 아래 상태 줄의 모델 이름. 눌러서 바꾼 모델은 다음 메시지부터 적용됩니다.</li>
      </ol>

      <h2 id="state">진행 상태와 컨텍스트</h2>
      <p>
        호스트는 투어 진행 정도를 사용자 PC 의 LVIS 영역 안에 작은 한 줄로 기억해 둡니다. 같은 사용자가 다시 LVIS를 켜도 투어가 반복되지 않습니다.
        외부 서버에는 전송되지 않습니다.
      </p>

      <StepList
        steps={[
          { title: "저절로 넘어가는 단계", body: <p>1단계는 입력창에 한 줄 적으면, 3단계는 ⌘+K 를 누르면 다음으로 자동 이동합니다. 나머지 단계는 직접 넘깁니다.</p> },
          { title: "밝게 남은 자리는 눌러도 됩니다", body: <p>강조된 입력창을 누르면 안내가 닫히지 않고 포커스만 그 입력창으로 옮겨가므로, ‘여기에 입력해 보세요’ 단계를 안내를 잃지 않고 따라갈 수 있습니다. 안내가 설명 중인 버튼이 대신 눌리지는 않습니다.</p> },
          { title: "건너뛰기", body: <p>강조된 자리 바깥을 누르면 안내가 닫힙니다.</p> },
        ]}
      />

      <Callout tone="tip" title="플러그인별 안내는 따로 있습니다">
        회의 · 문서 검색 · 업무도우미에는 각자의 화면 요소를 짚는 별도 안내가 준비돼 있고, 해당 플러그인 화면이 올라와 있을 때 그 요소를 가리킵니다.
        미리 채워 두면 좋은 사용자 정보는 <a href="/docs/host/memory">MEMORY</a> 페이지에서 다룹니다.
      </Callout>

      <PageNav />
    </article>
  );
}
