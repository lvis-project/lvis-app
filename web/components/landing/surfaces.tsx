import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { Reveal } from "@/components/motion/reveal";
import type { Locale } from "@/lib/i18n";

const copy = {
  ko: {
    heading: "두 개의 접점, 하나의 흐름.",
    lead: "앱이 신호를 모으고, Marketplace에서 기능을 더하며, Agent Hub가 결과를 기록합니다.",
    marketplaceEyebrow: "Marketplace",
    marketplaceHeading: "플러그인을 탐색하고 설치합니다.",
    marketplaceBody: "버전, 배포 패키지, 설치 정책을 한 곳에서 확인합니다. 앱은 이 카탈로그를 통해 필요한 플러그인을 내려받고 검증한 뒤 등록합니다.",
    marketplaceLink: "마켓플레이스 열기 ",
    storeRows: [
      { name: "Microsoft 365", meta: "ms-graph · v0.4.2 · 사용자 설치 가능", chip: "설치", installed: false },
      { name: "Meeting", meta: "meeting · v0.5.1 · 사용자 설치 가능", chip: "설치", installed: false },
      { name: "Local Indexer", meta: "local-indexer · v0.3.0 · 사용자 설치 가능", chip: "설치됨", installed: true },
    ],
    hubEyebrow: "개인 Agent Hub",
    hubHeading: "내 작업을 칸반 보드로 정리합니다.",
    hubBody: "에이전트가 만든 할 일·승인 요청·일일 리포트를 LVIS 앱 안의 개인 칸반 보드에 모읍니다. 할 일 · 진행 중 · 완료로 흐름을 한눈에 보고, 실행은 언제나 당신의 승인으로 시작됩니다.",
    hubNote: "LVIS 앱에 내장된 개인 보드입니다.",
    kanban: [
      {
        col: "할 일",
        cards: [
          { title: "QA 일정·인원 배분", tag: "5/26" },
          { title: "팀 보드 일일 리포트", tag: "승인 대기" },
        ],
      },
      { col: "진행 중", cards: [{ title: "SDK 마이그레이션 가이드 초안", tag: "5/27" }] },
      { col: "완료", cards: [{ title: "주간 신호 요약", tag: "완료" }] },
    ],
  },
  en: {
    heading: "Two surfaces, one flow.",
    lead: "The app gathers signals, the Marketplace adds capabilities, and Agent Hub records the results.",
    marketplaceEyebrow: "Marketplace",
    marketplaceHeading: "Discover and install plugins.",
    marketplaceBody: "Check versions, distribution packages, and install policies in one place. The app downloads, verifies, and registers the plugins you need through this catalog.",
    marketplaceLink: "Open the marketplace ",
    storeRows: [
      { name: "Microsoft 365", meta: "ms-graph · v0.4.2 · user-installable", chip: "Install", installed: false },
      { name: "Meeting", meta: "meeting · v0.5.1 · user-installable", chip: "Install", installed: false },
      { name: "Local Indexer", meta: "local-indexer · v0.3.0 · user-installable", chip: "Installed", installed: true },
    ],
    hubEyebrow: "Personal Agent Hub",
    hubHeading: "Organize your work on a kanban board.",
    hubBody: "To-dos, approval requests, and daily reports your agents create are collected on a personal kanban board inside the LVIS app. See the flow at a glance across To do · In progress · Done — execution always starts with your approval.",
    hubNote: "A personal board built into the LVIS app.",
    kanban: [
      {
        col: "To do",
        cards: [
          { title: "QA schedule & staffing", tag: "5/26" },
          { title: "Team board daily report", tag: "Awaiting approval" },
        ],
      },
      { col: "In progress", cards: [{ title: "SDK migration guide draft", tag: "5/27" }] },
      { col: "Done", cards: [{ title: "Weekly signal summary", tag: "Done" }] },
    ],
  },
} as const;

