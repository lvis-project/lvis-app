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
        <li>Storefront에서 <code>lvis://mcp-login/&lt;slug&gt;</code> deeplink 발사 또는 직접 endpoint 입력. (Storefront 는 별도 저장소인 marketplace 웹 앱입니다.)</li>
        <li>호스트가 MCP handshake 로 서버 메타 / 도구 목록 fetch 후 <code>~/.lvis/mcp/&lt;slug&gt;/</code> 에 metadata 저장.</li>
        <li><code>~/.lvis/mcp/servers.json</code> 에 등록 (호스트 경로: <code>src/mcp/mcp-manager.ts</code>).</li>
        <li>Tool Registry 에 source=&apos;mcp&apos; 로 등록. 호스트는 이 출처를 세 신뢰 등급 중 가장 낮은 등급에 둡니다 (<code>src/tools/types.ts</code>).</li>
      </ol>

      <Callout tone="security" title="등록했다고 자동 실행되지는 않습니다">
        외부 MCP 서버의 도구는 호스트가 세 신뢰 등급 중 가장 낮은 등급으로 다루고, <strong>위험도로 자동 허용되는 경로에서 걸러져 확인 카드로 갑니다</strong> — 읽기만 하는 도구도 마찬가지입니다.
        확인이 생략되는 경우와 그 범위는 <a href="/docs/host/mcp#beyond-tools">MCP 서버 문서</a> 에 정리돼 있습니다.
      </Callout>

      <PageNav />
    </article>
  );
}
