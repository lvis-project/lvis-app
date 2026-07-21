import { PageHero } from "@/components/docs/page-hero";
import { ScreenshotCard, ScreenshotGallery } from "@/components/docs/screenshot-card";
import { Callout } from "@/components/docs/callout";
import { PageNav } from "@/components/docs/page-nav";
import { shotUrl, shots } from "@/lib/screenshots";

export const metadata = { title: "Marketplace — Agents" };

export default function Page() {
  return (
    <article>
      <PageHero
        eyebrow="Marketplace"
        title="Agents (plugin_type=agent)"
        description="동일 catalog API에 plugin_type=agent 필터를 건 뷰. Plugin 보다 더 작은, 단일 작업 단위 패키지를 모아 보여줍니다. 별도 REST 리소스/모델이 아니라 같은 Plugin row + plugin_type discriminator."
      />

      <ScreenshotGallery columns={1}>
        <ScreenshotCard src={shotUrl("mp-agents")} caption={shots["mp-agents"].caption} aspect="wide" />
      </ScreenshotGallery>

      <h2 id="how">데이터 모델</h2>
      <p>
        Marketplace DB 에는 <code>Plugin</code> 모델 단 하나만 존재 (<code>server/src/lvis_marketplace/models.py:31</code>). <code>plugin_type</code> 컬럼이 plugin / agent / mcp / skill 을 구분.
        Agents 페이지의 카드는 <code>GET /api/v1/catalog?plugin_type=agent</code> 응답을 그대로 렌더.
      </p>

      <Callout tone="info" title="설치 deeplink 형태가 다름">
        agent / mcp / skill 은 type prefix 를 포함한 deeplink: <code>lvis://install/&lt;type&gt;/&lt;slug&gt;</code>.
        예: <code>lvis://install/agent/weekly-retro</code>. 호스트가 type에 따라 추가 manifest 검증 + 다른 sandbox 설정 적용.
      </Callout>

      <PageNav />
    </article>
  );
}
