"use client";
import * as React from "react";
import Link from "next/link";
import { ArrowRight, Download } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Reveal } from "@/components/motion/reveal";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { CopyButton } from "./copy-button";
import { useOS } from "./use-os";
import { ALL_RELEASES_URL, getDownloads, KNOWN_AVAILABLE, type OS } from "@/lib/downloads";
import { href, type Locale } from "@/lib/i18n";

const copy = {
  ko: {
    heading: "사용 중인 OS에 맞게.",
    leadPre: "macOS·Windows·Linux 빌드를 GitHub Releases에서 직접 받습니다. 버튼은 언제나 최신 빌드를 가리킵니다.",
    allReleases: "모든 릴리스 보기 ",
    recommended: "권장",
    download: "다운로드",
    viewReleases: "릴리스 보기",
    ready: "최신 빌드 · 다운로드 가능",
    notReady: "준비 중",
    installGuide: "설치 가이드",
    firstRun: "설치 후 첫 실행",
    installPre: "설치 이후 로그인과 첫 화면은",
    installPost: "에서 이어집니다.",
  },
  en: {
    heading: "Pick the build for your OS.",
    leadPre: "Grab the macOS, Windows, or Linux build straight from GitHub Releases. The button always points at the latest build.",
    allReleases: "See all releases ",
    recommended: "Recommended",
    download: "Download",
    viewReleases: "View releases",
    ready: "Latest build · available",
    notReady: "Coming soon",
    installGuide: "install guide",
    firstRun: "First launch after install",
    installPre: "Login and the first screen after install continue in the",
    installPost: ".",
  },
} as const;

/**
 * OS picker tabs: auto-selects the visitor's platform, one platform at a time —
 * the long per-OS setup instructions get a full-width vertical layout instead
 * of three cramped columns.
 */
export function Downloads({ locale = "ko" }: { locale?: Locale }) {
  const t = copy[locale];
  const downloads = getDownloads(locale);
  const os = useOS();
  const [tab, setTab] = React.useState<OS>("windows");
  const [touched, setTouched] = React.useState(false);

  // Follow detection until the user explicitly picks a tab.
  React.useEffect(() => {
    if (os && !touched) setTab(os);
  }, [os, touched]);

  return (
    <section id="download" className="scroll-mt-20 border-y border-border/60">
      <div className="mx-auto max-w-[1120px] px-6 py-24">
        <Reveal>
          <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-muted-foreground">Desktop App</p>
          <h2 className="mt-2 text-[clamp(1.75rem,3.5vw,2.5rem)] font-semibold tracking-[-0.02em] text-ink">
            {t.heading}
          </h2>
          <p className="mt-4 max-w-xl text-[16px] leading-relaxed text-muted-foreground">
            {t.leadPre}{" "}
            <a
              href={ALL_RELEASES_URL}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-0.5 font-semibold text-ink hover:underline"
            >
              {t.allReleases}<ArrowRight className="h-3 w-3" />
            </a>
          </p>
        </Reveal>

        <Reveal delay={80}>
          <Tabs
            value={tab}
            onValueChange={(v) => {
              setTouched(true);
              setTab(v as OS);
            }}
            className="mt-10"
          >
            <TabsList className="h-auto rounded-full border border-border bg-white p-1">
              {downloads.map((d) => (
                <TabsTrigger
                  key={d.os}
                  value={d.os}
                  className="gap-1.5 rounded-full px-4 py-1.5 text-[13.5px] data-[state=active]:bg-ink data-[state=active]:text-white"
                >
                  {d.osLabel}
                  {os === d.os ? (
                    <span className="rounded-full bg-secondary px-1.5 py-px text-[10px] font-bold text-ink-soft data-[state=active]:bg-white/20">
                      {t.recommended}
                    </span>
                  ) : null}
                </TabsTrigger>
              ))}
            </TabsList>

            {downloads.map((d) => {
              const ready = KNOWN_AVAILABLE[d.os];
              return (
                <TabsContent key={d.os} value={d.os} className="mt-6">
                  <div className="grid gap-4 lg:grid-cols-[320px_1fr]">
                    {/* Download CTA */}
                    <div className="flex flex-col rounded-2xl border border-border bg-white p-6">
                      <p className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">{d.osLabel}</p>
                      <p className="mt-1.5 text-[22px] font-semibold tracking-[-0.01em] text-ink">{d.title}</p>
                      <p className="mt-1 font-mono text-[12px] text-muted-foreground">{d.format}</p>
                      <div className="mt-5">
                        <Button asChild size="lg" variant="default" className="w-full text-[15px]">
                          <a href={ready ? d.href : ALL_RELEASES_URL}>
                            <Download className="h-4 w-4" />
                            {ready ? t.download : t.viewReleases}
                          </a>
                        </Button>
                      </div>
                      <span
                        className={cn(
                          "mt-3 inline-flex w-fit rounded-full px-2.5 py-0.5 text-[11px] font-semibold",
                          ready ? "bg-secondary text-muted-foreground" : "bg-amber-50 text-amber-700"
                        )}
                      >
                        {ready ? t.ready : t.notReady}
                      </span>
                      <p className="mt-auto pt-5 text-[12px] leading-relaxed text-muted-foreground">
                        {t.installPre}{" "}
                        <Link href={href(locale, "/docs/getting-started/install")} className="font-semibold text-ink hover:underline">
                          {t.installGuide}
                        </Link>
                        {t.installPost}
                      </p>
                    </div>

                    {/* Setup steps — full width, vertical */}
                    <div className="rounded-2xl border border-border bg-white p-6">
                      <p className="text-[13px] font-bold text-ink">{t.firstRun}</p>
                      <p className="mt-1.5 max-w-2xl text-[13.5px] leading-relaxed text-muted-foreground">{d.setupNote}</p>
                      <ol className="mt-5 grid gap-4">
                        {d.steps.map((s, idx) => (
                          <li key={idx} className="grid grid-cols-[28px_1fr] gap-3">
                            <span className="grid h-7 w-7 place-items-center rounded-full bg-secondary font-mono text-[11.5px] font-bold text-ink-soft">
                              {idx + 1}
                            </span>
                            <div className="min-w-0">
                              <p className="pt-0.5 text-[13.5px] leading-relaxed text-ink-soft">{s.label}</p>
                              {s.command ? (
                                <div className="mt-2 flex items-center gap-2 rounded-lg border border-border bg-secondary/50 px-3 py-2">
                                  <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap font-mono text-[12.5px] text-ink">
                                    {s.command}
                                  </code>
                                  <CopyButton text={s.command} locale={locale} />
                                </div>
                              ) : null}
                            </div>
                          </li>
                        ))}
                      </ol>
                      {d.extraNote ? (
                        <p className="mt-5 border-t border-border pt-3 text-[12.5px] leading-relaxed text-muted-foreground">
                          {d.extraNote}
                        </p>
                      ) : null}
                    </div>
                  </div>
                </TabsContent>
              );
            })}
          </Tabs>
        </Reveal>
      </div>
    </section>
  );
}
