import { PageHero } from "@/components/docs/page-hero";
import { Callout } from "@/components/docs/callout";
import { PageNav } from "@/components/docs/page-nav";
import { ZoomableFrame } from "@/components/docs/zoomable-frame";
import {
  StackDiagram,
  DataFlowDiagram,
  PermissionTree,
  LifecycleDiagram,
  CapabilityPackDiagram,
  SubAgentSequence,
  FederationSequence,
} from "@/components/docs/diagrams";

export const metadata = { title: "아키텍처 다이어그램" };

export default function Page() {
  return (
    <article>
      <PageHero
        eyebrow="Architecture · Diagrams"
        title="아키텍처 시각 자료"
        description="시스템의 큰 그림을 그림으로 옮긴 페이지입니다. 각 다이어그램은 카드를 클릭하면 큰 창으로 확대되어 자세히 볼 수 있습니다."
        tags={["클릭하여 확대", "스택 · 흐름 · 권한 · 라이프사이클"]}
      />

      <Callout tone="tip" title="확대해서 보기">
        다이어그램 카드를 클릭하면 라이트박스로 화면 거의 전체에 확대됩니다. 텍스트도 함께 커집니다.
      </Callout>

      <ZoomableFrame
        eyebrow="Diagram 01"
        title="시스템 한 눈에 보기 — 네 개의 레이어"
        caption="앱 · 플러그인 · 로컬 저장소 · 서버. 위에서 아래로 호출/저장이 흐릅니다."
      >
        <StackDiagram />
      </ZoomableFrame>

      <ZoomableFrame
        eyebrow="Diagram 02"
        title="한 메시지의 흐름"
        caption="사용자 입력에서 시작해 결과가 채팅으로 돌아오는 과정. 위험한 도구는 도중에 사용자 확인을 거칩니다."
      >
        <DataFlowDiagram />
      </ZoomableFrame>

      <ZoomableFrame
        eyebrow="Diagram 03"
        title="권한 분기 — 위험도 × 도구 종류"
        caption="도구의 위험도(낮음/중간/높음)와 종류(읽기/쓰기/실행/네트워크)에 따라 자동 실행 · 확인 카드 · 다이얼로그 중 하나로 분기합니다."
      >
        <PermissionTree />
      </ZoomableFrame>

      <ZoomableFrame
        eyebrow="Diagram 04"
        title="플러그인 수명주기 — 지금과 다음"
        caption="윗줄은 현재 상태, 아랫줄은 앞으로 추가될 단계입니다. 점선이 어디에 끼어드는지 보여줍니다."
      >
        <LifecycleDiagram />
      </ZoomableFrame>

      <h2 id="future">미래 비전 다이어그램</h2>
      <p>
        아래 세 장은 <a href="/docs/roadmap">로드맵</a> 의 항목을 그림으로 옮긴 것입니다.
        현재 동작이 아닌 <strong>앞으로 추가될 설계</strong> 를 보여줍니다.
      </p>

      <ZoomableFrame
        eyebrow="Diagram 05 · vision"
        title="Capability Pack — 한 묶음 발행, 한 번 설치"
        caption="플러그인 · Agent · MCP · Skill 을 하나의 패키지로 묶어 발행, 사용자는 한 번에 설치."
      >
        <CapabilityPackDiagram />
      </ZoomableFrame>

      <ZoomableFrame
        eyebrow="Diagram 06 · vision"
        title="Sub-agent 위임 — 동의 후 자율 실행"
        caption="복합 요청에 대해 사용자가 위임을 허용하면 sub-agent 가 자율적으로 도구를 호출합니다. 모든 결과는 다시 채팅으로 회수됩니다."
      >
        <SubAgentSequence />
      </ZoomableFrame>

      <ZoomableFrame
        eyebrow="Diagram 07 · vision"
        title="Federation — 다른 사용자에게 일거리 위임"
        caption="다른 호스트의 사람에게 작업을 넘기고 응답을 받습니다. 신뢰는 키 교환으로 표현합니다."
      >
        <FederationSequence />
      </ZoomableFrame>

      <Callout tone="warn" title="현재 vs 미래 구분">
        Diagram 01–04 는 현재 모습, Diagram 05–07 은 앞으로 추가될 모습입니다.
        앞으로 추가될 부분은 아직 코드에 없는 이름이 포함될 수 있으니 사실 페이지에서 인용하지 말아주세요.
      </Callout>

      <PageNav />
    </article>
  );
}
