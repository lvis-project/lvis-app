import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Reveal } from "@/components/motion/reveal";
import { href, type Locale } from "@/lib/i18n";

const copy = {
  ko: {
    heading: "작은 팀에서 시작해, 조직 전체로.",
    lead: "한 팀의 신호로 흐름을 검증하고, Marketplace 카탈로그를 늘려가며 조직 전체로 확장하세요. 메일·캘린더·회의를 한 단계씩 연결해도 충분합니다.",
    ctaDownload: "앱 다운로드",
    ctaGuide: "설치 가이드 ",
  },
  en: {
    heading: "Start with one small team, then scale to the whole org.",
    lead: "Validate the flow with a single team's signals, then grow the Marketplace catalog as you expand across the organization. Connecting mail, calendar, and meetings one step at a time is plenty to start.",
    ctaDownload: "Download the app",
    ctaGuide: "Install guide ",
  },
} as const;

export function Cta({ locale = "ko" }: { locale?: Locale }) {
  const t = copy[locale];
  return (
    <section id="pilot" className="border-t border-border/60 bg-white">
      <div className="mx-auto max-w-[760px] scroll-mt-20 px-6 py-24 text-center">
        <Reveal>
          <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-muted-foreground">Pilot</p>
          <h2 className="mt-2 text-[clamp(1.75rem,3.5vw,2.5rem)] font-semibold tracking-[-0.02em] text-ink">
            {t.heading}
          </h2>
          <p className="mx-auto mt-4 max-w-xl text-[16px] leading-relaxed text-muted-foreground">
            {t.lead}
          </p>
        </Reveal>
        <Reveal delay={100}>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-2.5">
            <Button asChild size="lg" variant="default" className="text-[15px]">
              <Link href={`${locale === "en" ? "/en" : ""}/#download`}>{t.ctaDownload}</Link>
            </Button>
            <Button asChild size="lg" variant="outline" className="text-[15px]">
              <Link href={href(locale, "/docs/getting-started/install")}>{t.ctaGuide}<ArrowRight className="h-4 w-4" /></Link>
            </Button>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
