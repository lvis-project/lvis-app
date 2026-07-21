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
        description="첫 실행 시 호스트가 짧은 투어를 띄워 LVIS의 가장 자주 쓰는 동작들을 한 번에 안내합니다. 투어는 한 번만 보이고, 진행 상태는 사용자 PC 에만 저장됩니다."
        tags={["1회성", "건너뛰기 가능", "언제든 다시 열기 가능"]}
      />

      <h2 id="what">투어에 나오는 것들</h2>
      <ul>
        <li>채팅 화면의 세 영역 (좌측 사이드 · 본문 · 우측 큐/TODO).</li>
        <li>‘오늘의 제안’ 카드가 어디에 어떻게 등장하는지.</li>
        <li>플러그인 패널과 명령 팔레트 위치.</li>
        <li>권한 카드와 다이얼로그가 떴을 때의 기본 응답 흐름.</li>
        <li>처음 한 번만 묻는 메모리 시드 (역할 / 팀 / 자주 쓰는 도구) 입력.</li>
      </ul>

      <h2 id="state">진행 상태와 컨텍스트</h2>
      <p>
        호스트는 투어 진행 정도를 사용자 PC 의 LVIS 영역 안에 작은 한 줄로 기억해 둡니다. 같은 사용자가 다시 LVIS를 켜도 투어가 반복되지 않습니다.
        외부 서버에는 전송되지 않습니다.
      </p>

      <StepList
        steps={[
          { title: "건너뛰기", body: <p>‘건너뛰기’ 를 눌러도 메모리 시드 입력 단계는 한 번 더 묻습니다. 처음에 거기까지는 채우는 게 도움이 됩니다.</p> },
          { title: "다시 보기", body: <p>설정 → 도움말 → ‘투어 다시 보기’ 에서 같은 흐름을 언제든 다시 띄울 수 있습니다.</p> },
          { title: "초기화", body: <p>설정 → 도움말 → ‘투어 초기화’ 를 누르면 다음 실행 시 처음 사용자처럼 투어가 다시 시작됩니다.</p> },
        ]}
      />

      <Callout tone="tip" title="투어 도중 사용자 메모리 시드">
        ‘역할 / 자주 쓰는 도구 / 선호하는 회의 시간’ 같은 짧은 정보 한 줄을 미리 입력해 두면, 이후 모든 대화 품질이 눈에 띄게 좋아집니다.
        자세한 내용은 <a href="/docs/host/memory">MEMORY</a> 페이지.
      </Callout>

      <PageNav />
    </article>
  );
}
