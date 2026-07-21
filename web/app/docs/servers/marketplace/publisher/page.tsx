import { PageHero } from "@/components/docs/page-hero";
import { ScreenshotCard, ScreenshotGallery } from "@/components/docs/screenshot-card";
import { StepList } from "@/components/docs/step-list";
import { Callout } from "@/components/docs/callout";
import { PageNav } from "@/components/docs/page-nav";
import { shotUrl, shots } from "@/lib/screenshots";

export const metadata = { title: "Marketplace — 퍼블리셔" };

export default function Page() {
  return (
    <article>
      <PageHero
        eyebrow="Marketplace · Publisher"
        title="퍼블리셔 — 자기 패키지를 올리는 사람을 위한 화면"
        description="플러그인 · Agent · MCP · Skill 을 Marketplace 에 올리는 사람을 위한 대시보드. 새 버전 업로드 · 변경 이력 확인 · 다운로드 통계 · 사용자 리뷰 응답을 한 곳에서 처리합니다."
        tags={["발행자 서명", "버전 단위 immutable", "어드민 승인 대기"]}
      />

      <ScreenshotGallery columns={2}>
        <ScreenshotCard src={shotUrl("mp-publisher")} caption={shots["mp-publisher"].caption} />
        <ScreenshotCard src={shotUrl("mp-publisher-2")} caption={shots["mp-publisher-2"].caption} />
      </ScreenshotGallery>

      <h2 id="upload">패키지 업로드 흐름</h2>
      <StepList
        steps={[
          { title: "패키지 로그인", body: <p>발행 도구로 자기 계정에 로그인합니다. 발행자 키가 등록됩니다.</p>, badge: "1회" },
          { title: "패키지 빌드 + 서명", body: <p>로컬에서 패키지를 빌드하고 발행자 키로 서명합니다. 서명이 패키지 안에 함께 들어갑니다.</p>, badge: "서명" },
          { title: "업로드 → 승인 대기", body: <p>업로드 후 어드민 승인 큐에 들어갑니다. 일반 사용자에게는 아직 노출되지 않습니다.</p> },
          { title: "어드민 승인 → 공개", body: <p>어드민이 확인하면 카탈로그에 노출됩니다. 한 번 공개된 버전은 immutable — 같은 (id, version) 으로 재업로드 불가.</p>, badge: "공개" },
        ]}
      />

      <Callout tone="info" title="문제가 생기면 새 버전 + yank">
        한 번 공개된 버전을 ‘덮어쓰기’ 할 수 없습니다. 문제가 발견되면 새 버전을 올리거나, 어드민에게 ‘이전 버전 회수 (yank)’ 를 요청합니다.
      </Callout>

      <PageNav />
    </article>
  );
}
