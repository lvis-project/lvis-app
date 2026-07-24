import { PageHero } from "@/components/docs/page-hero";
import { ScreenshotCard, ScreenshotGallery } from "@/components/docs/screenshot-card";
import { FeatureGrid } from "@/components/docs/feature-grid";
import { PageNav } from "@/components/docs/page-nav";
import { shotUrl, shots } from "@/lib/screenshots";
import { Callout } from "@/components/docs/callout";

export const metadata = { title: "플러그인 패널" };

export default function Page() {
  return (
    <article>
      <PageHero
        eyebrow="Host · Chat"
        title="채팅 안 플러그인 패널"
        description="활성 플러그인이 사이드바에 노출됩니다. 각 플러그인은 하나의 검증된 manifest 로 UI 슬롯, 지침 Skill, 호출 가능한 Tool을 제공합니다. 호스트 코어는 plugin specific 코드를 직접 import 하지 않습니다."
      />

      <ScreenshotGallery columns={1}>
        <ScreenshotCard src={shotUrl("chat-plugin-panel")} caption={shots["chat-plugin-panel"].caption} aspect="wide" />
      </ScreenshotGallery>

      <FeatureGrid
        columns={3}
        items={[
          { title: "번들 Skill", body: <>manifest <code>skills[]</code> 항목이 검증된 <code>SKILL.md</code> 지침 번들을 설치합니다. 자연어 입력만으로 Tool을 암묵 호출하거나 preload하지 않습니다.</>, tone: "teal" },
          { title: "ui[] 슬롯", body: <>plugin.json 의 <code>ui[]</code> 가 <code>slot</code>(sidebar/chat/popover/embedded)·<code>kind</code>(embedded-module/url)·<code>entry</code>·<code>exportName</code>·<code>window</code> 를 선언.</> },
          { title: "Tools list", body: <>도구는 manifest <code>tools[]</code> 에 정적 선언. 핸들러는 <code>RuntimePlugin.handlers</code> map. 도구 이름 정규식 <code>^[a-zA-Z_][a-zA-Z0-9_]*$</code>.</>, tone: "citron" },
        ]}
      />

      <h2 id="naming">이름 규약 — 세 가지 namespace</h2>
      <ul>
        <li><strong>LLM 도구 이름</strong>: <code>^[a-zA-Z_][a-zA-Z0-9_]*$</code> (<code>src/plugins/runtime/manifest-validation.ts:289</code>). 선두 숫자 / dash 불가. vendor 요구 사항 (OpenAI / Gemini / Claude 공통).</li>
        <li><strong>Skill / agent / session id</strong>: 별도 — <code>^[a-zA-Z0-9_-]+$</code> (<code>src/core/skill-store.ts:30</code>). dash 허용.</li>
        <li><strong>플러그인 id</strong>: 보통 kebab-case (예: <code>local-indexer</code>, <code>ms-graph</code>). manifest <code>id</code> 필드.</li>
      </ul>

      <Callout tone="info" title="런타임 register API가 없음">
        호스트 부팅 시점에 <code>src/boot.ts:703-736</code> 가 모든 plugin manifest 의 <code>tools[]</code> 를 Tool Registry 에 등록합니다.
        실행 중에 도구를 동적으로 추가하는 API는 없습니다 — 도구 변경은 plugin 재배포 + 재시작이 필요합니다.
      </Callout>

      <PageNav />
    </article>
  );
}
