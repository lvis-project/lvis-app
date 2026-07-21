import { PageHero } from "@/components/docs/page-hero";
import { Callout } from "@/components/docs/callout";
import { PageNav } from "@/components/docs/page-nav";
import { RoadmapTimeline, AxisCards } from "@/components/docs/timeline";
import { versions, axes } from "@/lib/roadmap";

export const metadata = { title: "로드맵" };

export default function Page() {
  return (
    <article>
      <PageHero
        eyebrow="Roadmap"
        title="지금은 정적 통합, 다음은 자율 협업"
        description="LVIS의 다음 흐름은 플러그인을 단순 도구 호출 모듈에서 자체 워크스페이스 + 자율 행동 + 사람 간 위임까지 가능한 동반자로 키우는 일입니다. 일정 약속이 아닌 진화 방향 선언입니다."
        tags={["v1 → v4 진화", "선언 — 일정 약속 아님"]}
      />

      <h2 id="vision">비전</h2>
      <p>
        모든 변화는 다음 여섯 가지 방향 중 하나에 속합니다. 한 버전은 여러 방향을 동시에 진행하고,
        각 방향은 여러 버전에 걸쳐 점차 성숙합니다.
      </p>
      <AxisCards axes={axes} />

      <h2 id="timeline">버전별 흐름</h2>
      <p>
        v1 “Foundation” 으로 시작해 v4 “Frontier” 까지. 각 버전은 한 가지 톤을 갖습니다.
      </p>
      <RoadmapTimeline versions={versions} />

      <Callout tone="warn" title="이 페이지 읽는 법">
        본 페이지의 v1 ~ v4 는 <strong>약속이 아닌 진화 방향</strong> 입니다. 우선순위가 바뀌면
        항목의 상태 (탐색 / 예정 / 진행 중 / Shipping) 가 자유롭게 갱신됩니다. 외부 계약이나 SLA 의 근거로 인용하지 말아주세요.
      </Callout>

      <PageNav />
    </article>
  );
}
