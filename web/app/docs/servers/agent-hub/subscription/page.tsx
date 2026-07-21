import { PageHero } from "@/components/docs/page-hero";
import { ScreenshotCard, ScreenshotGallery } from "@/components/docs/screenshot-card";
import { Callout } from "@/components/docs/callout";
import { PageNav } from "@/components/docs/page-nav";
import { shotUrl, shots } from "@/lib/screenshots";

export const metadata = { title: "Agent Hub — 팀 피드 구독" };

export default function Page() {
  return (
    <article>
      <PageHero
        eyebrow="Agent Hub"
        title="팀 피드 구독"
        description="‘이 팀의 피드를 받겠다’ 는 사용자별 opt-in 관계. 구독한 팀의 업무 카드가 사용자의 보드와 인박스에 함께 흐릅니다."
        tags={["opt-in 관계", "사용자 단위", "언제든 해지"]}
      />

      <ScreenshotGallery columns={1}>
        <ScreenshotCard src={shotUrl("ah-subscription")} caption={shots["ah-subscription"].caption} aspect="wide" />
      </ScreenshotGallery>

      <h2 id="manage">구독 / 해지</h2>
      <ul>
        <li>관심 있는 팀을 골라 ‘구독’ 을 누르면 보드와 인박스에 그 팀의 활동이 흐르기 시작합니다.</li>
        <li>‘해지’ 를 누르면 즉시 피드가 멈춥니다. 이전에 받은 카드는 그대로 보존.</li>
        <li>관리자가 강제로 구독을 끊지 않는 한, 사용자가 직접 켜고 끄는 모델입니다.</li>
      </ul>

      <Callout tone="info" title="구독은 ‘플랜’ 이 아닙니다">
        이 페이지에서 말하는 ‘구독’ 은 라이선스나 결제 플랜이 아니라 사용자 ↔ 팀 사이의 피드 opt-in 관계입니다.
      </Callout>

      <PageNav />
    </article>
  );
}
