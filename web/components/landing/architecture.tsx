import Link from "next/link";
import { ArrowRight, Mail, Mic, FolderSearch, LayoutDashboard, HandHelping } from "lucide-react";
import { Reveal } from "@/components/motion/reveal";
import { href, type Locale } from "@/lib/i18n";

const pluginChips = [
  { icon: Mail, label: "Microsoft 365" },
  { icon: Mic, label: "Meeting" },
  { icon: FolderSearch, label: "Local Indexer" },
  { icon: LayoutDashboard, label: "Agent Hub" },
  { icon: HandHelping, label: "Work Assistant" },
];

interface Layer {
  tag: string;
  strong: string;
  body: string;
  emphasis?: boolean;
  chips?: boolean;
}

const copy = {
  ko: {
    heading: "맨 위에는 언제나 사용자. 그 아래에서 호스트와 격리된 플러그인이 일합니다.",
    lead: "신호는 아래에서 위로 모이고, 결정은 위에서 아래로 흐릅니다. 모든 계층은 명시적인 권한 경계로 분리됩니다.",
    figureLabel: "LVIS 아키텍처 계층",
    layers: [
      {
        tag: "User",
        strong: "결정 · 승인 · 키보드 입력",
        body: "고위험 도구는 사유 입력과 명시적 승인이 있어야만 통과합니다.",
        emphasis: true,
      },
      {
        tag: "LVIS Core",
        strong: "호스트 · 승인 게이트 · 도구 런타임 · 감사",
        body: "모든 도구 호출은 정책 평가 + 권한 체크 + 감사 로그를 거칩니다.",
      },
      {
        tag: "Plugins",
        strong: "독립 런타임 · Host API만 접근",
        body: "플러그인은 서로의 데이터에 직접 접근하지 못하고, 권한이 명시된 Host API만 호출합니다.",
        chips: true,
      },
      {
        tag: "Signals",
        strong: "외부 신호 · 로컬 문서 · 사내 API",
        body: "메일 · 캘린더 · Teams · 회의 녹음 · 로컬 폴더 · LDAP · 사내 시설 API.",
      },
    ],
    flow: "↑ 결정 · 승인 흐름  ·  ↓ 신호 · 데이터 흐름",
    docsLink: "아키텍처 문서 보기 ",
  },
  en: {
    heading: "The user is always on top. Below, the host and isolated plugins do the work.",
    lead: "Signals flow up from the bottom, and decisions flow down from the top. Every layer is separated by an explicit permission boundary.",
    figureLabel: "LVIS architecture layers",
    layers: [
      {
        tag: "User",
        strong: "Decision · approval · keyboard input",
        body: "High-risk tools pass only with a stated reason and explicit approval.",
        emphasis: true,
      },
      {
        tag: "LVIS Core",
        strong: "Host · approval gate · tool runtime · audit",
        body: "Every tool call goes through policy evaluation, a permission check, and an audit log.",
      },
      {
        tag: "Plugins",
        strong: "Isolated runtimes · Host API access only",
        body: "Plugins can't touch each other's data directly — they only call the Host API with explicitly granted permissions.",
        chips: true,
      },
      {
        tag: "Signals",
        strong: "External signals · local documents · internal APIs",
        body: "Mail · calendar · Teams · meeting recordings · local folders · LDAP · internal facility APIs.",
      },
    ],
    flow: "↑ Decision · approval flow  ·  ↓ Signal · data flow",
    docsLink: "Read the architecture docs ",
  },
} as const;

export function Architecture({ locale = "ko" }: { locale?: Locale }) {
  const t = copy[locale];
  return (
    <section id="architecture" className="mx-auto max-w-[1120px] scroll-mt-20 px-6 py-24">
      <Reveal>
        <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-muted-foreground">Architecture</p>
        <h2 className="mt-2 max-w-3xl text-[clamp(1.75rem,3.5vw,2.5rem)] font-semibold leading-[1.15] tracking-[-0.02em] text-ink">
          {t.heading}
        </h2>
        <p className="mt-4 max-w-2xl text-[16px] leading-relaxed text-muted-foreground">
          {t.lead}
        </p>
      </Reveal>

      <div className="mt-10 grid gap-2.5" role="figure" aria-label={t.figureLabel}>
        {(t.layers as readonly Layer[]).map((l, i) => (
          <Reveal key={l.tag} delay={i * 70}>
            <div
              className={
                l.emphasis
                  ? "grid gap-3 rounded-2xl border border-ink/20 bg-ink p-5 text-white sm:grid-cols-[120px_1fr]"
                  : "grid gap-3 rounded-2xl border border-border bg-white p-5 sm:grid-cols-[120px_1fr]"
              }
            >
              <span
                className={
                  l.emphasis
                    ? "text-[11px] font-bold uppercase tracking-wider text-white/60"
                    : "text-[11px] font-bold uppercase tracking-wider text-muted-foreground"
                }
              >
                {l.tag}
              </span>
              <div>
                <p className={l.emphasis ? "text-[15px] font-semibold" : "text-[15px] font-semibold text-ink"}>
                  {l.strong}
                </p>
                <p
                  className={
                    l.emphasis
                      ? "mt-1 text-[13px] leading-relaxed text-white/70"
                      : "mt-1 text-[13px] leading-relaxed text-muted-foreground"
                  }
                >
                  {l.body}
                </p>
                {l.chips ? (
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    {pluginChips.map((c) => {
                      const Icon = c.icon;
                      return (
                        <span
                          key={c.label}
                          className="inline-flex items-center gap-1.5 rounded-full border border-border bg-secondary/60 px-2.5 py-1 text-[12px] font-medium text-ink-soft"
                        >
                          <Icon className="h-3.5 w-3.5" />
                          {c.label}
                        </span>
                      );
                    })}
                  </div>
                ) : null}
              </div>
            </div>
          </Reveal>
        ))}
      </div>

      <Reveal delay={140}>
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-[12.5px] text-muted-foreground">
          <span>{t.flow}</span>
          <Link
            href={href(locale, "/docs/architecture/overview")}
            className="inline-flex items-center gap-1 font-semibold text-ink hover:underline"
          >
            {t.docsLink}<ArrowRight className="h-3.5 w-3.5" />
          </Link>
        </div>
      </Reveal>
    </section>
  );
}
