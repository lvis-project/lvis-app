import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { PageHero } from "@/components/docs/page-hero";
import { ScreenshotCard, ScreenshotGallery } from "@/components/docs/screenshot-card";
import { Callout } from "@/components/docs/callout";
import { PageNav } from "@/components/docs/page-nav";
import { shotUrl, shots } from "@/lib/screenshots";

const sections = [
  { href: "/docs/servers/marketplace/plugins", title: "플러그인 카탈로그", desc: "설치 가능한 플러그인 목록." },
  { href: "/docs/servers/marketplace/agents", title: "Agents", desc: "작은 작업 단위 패키지." },
  { href: "/docs/servers/marketplace/mcp", title: "MCP 서버", desc: "외부 도구 셋 디렉토리." },
  { href: "/docs/servers/marketplace/skills", title: "Skills", desc: "재사용 가능한 능력 묶음." },
  { href: "/docs/servers/marketplace/publisher", title: "퍼블리셔", desc: "패키지 업로드 / 버전 관리." },
  { href: "/docs/servers/marketplace/admin", title: "어드민", desc: "승인 · 회수 · 키 관리." },
];

export const metadata = { title: "Marketplace 개요" };

export default function Page() {
  return (
    <article>
      <PageHero
        eyebrow="Server · Marketplace"
        title="LVIS Marketplace — 한 카탈로그, 네 가지 패키지 종류"
        description="플러그인 · Agent · MCP · Skill 을 한 곳에서 발견하고 설치하는 마켓플레이스. 모든 패키지는 발행자 서명으로 출처가 검증되며, 사용자 호스트에 직접 deeplink 로 설치됩니다."
        tags={["출처 검증된 패키지", "단일 install 흐름", "퍼블리셔 + 어드민 분리"]}
      />

      <ScreenshotGallery columns={1}>
        <ScreenshotCard src={shotUrl("mp-login")} caption={shots["mp-login"].caption} aspect="wide" />
      </ScreenshotGallery>

      <h2 id="audience">사용자 페르소나</h2>
      <ul>
        <li><strong>일반 사용자</strong> — 카탈로그에서 원하는 패키지를 골라 호스트로 설치.</li>
        <li><strong>퍼블리셔</strong> — 자기 패키지를 업로드하고 버전 관리.</li>
        <li><strong>어드민</strong> — 게시 승인 / 회수 / 사용자 키 관리 / 운영 통계 확인.</li>
      </ul>

      <div className="my-8 grid gap-3 sm:grid-cols-2">
        {sections.map((s) => (
          <Link key={s.href} href={s.href} className="group rounded-lg border border-border bg-white p-4 transition hover:border-teal/40 hover:shadow-sm">
            <div className="flex items-center justify-between">
              <p className="text-[15px] font-semibold text-ink group-hover:text-teal">{s.title}</p>
              <ArrowRight className="h-4 w-4 text-muted-foreground group-hover:text-teal" />
            </div>
            <p className="mt-1 text-[13px] text-muted-foreground">{s.desc}</p>
          </Link>
        ))}
      </div>

      <Callout tone="info" title="네 가지 종류, 한 카탈로그">
        플러그인 · Agent · MCP · Skill 은 사용자 화면에서 별도 탭으로 보이지만, 발행 / 설치 흐름은 하나의 시스템 위에 통합되어 있습니다.
        퍼블리셔 입장에서도 한 가지 도구로 모든 종류의 패키지를 다룹니다.
      </Callout>

      <PageNav />
    </article>
  );
}
