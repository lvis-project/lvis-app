import { PageHero } from "@/components/docs/page-hero";
import { Callout } from "@/components/docs/callout";
import { FeatureGrid } from "@/components/docs/feature-grid";
import { StepList } from "@/components/docs/step-list";
import { PageNav } from "@/components/docs/page-nav";

export const metadata = { title: "Agents — 작은 작업을 알아서 처리하는 단위" };

export default function Page() {
  return (
    <article>
      <PageHero
        eyebrow="Host · Agents"
        title="Agents — 작은 작업 단위, 알아서 처리"
        description="플러그인이 ‘어떤 도메인 전체’ 라면, Agent 는 ‘하나의 작업’ 입니다. ‘주간 회고 만들기’, ‘오늘의 액션 아이템 정리’ 처럼 한 가지 일을 잘 해내도록 짜여진 작은 자율 단위. 호스트는 이 Agent 들을 단축키 / Hub 메시지 / 자동화 트리거로 부릅니다."
        tags={["하나의 작업 = 하나의 Agent", "호스트가 부른다", "에이전트가 에이전트를 부른다", "위임 범위는 사용자가 정함"]}
      />

      <h2 id="diff">플러그인과 무엇이 다른가요?</h2>
      <FeatureGrid
        columns={2}
        items={[
          { title: "플러그인", body: <>도메인 전체 (메일 / 캘린더 / 회의 / 사내 포털) 를 호스트에 연결하는 큰 단위. 자기 영역 · 자기 도구 · 자기 UI 패널을 가집니다.</>, tone: "teal" },
          { title: "Agent", body: <>한 가지 작업만 잘 해내는 작은 단위. 보통 플러그인의 도구를 빌려 쓰고, 자기 UI 는 가지지 않습니다. 결과만 카드 한 장으로 돌려줍니다.</>, tone: "coral" },
        ]}
      />

      <h2 id="trigger">Agent 는 어떻게 시작되나요?</h2>
      <StepList
        steps={[
          {
            title: "단축키 / 명령 팔레트",
            body: <p>호스트의 명령 팔레트에서 Agent 이름을 직접 검색해 부릅니다. 가장 흔한 사용 방식.</p>,
          },
          {
            title: "Agent Hub 메시지로 위임",
            body: <p>업무 보드에서 ‘이 작업 이 Agent 에게 맡기기’ → Agent 가 백그라운드에서 결과를 만들고 메시지로 돌려줍니다.</p>,
          },
          {
            title: "자동화 트리거",
            body: <p>‘회의가 끝나면 회의록 정리 Agent 자동 실행’ 같은 자동화 규칙으로도 시작됩니다.</p>,
          },
        ]}
      />

      <h2 id="subagents">에이전트가 에이전트를 부릅니다</h2>
      <p>
        위 세 가지 말고 한 가지가 더 있습니다 — <strong>실행 중인 에이전트가 자기 하위 에이전트를 띄우는 것</strong> 입니다.
        큰 일을 쪼개서 각 조각을 별도 문맥에서 처리하고 결과만 받아오는 방식입니다.
      </p>
      <ul>
        <li><strong>깨끗한 문맥에서 시작합니다.</strong> 하위 에이전트는 부모의 대화 기록을 물려받지 않습니다. 쓸 수 있는 도구 목록은 띄우는 시점에 확정되어 기록되고, 중간에 멈췄다가 이어받을 때도 <em>그때 기록된 그 목록</em> 으로 다시 맞춰집니다 — 이어받는다고 권한이 새로 부여되지 않습니다.</li>
        <li><strong>대개 기다리지 않습니다.</strong> <strong>결과를 부모에게 배달할 수 있는 화면</strong> 에서는 하위 에이전트가 백그라운드로 돕니다 — 부모는 즉시 실행 손잡이를 받고, 결과는 나중에 메시지로 도착합니다. 모델이 “전경으로 돌려라” 고 요청해도 이 판단은 화면 쪽이 하고, 모델의 요청은 무시됩니다. 배달할 통로가 없는 화면에서는 전경으로 돌아 부모가 끝날 때까지 기다립니다.</li>
        <li><strong>중간에 멈추면 이어서 할 수 있습니다.</strong> 예산을 다 쓰고 끝나지 못한 하위 에이전트는 <em>미완료</em> 로 표시되고 이어받을 표를 함께 돌려줍니다. 그 표로 <strong>같은 하위 에이전트를</strong> 멈춘 자리에서 다시 이어갑니다 — 새로 띄우는 것이 아닙니다.</li>
        <li><strong>돌고 있는 중에도 방향을 바꿀 수 있습니다.</strong> 부모는 실행 중인 하위 에이전트에게 지시를 하나 더 밀어 넣을 수 있습니다.</li>
        <li><strong>생각하는 과정이 보입니다.</strong> 하위 에이전트가 무엇을 하고 있는지는 진행 중에 패널로 흘러나옵니다. 결과만 툭 나타나지 않습니다.</li>
      </ul>

      <Callout tone="security" title="하위 에이전트의 권한 질문은 부모가 먼저 받습니다">
        하위 에이전트가 도구를 쓰겠다고 물으면 그 질문은 사용자에게 바로 오지 않고 부모 에이전트에게 먼저 갑니다.
        부모가 답할 수 있는 범위에는 상한이 있고, 그 상한이 받는 값은 ‘낮음’ 과 ‘중간’ 둘뿐이라 <strong>높은 위험도는 이 경로를 통과하지 못하고 사용자에게</strong> 옵니다 — <a href="/docs/architecture/permissions#subagent">권한 모델</a> 참고.
      </Callout>

      <h2 id="where">어디에 저장되나요?</h2>
      <p>
        설치된 Agent 한 장은 사용자 PC 의 LVIS 영역에 텍스트 파일 한 장으로 보관됩니다. 자기 동작 / 부르는 키워드 / 부르는 사용자 그룹이 같이 들어 있습니다.
        외부 서버로 전송되지 않습니다.
      </p>

      <Callout tone="security" title="자율 실행의 안전선">
        Agent 가 알아서 여러 도구를 호출할 때도, 그 범위는 사용자가 위임 시점에 정해 둔 한도를 넘지 못합니다.
        위임 범위 밖의 동작이 필요하면 Agent 는 멈추고 사용자에게 추가 동의를 요청합니다.
      </Callout>

      <Callout tone="info" title="Marketplace 의 ‘Agents’ 카탈로그와의 관계">
        Marketplace 의 Agents 카탈로그가 발행과 설치의 출처입니다. 설치 deeplink 가 호스트에 도착하면 위의 위치에 Agent 한 장이 보관됩니다.
      </Callout>

      <PageNav />
    </article>
  );
}
