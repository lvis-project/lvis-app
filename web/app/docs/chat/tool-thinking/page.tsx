import { PageHero } from "@/components/docs/page-hero";
import { ScreenshotCard, ScreenshotGallery } from "@/components/docs/screenshot-card";
import { FeatureGrid } from "@/components/docs/feature-grid";
import { PageNav } from "@/components/docs/page-nav";
import { Callout } from "@/components/docs/callout";
import { shotUrl, shots } from "@/lib/screenshots";

export const metadata = { title: "Tool & Thinking 표시" };

export default function Page() {
  return (
    <article>
      <PageHero
        eyebrow="Host · Chat"
        title="도구 실행과 thinking 표시"
        description="LVIS가 도구를 호출하거나 LLM 이 생각 중인 내용을 사용자에게 시각적으로 노출합니다. 모든 도구 호출은 위험도와 종류에 따라 자동 실행 / 확인 카드 / 다이얼로그로 분기됩니다."
      />

      <ScreenshotGallery columns={1}>
        <ScreenshotCard src={shotUrl("chat-tool-thinking")} caption={shots["chat-tool-thinking"].caption} aspect="wide" />
      </ScreenshotGallery>

      <FeatureGrid
        columns={2}
        items={[
          { title: "Thinking 블록", body: <>LLM 이 답을 만들기 위해 ‘생각 중’ 인 내용을 옅은 인용 블록으로 보여줍니다. 클릭하면 접기 / 펼치기.</>, tone: "ink" },
          { title: "도구 실행 카드", body: <>도구 이름 · 사용한 입력 요약 · 결과 가 한 카드에. 결과가 길면 ‘자세히 보기’ 로 큰 창에 펼칩니다.</>, tone: "teal" },
        ]}
      />

      <h2 id="tool-source">도구의 출처 세 가지</h2>
      <ul>
        <li><strong>호스트 내장 도구</strong> — LVIS 자체가 제공하는 도구. 가장 신뢰됩니다.</li>
        <li><strong>플러그인 도구</strong> — 설치된 플러그인이 등록한 도구. 자기 영역 안에서 동작.</li>
        <li><strong>외부 MCP 도구</strong> — 사용자가 등록한 외부 MCP 서버의 도구. 기본 ‘중간 위험도’ 로 보수적으로 분류.</li>
      </ul>

      <Callout tone="security" title="모든 도구 호출은 기록됩니다">
        성공이든 실패든 모든 도구 호출은 한 줄짜리 기록으로 안전한 저장소에 남습니다. 외부 코드 실행은 별도 기록으로 분리되어 더 오래 보관됩니다.
      </Callout>

      <PageNav />
    </article>
  );
}
