import { PageHero } from "@/components/docs/page-hero";
import { ScreenshotCard, ScreenshotGallery } from "@/components/docs/screenshot-card";
import { Callout } from "@/components/docs/callout";
import { PageNav } from "@/components/docs/page-nav";
import { shotUrl, shots } from "@/lib/screenshots";

export const metadata = { title: "Marketplace — MCP 서버" };

export default function Page() {
  return (
    <article>
      <PageHero
        eyebrow="Marketplace"
        title="MCP 서버 카탈로그 (plugin_type=mcp)"
        description="Anthropic Model Context Protocol 호환 서버 디렉토리. 호스트는 카탈로그에서 MCP 서버를 등록해 추가 도구 셋을 Tool Registry 의 source='mcp' 로 노출. 등록 정보는 ~/.lvis/mcp/servers.json 에 보관."
      />

      <ScreenshotGallery columns={1}>
        <ScreenshotCard src={shotUrl("mp-mcp")} caption={shots["mp-mcp"].caption} aspect="wide" />
      </ScreenshotGallery>

      <h2 id="what">MCP 가 무엇인가요?</h2>
      <p>
        Model Context Protocol — Anthropic 이 제안한 open spec 으로 “LLM 이 외부 서버의 도구/리소스/프롬프트를 표준 인터페이스로 호출” 하는 프로토콜.
        LVIS 호스트는 native plugin 외에도 MCP 서버를 등록해 추가 도구를 손쉽게 가져옵니다.
      </p>

      <h2 id="register">등록 흐름</h2>
      <ol>
        <li>Storefront에서 <code>lvis://mcp-login/&lt;slug&gt;</code> deeplink (PluginDetailPage:178) 발사 또는 직접 endpoint 입력.</li>
        <li>호스트가 MCP handshake 로 서버 메타 / 도구 목록 fetch 후 <code>~/.lvis/mcp/&lt;slug&gt;/</code> 에 metadata 저장.</li>
        <li><code>~/.lvis/mcp/servers.json</code> 에 등록 (boot.ts:1012-1016).</li>
        <li>Tool Registry 에 source='mcp' 로 등록. Reviewer 가 기본 RiskLevel = <code>medium</code> 으로 분류.</li>
      </ol>

      <Callout tone="security" title="MCP 도구의 RiskLevel">
        외부 MCP 서버의 도구는 <strong>기본 medium</strong>. publisher 가 risk meta 를 제공해도 admin 단계에서 reclassify 됩니다.
        자동 실행 (low) 으로 노출되려면 명시적 admin 승인이 필요합니다.
      </Callout>

      <PageNav />
    </article>
  );
}
