import { Monitor, HardDrive, Puzzle, ShieldCheck } from "lucide-react";
import { Reveal } from "@/components/motion/reveal";
import type { Locale } from "@/lib/i18n";

const copy = {
  ko: {
    heading: "당신의 PC에서 일하는 업무 비서.",
    lead: "LVIS는 데스크톱에서 동작하는 업무 AI 호스트입니다. 신호를 읽는 곳도, 제안을 만드는 곳도, 결과를 실행하는 과정까지 모두 디바이스 안에서 일어납니다. 클라우드가 아니라 당신의 PC가 무대입니다.",
    cards: [
      {
        icon: Monitor,
        title: "네이티브 데스크톱 호스트",
        body: "Electron 기반 앱이 메일·일정·회의·문서·사내 API의 신호를 한 곳에 모읍니다. macOS·Windows·Linux 지원.",
      },
      {
        icon: HardDrive,
        title: "로컬 우선 · 온디바이스",
        body: "로컬 인덱서가 PC 안 문서를 디바이스에서 색인합니다. 문서 본문은 외부로 나가지 않고, 신호는 먼저 읽기 전용으로 분류됩니다.",
      },
      {
        icon: Puzzle,
        title: "플러그인 아키텍처",
        body: "독립 런타임으로 격리된 플러그인을 필요한 만큼만 추가합니다. 어떤 기능도 강제되지 않고, 검증 후 교체가 쉽습니다.",
      },
      {
        icon: ShieldCheck,
        title: "승인 중심의 실행",
        body: "관찰과 제안은 조용히 이루어지고, 쓰기 작업은 위험도가 표시된 승인 게이트를 통과합니다. 실행은 항상 사용자의 결정으로 시작됩니다.",
      },
    ],
    meta: [
      { dt: "지원 빌드", dd: "macOS · Windows · Linux" },
      { dt: "기본 다운로드", dd: "Windows 10+ · x64" },
      { dt: "실행 정책", dd: "승인 후 실행 (고위험 작업은 사유 필수)" },
      { dt: "데이터 경계", dd: "로컬 인덱싱 · 본문 비공개" },
    ],
  },
  en: {
    heading: "A work assistant that runs on your own PC.",
    lead: "LVIS is a desktop AI work host. Reading signals, drafting proposals, and carrying out results all happen on your device. Your PC is the stage — not the cloud.",
    cards: [
      {
        icon: Monitor,
        title: "Native desktop host",
        body: "An Electron-based app brings signals from mail, calendar, meetings, documents, and internal APIs into one place. Available for macOS, Windows, and Linux.",
      },
      {
        icon: HardDrive,
        title: "Local-first · on-device",
        body: "The local indexer indexes documents on your PC right on the device. Document contents never leave your machine, and signals are first classified read-only.",
      },
      {
        icon: Puzzle,
        title: "Plugin architecture",
        body: "Add only the plugins you need, each isolated in its own runtime. Nothing is forced on you, and swapping one out after review is easy.",
      },
      {
        icon: ShieldCheck,
        title: "Approval-first execution",
        body: "Observation and suggestions happen quietly, while write actions pass through a risk-labeled approval gate. Execution always begins with your decision.",
      },
    ],
    meta: [
      { dt: "Supported builds", dd: "macOS · Windows · Linux" },
      { dt: "Default download", dd: "Windows 10+ · x64" },
      { dt: "Run policy", dd: "Approve, then run (high-risk actions require a reason)" },
      { dt: "Data boundary", dd: "Local indexing · contents kept private" },
    ],
  },
} as const;

export function About({ locale = "ko" }: { locale?: Locale }) {
  const t = copy[locale];
  return (
    <section id="about" className="mx-auto max-w-[1120px] scroll-mt-20 px-6 py-24">
      <Reveal>
        <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-muted-foreground">The App</p>
        <h2 className="mt-2 max-w-2xl text-[clamp(1.75rem,3.5vw,2.5rem)] font-semibold tracking-[-0.02em] text-ink">
          {t.heading}
        </h2>
        <p className="mt-4 max-w-2xl text-[16px] leading-relaxed text-muted-foreground">
          {t.lead}
        </p>
      </Reveal>
      <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {t.cards.map((c, i) => {
          const Icon = c.icon;
          return (
            <Reveal key={c.title} delay={i * 70}>
              <article className="h-full rounded-2xl border border-border bg-white p-5 transition hover:-translate-y-0.5 hover:border-ink/15 hover:shadow-md">
                <span className="icon-chip mb-4 inline-grid h-10 w-10">
                  <Icon className="h-[18px] w-[18px]" />
                </span>
                <h3 className="text-[15.5px] font-semibold text-ink">{c.title}</h3>
                <p className="mt-2 text-[13.5px] leading-relaxed text-muted-foreground">{c.body}</p>
              </article>
            </Reveal>
          );
        })}
      </div>
      <Reveal delay={120}>
        <dl className="mt-8 grid gap-x-8 gap-y-3 rounded-2xl border border-border bg-white p-5 sm:grid-cols-2 lg:grid-cols-4">
          {t.meta.map((m) => (
            <div key={m.dt}>
              <dt className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">{m.dt}</dt>
              <dd className="mt-1 text-[13.5px] font-semibold text-ink">{m.dd}</dd>
            </div>
          ))}
        </dl>
      </Reveal>
    </section>
  );
}