export function Surfaces({ locale = "ko" }: { locale?: Locale }) {
  const t = copy[locale];
  return (
    <section id="surfaces" className="mx-auto max-w-[1120px] scroll-mt-20 px-6 py-24">
      <Reveal>
        <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-muted-foreground">Surfaces</p>
        <h2 className="mt-2 max-w-2xl text-[clamp(1.75rem,3.5vw,2.5rem)] font-semibold tracking-[-0.02em] text-ink">
          {t.heading}
        </h2>
        <p className="mt-4 max-w-2xl text-[16px] leading-relaxed text-muted-foreground">
          {t.lead}
        </p>
      </Reveal>

      <div className="mt-10 grid gap-4 lg:grid-cols-2">
        <Reveal>
          <article className="flex h-full flex-col rounded-2xl border border-border bg-white p-6">
            <p className="text-[11px] font-bold uppercase tracking-[0.16em] text-muted-foreground">{t.marketplaceEyebrow}</p>
            <h3 className="mt-2 text-[19px] font-semibold tracking-[-0.01em] text-ink">
              {t.marketplaceHeading}
            </h3>
            <p className="mt-2 text-[13.5px] leading-relaxed text-muted-foreground">
              {t.marketplaceBody}
            </p>
            <div className="mt-5 grid gap-2" aria-hidden>
              {t.storeRows.map((r) => (
                <div key={r.name} className="flex items-center gap-3 rounded-lg border border-border bg-secondary/40 px-3.5 py-2.5">
                  <span className="grid h-8 w-8 shrink-0 place-items-center rounded-md border border-border bg-white font-mono text-[11px] font-bold text-ink-soft">
                    {r.name.slice(0, 1)}
                  </span>
                  <div className="min-w-0">
                    <p className="truncate text-[13.5px] font-semibold text-ink">{r.name}</p>
                    <p className="truncate font-mono text-[11px] text-muted-foreground">{r.meta}</p>
                  </div>
                  <span
                    className={
                      r.installed
                        ? "ml-auto shrink-0 rounded-full bg-ink px-2.5 py-0.5 text-[11px] font-semibold text-white"
                        : "ml-auto shrink-0 rounded-full border border-border bg-white px-2.5 py-0.5 text-[11px] font-semibold text-ink"
                    }
                  >
                    {r.chip}
                  </span>
                </div>
              ))}
            </div>
            <Link
              href="https://marketplace.lvisai.xyz/"
              target="_blank"
              rel="noreferrer"
              className="mt-5 inline-flex items-center gap-1 text-[13px] font-semibold text-ink hover:underline"
            >
              {t.marketplaceLink}<ArrowRight className="h-3.5 w-3.5" />
            </Link>
          </article>
        </Reveal>

        <Reveal delay={90}>
          <article className="flex h-full flex-col rounded-2xl border border-border bg-white p-6">
            <p className="text-[11px] font-bold uppercase tracking-[0.16em] text-muted-foreground">{t.hubEyebrow}</p>
            <h3 className="mt-2 text-[19px] font-semibold tracking-[-0.01em] text-ink">
              {t.hubHeading}
            </h3>
            <p className="mt-2 text-[13.5px] leading-relaxed text-muted-foreground">
              {t.hubBody}
            </p>
            <div className="mt-5 grid grid-cols-3 gap-2" aria-hidden>
              {t.kanban.map((col) => (
                <div key={col.col} className="rounded-lg border border-border bg-secondary/40 p-2">
                  <p className="px-1 pb-1.5 text-[11px] font-bold text-muted-foreground">{col.col}</p>
                  <div className="grid gap-1.5">
                    {col.cards.map((c) => (
                      <div key={c.title} className="rounded-md border border-border bg-white p-2">
                        <p className="text-[11.5px] font-medium leading-snug text-ink">{c.title}</p>
                        <span className="mt-1.5 inline-block rounded-full bg-secondary px-1.5 py-0.5 text-[10px] font-semibold text-muted-foreground">
                          {c.tag}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
            <p className="mt-5 text-[12.5px] text-muted-foreground">{t.hubNote}</p>
          </article>
        </Reveal>
      </div>
    </section>
  );
}
