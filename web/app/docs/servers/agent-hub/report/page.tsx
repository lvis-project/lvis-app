import { PageHero } from "@/components/docs/page-hero";
import { ScreenshotCard, ScreenshotGallery } from "@/components/docs/screenshot-card";
import { FeatureGrid } from "@/components/docs/feature-grid";
import { PageNav } from "@/components/docs/page-nav";
import { shotUrl, shots } from "@/lib/screenshots";

export const metadata = { title: "Agent Hub — Report" };

export default function Page() {
  return (
    <article>
      <PageHero
        eyebrow="Agent Hub"
        title="Report — 개인 / 팀 운영 리포트"
        description="에이전트 운영을 양적으로 들여다보는 화면. 처리량 · 응답 시간 · 수락률 · 놓친 업무를 한 자리에 정리해 다음 자동화 대상을 정하는 근거로 씁니다."
      />

      <ScreenshotGallery columns={1}>
        <ScreenshotCard src={shotUrl("ah-report")} caption={shots["ah-report"].caption} aspect="wide" />
      </ScreenshotGallery>

      <FeatureGrid
        columns={4}
        items={[
          { title: "처리량", body: <>일 / 주 / 월 단위 완료된 카드 수.</> },
          { title: "응답 시간", body: <>카드 생성 → 첫 응답까지의 중앙값.</> },
          { title: "수락률", body: <>제안 → ‘수락’ 응답 비율.</>, tone: "teal" },
          { title: "놓친 업무", body: <>마감 지난 카드. 다음 자동화 대상 후보.</>, tone: "coral" },
        ]}
      />

      <p className="mt-4 text-[13px] text-muted-foreground">
        주간 리포트는 호스트의 에이전트 허브 플러그인이 일정 주기로 생성합니다 — 사람이 매번 정리하지 않아도 같은 형식으로 보존됩니다.
      </p>

      <PageNav />
    </article>
  );
}
