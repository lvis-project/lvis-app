import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Reveal } from "@/components/motion/reveal";
import { HeroBackdrop } from "@/components/motion/hero-backdrop";
import { href, type Locale } from "@/lib/i18n";

const copy = {
  ko: {
    eyebrow: "Plugin-native desktop AI · approval-first",
    lead: (
      <>
        LVIS는 메일·일정·회의·문서·사내 API의 신호를 읽고, 적절한 순간에만 제안합니다.
        쓰기 작업은 언제나 <strong className="font-semibold text-ink">당신의 승인</strong>으로 시작됩니다.
      </>
    ),
    ctaDownload: "앱 다운로드",
    ctaWorkday: "하루의 흐름 보기",
    ctaDocs: "사용 가이드 ",
    facts: [
      { dt: "플러그인", dd: "6+" },
      { dt: "실행 정책", dd: "승인 후 실행" },
      { dt: "로컬 우선", dd: "온디바이스" },
    ],
    frameTitle: "LVIS · 오늘의 흐름",
    signalsLabel: "오늘 수집된 신호",
    signals: [
      { text: "새 메일", sub: "회의 요청 감지", tag: "ms-graph" },
      { text: "비어 있는 30분", sub: "화요일 14:00", tag: "ms-graph" },
      { text: "로컬 문서", sub: "3건 참조 가능", tag: "local-indexer" },
    ],
    proposalLabel: "제안",
    proposalTitle: "화요일 14:00 회의실 예약 + 답장 초안",
    approve: "승인하고 실행",
    details: "자세히",
    kbdHint: "로 언제든 명령",
  },
  en: {
    eyebrow: "Plugin-native desktop AI · approval-first",
    lead: (
      <>
        LVIS reads signals from your mail, calendar, meetings, documents, and internal APIs,
        and only speaks up at the right moment. Every write action starts with{" "}
        <strong className="font-semibold text-ink">your approval</strong>.
      </>
    ),
    ctaDownload: "Download the app",
    ctaWorkday: "See a day with LVIS",
    ctaDocs: "User guide ",
    facts: [
      { dt: "Plugins", dd: "6+" },
      { dt: "Run policy", dd: "Approve, then run" },
      { dt: "Local-first", dd: "On-device" },
    ],
    frameTitle: "LVIS · Today's flow",
    signalsLabel: "Signals gathered today",
    signals: [
      { text: "New email", sub: "Meeting request detected", tag: "ms-graph" },
      { text: "An open 30 min", sub: "Tue 14:00", tag: "ms-graph" },
      { text: "Local documents", sub: "3 references available", tag: "local-indexer" },
    ],
    proposalLabel: "Proposal",
    proposalTitle: "Book a room for Tue 14:00 + draft a reply",
    approve: "Approve & run",
    details: "Details",
    kbdHint: "to command anytime",
  },
} as const;

