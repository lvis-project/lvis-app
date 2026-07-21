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
        tags={["3단계 위험도", "4가지 검토 모드", "5종 도구 카테고리"]}
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

      <h2 id="no-fallback">우회 없음</h2>
      <Callout tone="security" title="권한이 회수되면 즉시 멈춤">
        한 번 부여한 권한이 회수되면, 그 권한이 필요했던 도구는 다음 호출에서 fallback 없이 즉시 멈춥니다.
        ‘예전에 동의했던 줄 알았던 동작’ 이 몰래 다시 일어나지 않도록 우회 경로를 두지 않습니다.
      </Callout>

      <PageNav />
    </article>
  );
}
