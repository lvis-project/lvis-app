import { PageHero } from "@/components/docs/page-hero";
import { StepList } from "@/components/docs/step-list";
import { ScreenshotCard, ScreenshotGallery } from "@/components/docs/screenshot-card";
import { Callout } from "@/components/docs/callout";
import { PageNav } from "@/components/docs/page-nav";
import { shotUrl, shots } from "@/lib/screenshots";

export const metadata = { title: "로그인 & 첫 화면" };

export default function Page() {
  return (
    <article>
      <PageHero
        eyebrow="Getting Started"
        title="Marketplace 로그인 & 첫 화면"
        description="호스트 앱 자체는 로컬-퍼스트로 작동하지만, 플러그인 카탈로그 / 다운로드 / 서명 검증을 위해 Marketplace 계정 + Agent Hub 서버 인증이 필요합니다. 인증은 plugin 측 hostApi.openAuthWindow / hostApi.openAuthPartitionViewer 로 처리됩니다."
      />

      <h2 id="why">왜 로그인이 필요할까요?</h2>
      <ul>
        <li><strong>Marketplace</strong> — 플러그인 catalog read + 패키지 다운로드 (deeplink <code>lvis://install/&lt;slug&gt;</code> 이 호스트로 routing).</li>
        <li><strong>Agent Hub</strong> — Work Board / Inbox 동기화 (HTTPBearer 토큰, <code>agent-hub.lvisai.xyz</code>).</li>
        <li><strong>ms-graph, lge-api</strong> — 각 플러그인 자체 OAuth (MSAL · EP SSO). 토큰은 plugin namespace 에 격리.</li>
      </ul>

      <h2 id="flow">로그인 흐름</h2>
      <StepList
        steps={[
          { title: "메인 호스트 → Marketplace SSO", body: <p>웹 브라우저에서 Marketplace LoginPage 진입. Marketplace 서버 (<code>marketplace.lvisai.xyz</code>) 의 <code>/api/v1/auth/*</code> 가 응답.</p> },
          { title: "API key 발급", body: <p>로그인 성공 시 ApiKey (publisher/admin role) 가 발급되고, 클라이언트는 키의 sha256 hash 가 서버 DB 의 <code>api_keys.key_hash</code> 와 매칭되는지 검증.</p>, badge: "1회" },
          { title: "Agent Hub 토큰", body: <p>Work Board 사용을 위해 별도 Agent Hub <code>/auth/exchange/issue</code> + <code>/auth/exchange/redeem</code> 흐름 (<code>lvis-agent-hub/src/.../api/auth_exchange.py</code>). PKCE-like.</p> },
          { title: "Plugin OAuth — 필요 시", body: <p>ms-graph (MSAL) / lge-api (EP SSO) 는 plugin install 후 첫 사용 시 <code>hostApi.openAuthWindow</code> 로 별도 처리.</p> },
        ]}
      />

      <h2 id="first-screen">첫 화면 — 어떤 구성으로 보이나요?</h2>
      <ScreenshotGallery columns={2}>
        <ScreenshotCard src={shotUrl("chat-plugin-panel")} caption={shots["chat-plugin-panel"].caption} />
        <ScreenshotCard src={shotUrl("chat-question-card")} caption={shots["chat-question-card"].caption} />
      </ScreenshotGallery>

      <Callout tone="tip" title="로그인 없이도 쓸 수 있는 범위">
        호스트 채팅과 로컬 plugin (예: Local Indexer 의 사전 인덱싱된 폴더) 은 로그인 없이 동작합니다.
        다만 플러그인 신규 설치 · Marketplace 카탈로그 · Agent Hub 보드 sync 는 비활성화됩니다.
      </Callout>

      <PageNav />
    </article>
  );
}
