import { PageHero } from "@/components/docs/page-hero";
import { Callout } from "@/components/docs/callout";
import { FeatureGrid } from "@/components/docs/feature-grid";
import { StepList } from "@/components/docs/step-list";
import { PageNav } from "@/components/docs/page-nav";

export const metadata = { title: "Trust & Security — 무엇이 사용자를 지키나" };

export default function Page() {
  return (
    <article>
      <PageHero
        eyebrow="Host · Trust & Security"
        title="무엇이 사용자를 지키나"
        description="LVIS가 자동화를 많이 해주는 만큼, 사용자 입장에서는 ‘이게 안전한가?’ 가 더 중요해집니다. 본 페이지는 LVIS가 사용자를 지키기 위해 가지고 있는 안전선들을 한 곳에 모아 설명합니다."
        tags={["출처 검증", "비밀값 보호", "동의 후 실행", "내 PC 안에만"]}
      />

      <FeatureGrid
        columns={2}
        items={[
          {
            title: "출처 검증된 패키지만 설치",
            body: <>Marketplace 에서 받는 모든 플러그인 · Agent · MCP · Skill 묶음은 발행자 서명이 붙어 있고, 호스트가 설치 직전에 서명을 다시 확인합니다. 서명이 맞지 않으면 자동으로 거절됩니다.</>,
            tone: "teal",
          },
          {
            title: "비밀값은 OS 보안 저장소에",
            body: <>API 키 · 토큰 · 사내 세션 쿠키 같은 비밀값은 운영체제의 보안 저장소에 암호화되어 보관됩니다. LVIS 디스크에 평문으로 저장되지 않습니다.</>,
            tone: "ink",
          },
          {
            title: "위험한 일은 매번 사용자 확인",
            body: <>메일 발송 · 외부 호출 · 파일 삭제 · 결재 제출 같은 동작은 위험도에 따라 인라인 확인 카드 또는 전면 다이얼로그를 띄워 사용자 동의를 받습니다.</>,
            tone: "coral",
          },
          {
            title: "데이터는 내 PC 안에만",
            body: <>대화 · 회의록 · 인덱싱한 자료 · 메모리 · 자동화 기록은 모두 사용자 PC 안의 LVIS 영역에 보관됩니다. 외부 서버 동기화는 사용자가 명시적으로 켠 기능에 한합니다.</>,
            tone: "citron",
          },
          {
            title: "위임 동의는 사슬로 보존",
            body: <>Agent 에게 자율 실행을 위임할 때 받은 동의는 변경 불가능한 기록 사슬로 보존됩니다. 누가 / 언제 / 어떤 범위로 동의했는지 나중에 그대로 다시 볼 수 있습니다.</>,
          },
          {
            title: "사내 전용 플러그인은 사내망에서만",
            body: <>사내 포털 같은 사내 전용 플러그인은 외부 네트워크에서는 로그인 자체가 자동 차단됩니다. 잘못된 망에서 사내 자격이 흘러나가지 않게 막는 장치입니다.</>,
          },
        ]}
      />

      <h2 id="audit">감사 기록 — 모든 동작을 한 줄씩</h2>
      <p>
        LVIS가 자동으로 한 모든 동작 (도구 호출 · 권한 부여 · 메일 발송 · 자동화 발사) 은 한 줄짜리 기록으로 안전한 저장소에 남습니다.
        사용자는 언제든 이 기록을 직접 열어 ‘오늘 LVIS 가 내 메일을 몇 번 만졌지?’, ‘이 자동화는 누가 켰지?’ 를 확인할 수 있습니다.
      </p>
      <ul>
        <li>날짜별로 분리되어 한 파일 한 날짜 — 검색이 쉽습니다.</li>
        <li>호스트의 자동 정리는 없습니다. 사용자가 직접 삭제하지 않는 한 그대로 보존됩니다.</li>
        <li>샌드박스 동작 (외부 코드 실행) 은 별도 기록으로 분리되어 더 보수적으로 보관됩니다.</li>
      </ul>

      <h2 id="no-fallback">우회하지 않습니다</h2>
      <StepList
        steps={[
          {
            title: "권한이 회수되면 즉시 멈춤",
            body: <p>한번 부여한 권한을 사용자가 회수하면, 그 권한이 필요했던 도구는 다음 호출에서 fallback 없이 즉시 멈추고 사용자에게 재허용을 요청합니다.</p>,
          },
          {
            title: "안 되는 경로는 안 됩니다",
            body: <p>‘plan B’ 라는 이름으로 위험한 동작을 우회로 처리하지 않습니다. 안 되는 동작은 안 됩니다 — 이를 통해 사용자가 ‘작년에 동의한 줄 알았던 동작’ 이 몰래 다시 일어나는 일을 막습니다.</p>,
          },
          {
            title: "허용된 출처만 신뢰",
            body: <p>외부 도메인 / 외부 도구 / 외부 서버는 사용자가 명시적으로 등록한 것만 신뢰합니다. 코드에 박혀 있는 허용 도메인 같은 건 없습니다.</p>,
          },
        ]}
      />

      <Callout tone="security" title="요약 — 사용자가 확인할 수 있는 것">
        <ul className="my-1 list-disc pl-5">
          <li>오늘 LVIS 가 한 모든 동작 — 감사 기록.</li>
          <li>지금 활성화된 권한 / 위임 / 자동화 — 설정 화면.</li>
          <li>각 플러그인이 가진 비밀값의 종류 — 설정 → 플러그인 → 권한 관리.</li>
          <li>마지막 자동 업데이트 시점과 그 직전 버전 — 설정 → 앱 → 업데이트 상태.</li>
        </ul>
      </Callout>

      <PageNav />
    </article>
  );
}
