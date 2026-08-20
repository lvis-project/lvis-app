import { PageHero } from "@/components/docs/page-hero";
import { FeatureGrid } from "@/components/docs/feature-grid";
import { Callout } from "@/components/docs/callout";
import { PageNav } from "@/components/docs/page-nav";

export const metadata = { title: "아키텍처 — 권한 모델" };

export default function Page() {
  return (
    <article>
      <PageHero
        eyebrow="Architecture"
        title="권한 모델 — 3단계 위험도 × 4가지 검토 모드"
        description="LVIS의 권한 판단은 두 개의 축으로 이뤄집니다. 도구의 위험도(낮음/중간/높음) 와 자동 검토 모드(끄기 / 규칙 / LLM 보조 / 엄격). 사용자가 자동화 강도를 직접 조절할 수 있습니다."
        tags={["3단계 위험도", "4가지 검토 모드", "5종 도구 카테고리", "하위 에이전트 대리 판단"]}
      />

      <h2 id="risk">위험도 — 낮음 · 중간 · 높음</h2>
      <p>
        모든 도구에는 ‘이 도구가 얼마나 위험한가’ 가 미리 정해져 있습니다. 이 위험도는 도구 제작자가 임의로 바꿀 수 없고, 호스트의 검토를 거친 값만 유효합니다.
      </p>

      <h2 id="modes">검토 모드 — 자동화 강도 조절</h2>
      <FeatureGrid
        columns={2}
        items={[
          { title: "끄기 (disabled)", body: <>자동 검토를 사용하지 않음. 모든 도구가 카테고리 기반으로만 분기.</> },
          { title: "규칙 (rule)", body: <>정적 규칙만으로 빠르게 판정. LLM 호출 없음.</>, tone: "teal" },
          { title: "LLM 보조 (llm)", body: <>중간 / 높은 위험도 호출에서 LLM 이 인자와 컨텍스트를 함께 살펴 권고를 추가.</>, tone: "citron" },
          { title: "엄격 (strict)", body: <>중간 / 높은 위험도 모두 다이얼로그를 띄움. 자동화 최소화.</>, tone: "coral" },
        ]}
      />

      <h2 id="categories">도구 카테고리</h2>
      <ul>
        <li><strong>읽기</strong> — 정보를 가져오기만. 가장 안전한 카테고리.</li>
        <li><strong>쓰기</strong> — 외부 시스템 / 파일에 변경을 가함.</li>
        <li><strong>실행</strong> — 외부 명령 / 외부 코드 실행. 가장 보수적으로 다뤄지는 카테고리.</li>
        <li><strong>네트워크</strong> — 외부와 통신.</li>
        <li><strong>내부</strong> — LVIS 자체의 메타 동작 (예: 설정 변경).</li>
      </ul>

      <h2 id="subagent">하위 에이전트가 물어볼 때 — 부모가 먼저 답합니다</h2>
      <p>
        에이전트는 자기 하위 에이전트를 띄울 수 있습니다. 이때 하위 에이전트가 도구 하나를 쓰겠다고 물어보면, 그 질문이 곧바로 사용자에게 오지 않고
        <strong> 그 하위 에이전트를 띄운 부모 에이전트가 먼저 답합니다</strong>. 부모가 답하지 못하는 질문만 사용자에게 올라옵니다. 이 기능은 기본으로 켜져 있습니다.
      </p>
      <ul>
        <li><strong>부모가 답할 수 있는 범위에 상한이 있습니다.</strong> 기본값은 ‘중간’ 까지이고, <strong>높은 위험도는 어떤 설정에서도 사용자에게 옵니다</strong>. 상한은 호스트가 부모에게 묻기 <em>전에</em> 적용합니다 — 부모의 답을 나중에 깎는 방식이 아닙니다.</li>
        <li><strong>부모는 하위 에이전트가 쓴 설명을 읽지 않습니다.</strong> 부모에게 보여주는 근거는 호스트가 만든 것뿐입니다. 하위 에이전트가 스스로를 변호하는 문장을 써넣어 자기 승인을 유도할 수 없습니다.</li>
        <li><strong>횟수와 시간에 한도가 있습니다.</strong> 한 번의 판단에 걸 수 있는 시간과 하위 에이전트 한 번의 실행이 소비할 수 있는 판단 횟수가 정해져 있고, 넘어가면 사용자에게 올라옵니다.</li>
        <li><strong>대화 내용은 기본적으로 나가지 않습니다.</strong> 부모 대화의 최근 내용을 판단 근거에 포함하는 설정이 있지만 <strong>기본값은 0개</strong> 입니다. 이 값을 올리면 사용자의 말이 검토 모델 쪽으로 함께 전송되므로, 명시적으로 켜야만 동작합니다.</li>
        <li>이 값들은 설정 → 권한에서 볼 수 있고, 좁히는 방향으로만 조절됩니다.</li>
      </ul>

      <Callout tone="security" title="이 경로가 검사를 건너뛰지는 않습니다">
        부모의 판단은 호스트의 모든 하드 검사를 통과한 뒤에 붙습니다. 부모가 답했다고 해서 이미 거절된 것이 다시 열리지 않고, 부모의 답은 그 호출 한 번에만 적용됩니다 —
        ‘앞으로 계속 허용’ 으로 기억되지 않습니다. 모든 판단은 누가 답했는지와 함께 감사 기록에 남습니다.
      </Callout>

      <h2 id="no-fallback">우회 없음</h2>
      <Callout tone="security" title="권한이 회수되면 즉시 멈춤">
        한 번 부여한 권한이 회수되면, 그 권한이 필요했던 도구는 다음 호출에서 fallback 없이 즉시 멈춥니다.
        ‘예전에 동의했던 줄 알았던 동작’ 이 몰래 다시 일어나지 않도록 우회 경로를 두지 않습니다.
      </Callout>

      <PageNav />
    </article>
  );
}
