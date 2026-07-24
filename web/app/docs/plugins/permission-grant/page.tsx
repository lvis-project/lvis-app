import { PageHero } from "@/components/docs/page-hero";
import { ScreenshotCard, ScreenshotGallery } from "@/components/docs/screenshot-card";
import { StepList } from "@/components/docs/step-list";
import { Callout } from "@/components/docs/callout";
import { PageNav } from "@/components/docs/page-nav";
import { shotUrl, shots } from "@/lib/screenshots";

export const metadata = { title: "플러그인 권한 허용 흐름" };

export default function Page() {
  return (
    <article>
      <PageHero
        eyebrow="Plugins"
        title="권한 허용 흐름"
        description="플러그인이 처음 활성화될 때 manifest 선언과 호스트가 분류한 도구 위험도, pluginAccess, hostSecrets, agentApprovalScopes를 사용자에게 한번에 표시하는 통합 다이얼로그."
      />

      <ScreenshotGallery columns={1}>
        <ScreenshotCard src={shotUrl("plugin-permission-grant")} caption={shots["plugin-permission-grant"].caption} aspect="wide" />
      </ScreenshotGallery>

      <h2 id="what">manifest 로부터 검토되는 항목</h2>
      <ul>
        <li><strong>capabilities</strong>: 형식 검증된 기능 태그. 호스트가 알고 있는 capability만 실제 기능 게이트로 사용하고 나머지는 권한을 부여하지 않는 자기 선언으로 취급.</li>
        <li><strong>tools[]</strong>: 순수 MCP <code>Tool</code> 객체 목록. 호스트가 입력 스키마와 실행 경로로 위험도를 분류하며, 서명된 <code>tool._meta[&quot;lvisai/operationPolicy&quot;]</code>는 operation별 최소 위험도와 read-before-write 요구를 강화할 수만 있음.</li>
        <li><strong>pluginAccess</strong>: 다른 plugin 의 어떤 도구/이벤트를 사용할지 (예: work-assistant 가 ms-graph 의 <code>msgraph_calendar_today</code> 호출).</li>
        <li><strong>agentApprovalScopes</strong>: cross-plugin 위험 액션의 표준 라벨 (예: <code>agent_file_share</code>, <code>agent_task_delegate</code>, <code>agent_external_api_call</code>).</li>
        <li><strong>hostSecrets / llmKeySource</strong>: secret 접근 / LLM 키 vendor 선언.</li>
        <li><strong>configSchema</strong>: 사용자가 수정 가능한 설정 필드 + 기본값.</li>
      </ul>

      <h2 id="flow">사용자가 보는 흐름</h2>
      <StepList
        steps={[
          { title: "Marketplace 에서 deeplink", body: <p>웹 페이지의 “설치” 버튼이 <code>lvis://install/&lt;slug&gt;</code> 또는 <code>lvis://install/&lt;type&gt;/&lt;slug&gt;</code> 발사. 호스트가 URL 받아 처리 (<code>lvis-protocol.ts:72</code>).</p> },
          { title: "패키지 + 서명 검증", body: <p>Marketplace가 발급한 Ed25519 서명 envelope을 호스트가 검증. 알려진 public key 와 매칭되는 서명이 1개 이상이면 통과 (<code>marketplace/server/src/lvis_marketplace/signing.py:219</code>).</p>, badge: "sig" },
          { title: "권한 다이얼로그 — 한 번에 모두", body: <p>manifest 파싱 결과와 호스트가 분류한 도구 위험도를 capabilities / tools / pluginAccess / secrets 별로 묶어 표시. 사용자 확인 후 grant 저장.</p> },
          { title: "최초 활성화", body: <p><code>{"~/.lvis/plugins/<pluginId>/"}</code> 자기 namespace 생성 (0o700). 플러그인 <code>start()</code> 콜백 호출 — <code>hostApi.registerKeywords</code> 있다면 등록.</p>, badge: "start()" },
        ]}
      />

      <Callout tone="warn" title="권한 회수 후 동작">
        설치 후에도 호스트 설정 → 플러그인 → 해당 플러그인 → 권한 관리에서 grant 회수 가능.
        회수 상태에서 도구 호출이 들어오면 fallback 없이 즉시 reject + 재허용 카드 발사 (LVIS no-fallback 룰).
      </Callout>

      <PageNav />
    </article>
  );
}
