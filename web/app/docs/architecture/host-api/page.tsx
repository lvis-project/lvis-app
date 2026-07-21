import { PageHero } from "@/components/docs/page-hero";
import { Callout } from "@/components/docs/callout";
import { FeatureGrid } from "@/components/docs/feature-grid";
import { PageNav } from "@/components/docs/page-nav";

export const metadata = { title: "아키텍처 — HostApi 컨트랙트" };

export default function Page() {
  return (
    <article>
      <PageHero
        eyebrow="Architecture"
        title="HostApi — 플러그인이 호스트와 대화하는 단일 통로"
        description="LVIS의 모든 플러그인은 호스트의 내부 코드를 직접 만지지 않고, 호스트가 제공하는 한 줄짜리 통로 (HostApi) 만 통해 동작합니다. 이 통로가 있어서 호스트와 플러그인이 깔끔하게 격리되고, 플러그인은 언제든 교체 / 정지 / 검증할 수 있습니다."
        tags={["단일 통로", "정적 manifest 기반"]}
      />

      <Callout tone="info" title="이 페이지의 톤">
        이 문서는 일반 사용자 가이드입니다. 호출 가능한 기능을 큰 분류로만 소개하고, 실제 시그니처 / 파라미터 / 코드 위치는 따로 다루지 않습니다.
      </Callout>

      <h2 id="surface">호스트가 플러그인에 제공하는 능력</h2>
      <FeatureGrid
        columns={2}
        items={[
          { title: "안전한 저장소", body: <>플러그인은 자기 영역 안에서만 파일을 읽고 쓸 수 있습니다. 다른 플러그인의 영역에는 접근할 수 없습니다.</>, tone: "teal" },
          { title: "사용자 설정 읽기 / 쓰기", body: <>각 플러그인은 자신만의 설정 키를 가질 수 있고, 사용자가 호스트 설정 화면에서 그 값을 직접 바꿀 수 있습니다.</> },
          { title: "Skill 키워드 등록", body: <>“회의록 정리”, “주차 신청” 같은 자연어 표현을 키워드로 등록해 두면, 사용자가 이런 말을 하면 자동으로 해당 플러그인이 추천됩니다.</>, tone: "citron" },
          { title: "이벤트 주고받기", body: <>플러그인끼리 “회의 끝났음”, “새 메일 도착” 같은 신호를 보내고 받을 수 있습니다. 호스트가 중간에서 전달합니다.</> },
          { title: "다른 플러그인 도구 호출", body: <>업무도우미가 캘린더 플러그인의 도구를 호출하는 등, 한 플러그인이 다른 플러그인의 능력을 빌릴 수 있습니다.</> },
          { title: "호스트 LLM 호출", body: <>플러그인이 자체 LLM 키를 가지지 않고도 호스트의 LLM 을 사용할 수 있습니다. 비용과 모델 선택은 호스트가 일괄 관리합니다.</>, tone: "coral" },
          { title: "외부 인증 창 열기", body: <>로그인 / OAuth 가 필요한 플러그인은 호스트의 별도 인증 창을 띄워 안전하게 토큰을 수령합니다.</> },
          { title: "사용자 확인 다이얼로그", body: <>위험한 작업을 수행하기 전, 호스트가 표준 형식의 확인 다이얼로그를 띄워 사용자 동의를 받습니다.</>, tone: "coral" },
          { title: "오버레이 · 카드 띄우기", body: <>업무 진행 상황을 채팅 위에 카드 또는 작은 오버레이로 표시해 사용자가 다른 일을 막지 않게 합니다.</> },
          { title: "비밀값 조회", body: <>API 키 같은 비밀값은 OS 보안 저장소에서 안전하게 가져옵니다. 디스크에 평문으로 저장되지 않습니다.</> },
        ]}
      />

      <h2 id="rules">단일 통로의 효과</h2>
      <ul>
        <li>플러그인은 호스트의 내부 구현을 알지 못합니다. 호스트가 내부를 바꿔도 플러그인은 영향을 받지 않습니다.</li>
        <li>위험한 동작 (메일 발송, 외부 호출, 파일 삭제) 은 모두 같은 권한 흐름을 거치므로 사용자 입장에서 일관된 경험을 받습니다.</li>
        <li>새 플러그인이 들어와도 호스트 코드를 고치지 않습니다. 플러그인 자체에 자기 능력을 선언해 두면 됩니다.</li>
        <li>플러그인이 만들어내는 모든 작업은 호스트의 감사 기록에 남습니다.</li>
      </ul>

      <Callout tone="security" title="호스트 내부에 직접 접근 금지">
        플러그인 코드가 호스트의 내부 모듈을 직접 가져다 쓰는 것은 LVIS 의 빌드 단계에서 차단됩니다.
        모든 통합은 단일 통로 (HostApi) 호출 + 플러그인 매니페스트 선언으로만 가능합니다.
      </Callout>

      <PageNav />
    </article>
  );
}
