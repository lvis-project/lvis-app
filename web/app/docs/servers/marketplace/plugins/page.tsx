import { PageHero } from "@/components/docs/page-hero";
import { ScreenshotCard, ScreenshotGallery } from "@/components/docs/screenshot-card";
import { Callout } from "@/components/docs/callout";
import { PageNav } from "@/components/docs/page-nav";
import { shotUrl, shots } from "@/lib/screenshots";

export const metadata = { title: "Marketplace — 플러그인 카탈로그" };

export default function Page() {
  return (
    <article>
      <PageHero
        eyebrow="Marketplace"
        title="플러그인 카탈로그"
        description="설치 가능한 플러그인을 한 화면에서 보여줍니다. 각 카드에는 id · 최신 버전 · 요구 권한 요약 · 퍼블리셔 · 다운로드 통계가 함께 표시됩니다."
      />

      <ScreenshotGallery columns={1}>
        <ScreenshotCard src={shotUrl("mp-plugin")} caption={shots["mp-plugin"].caption} aspect="wide" />
      </ScreenshotGallery>

      <h2 id="install">설치 흐름</h2>
      <ul>
        <li>웹 페이지의 ‘설치’ 버튼을 누르면 LVIS 호스트로 등록 요청이 전달됩니다.</li>
        <li>호스트가 패키지의 출처 서명을 다시 확인하고, 요구하는 권한 목록을 사용자에게 보여 줍니다.</li>
        <li>사용자가 확인하면 호스트의 안전한 영역에 플러그인이 설치되고, 첫 활성화가 진행됩니다.</li>
        <li>설치 직후 어떤 작업도 자동으로 일어나지 않습니다. 모든 위험한 동작은 사용자가 직접 누르는 시점에 시작됩니다.</li>
      </ul>

      <Callout tone="security" title="검증 실패 시 즉시 거절">
        매니페스트 또는 서명이 검증되지 않으면 호스트는 설치를 즉시 거절하고 감사 기록에 거절 이벤트를 남깁니다. 우회 경로는 없습니다.
      </Callout>

      <PageNav />
    </article>
  );
}
