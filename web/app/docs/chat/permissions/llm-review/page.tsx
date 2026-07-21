import { PageHero } from "@/components/docs/page-hero";
import { ScreenshotCard, ScreenshotGallery } from "@/components/docs/screenshot-card";
import { FeatureGrid } from "@/components/docs/feature-grid";
import { Callout } from "@/components/docs/callout";
import { PageNav } from "@/components/docs/page-nav";
import { shotUrl, shots } from "@/lib/screenshots";

export const metadata = { title: "권한 — LLM 자율 검토" };

export default function Page() {
  return (
    <article>
      <PageHero
        eyebrow="Host · Permissions"
        title="LLM 자율 검토 모드"
        description="Reviewer 모드 4종 중 'llm' 모드. 단순 정적 규칙으로는 잡기 어려운 위험 패턴 (자연어 reason, 인자 정황, cross-tool chain) 을 LLM 이 보조 평가합니다. 평가 결과는 권고일 뿐 — 실제 결정은 호스트가 사용자 grant + RiskLevel 과 결합해 내립니다."
        tags={["src/permissions/reviewer/risk-classifier.ts", "modes: disabled · rule · llm · strict"]}
      />

      <ScreenshotGallery columns={1}>
        <ScreenshotCard src={shotUrl("chat-permission-llm-review")} caption={shots["chat-permission-llm-review"].caption} aspect="wide" />
      </ScreenshotGallery>

      <FeatureGrid
        columns={2}
        items={[
          { title: "disabled", body: <>LLM 검토 끔. 정적 규칙 (RiskLevel × Category × grant) 만 적용.</> },
          { title: "rule", body: <>정적 규칙 기반 권고. LLM 호출 없음 → 빠름.</>, tone: "teal" },
          { title: "llm", body: <>LLM 이 인자 + reason + 컨텍스트를 보고 권고 발사. medium/high 도구 호출 시 활성.</>, tone: "citron" },
          { title: "strict", body: <>모든 medium/high 액션을 사용자 다이얼로그 강제. 자동화 최소화.</>, tone: "coral" },
        ]}
      />

      <h2 id="when">언제 LLM 검토가 발사되나요?</h2>
      <ul>
        <li>도구 호출 시점, reviewer 가 RiskLevel ≥ <code>medium</code> 으로 분류한 경우.</li>
        <li>cross-plugin <code>callTool</code> chain 에서 권한 범위가 매니페스트 <code>pluginAccess</code> 와 일치하는지 확인.</li>
        <li><code>hostApi.agentApproval.request</code> 가 호출된 cross-plugin 위험 액션 — reason + scope 를 LLM 이 검토.</li>
      </ul>

      <h2 id="limits">LLM이 직접 변경할 수 없는 것</h2>
      <ul>
        <li>도구 RiskLevel — 메타로 고정. LLM 결과로 격하할 수 없음.</li>
        <li>도구 Category (<code>read | write | shell | network | meta</code>) — manifest <code>toolSchemas.&lt;tool&gt;.category</code> 고정.</li>
        <li>사용자 grant — 사용자만 변경 가능.</li>
      </ul>

      <Callout tone="warn" title="No-fallback 룰">
        LLM 권고가 자동 실행을 허용해도 정적 규칙이 차단하면 차단이 우선. 우회/fallback 으로 위험 액션을 실행시키는 코드는 작성하지 않습니다.
        대신 risk meta 자체를 수정하거나, 도구를 read/write 로 분리하거나, agentApproval 흐름을 명시적으로 거치는 것이 정답.
      </Callout>

      <PageNav />
    </article>
  );
}