export function Hero({ locale = "ko" }: { locale?: Locale }) {
  const t = copy[locale];
  return (
    <section className="relative isolate overflow-hidden border-b border-border/60">
      <HeroBackdrop />
      <div className="mx-auto grid w-full max-w-[1120px] items-center gap-12 px-6 py-20 sm:py-24 lg:grid-cols-[1.05fr_0.95fr]">
        <div>
          <Reveal>
            <p className="mb-5 inline-flex items-center gap-2 rounded-full border border-border bg-white/70 px-3.5 py-1.5 text-[11px] font-bold uppercase tracking-[0.18em] text-ink-soft">
              <span className="h-1.5 w-1.5 rounded-full bg-ink" />
              {t.eyebrow}
            </p>
          </Reveal>
          <Reveal delay={60}>
            <h1 className="max-w-xl text-[clamp(2.5rem,5.5vw,3.75rem)] font-semibold leading-[1.06] tracking-[-0.025em] text-ink-soft">
              {locale === "en" ? (
                <>
                  <span className="text-ink">Quiet</span> observation,
                  <br />
                  <span className="text-ink">precise</span> suggestions,
                  <br />
                  your <span className="text-ink">approval</span>.
                </>
              ) : (
                <>
                  <span className="text-ink">조용한</span> 관찰,
                  <br />
                  <span className="text-ink">정확한</span> 제안,
                  <br />
                  당신의 <span className="text-ink">승인</span>.
                </>
              )}
            </h1>
          </Reveal>
          <Reveal delay={120}>
            <p className="mt-6 max-w-lg text-[16.5px] leading-relaxed text-muted-foreground">
              {t.lead}
            </p>
          </Reveal>
          <Reveal delay={180}>
            <div className="mt-8 flex flex-wrap items-center gap-2.5">
              <Button asChild size="lg" variant="default" className="text-[15px]">
                <Link href={`${locale === "en" ? "/en" : ""}/#download`}>{t.ctaDownload}</Link>
              </Button>
              <Button asChild size="lg" variant="outline" className="text-[15px]">
                <Link href={`${locale === "en" ? "/en" : ""}/#workday`}>{t.ctaWorkday}</Link>
              </Button>
              <Button asChild size="lg" variant="ghost" className="text-[15px]">
                <Link href={href(locale, "/docs/")}>{t.ctaDocs}<ArrowRight className="h-4 w-4" /></Link>
              </Button>
            </div>
          </Reveal>
          <Reveal delay={240}>
            <dl className="mt-10 flex flex-wrap gap-x-10 gap-y-3">
              {t.facts.map((f) => (
                <div key={f.dt} className="flex items-baseline gap-2">
                  <dt className="text-[12.5px] text-muted-foreground">{f.dt}</dt>
                  <dd className="text-[15px] font-semibold tracking-tight text-ink">{f.dd}</dd>
                </div>
              ))}
            </dl>
          </Reveal>
        </div>

        {/* Demo frame — today's signal stream + proposal (static mock) */}
        <Reveal delay={160} className="hidden sm:block">
          <div className="overflow-hidden rounded-2xl border border-border bg-white shadow-sm">
            <div className="flex items-center gap-1.5 border-b border-border px-4 py-2.5">
              <span className="h-2.5 w-2.5 rounded-full bg-ink/15" />
              <span className="h-2.5 w-2.5 rounded-full bg-ink/25" />
              <span className="h-2.5 w-2.5 rounded-full bg-ink/35" />
              <span className="ml-2 text-[11.5px] font-medium text-muted-foreground">{t.frameTitle}</span>
              <span className="ml-auto text-[11.5px] font-medium text-muted-foreground">09:14</span>
            </div>
            <div className="p-5">
              <p className="text-[10.5px] font-bold uppercase tracking-wider text-muted-foreground">
                {t.signalsLabel}
              </p>
              <ul className="mt-3 grid gap-2">
                {t.signals.map((s, i) => (
                  <Reveal as="li" key={s.text} delay={260 + i * 90}>
                    <div className="flex items-center gap-2.5 rounded-lg border border-border bg-secondary/50 px-3 py-2.5">
                      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-ink-soft" />
                      <span className="min-w-0 truncate text-[13px] text-muted-foreground">
                        <b className="font-semibold text-ink">{s.text}</b> · {s.sub}
                      </span>
                      <span className="ml-auto shrink-0 rounded-full bg-white px-2 py-0.5 font-mono text-[10.5px] text-muted-foreground">
                        {s.tag}
                      </span>
                    </div>
                  </Reveal>
                ))}
              </ul>
              <Reveal delay={560}>
                <div className="mt-3 rounded-lg border border-glow/40 bg-accent/50 p-3.5">
                  <p className="text-[10.5px] font-bold uppercase tracking-wider text-ink-soft">{t.proposalLabel}</p>
                  <p className="mt-1 text-[14px] font-semibold text-ink">
                    {t.proposalTitle}
                  </p>
                  <div className="mt-3 flex gap-2">
                    <span className="rounded-full bg-ink px-3.5 py-1.5 text-[12px] font-medium text-white">{t.approve}</span>
                    <span className="rounded-full border border-border bg-white px-3.5 py-1.5 text-[12px] font-medium text-ink">{t.details}</span>
                  </div>
                </div>
              </Reveal>
            </div>
            <div className="flex items-center gap-1.5 border-t border-border px-5 py-3 text-[12px] text-muted-foreground">
              <kbd className="rounded border border-border bg-secondary px-1.5 py-0.5 font-mono text-[10.5px] text-ink-soft">⌘</kbd>
              <kbd className="rounded border border-border bg-secondary px-1.5 py-0.5 font-mono text-[10.5px] text-ink-soft">K</kbd>
              <span>{t.kbdHint}</span>
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
