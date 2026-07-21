import Link from "next/link";
import { ArrowRight, ArrowLeftRight, Bot, Moon, Package, Zap, Plug } from "lucide-react";
import { Reveal } from "@/components/motion/reveal";
import { href, type Locale } from "@/lib/i18n";

const copy = {
  ko: {
    deadline: "7월 31일 종료",
    heading: "정적 통합에서, 자율 협업으로.",
    lead: "플러그인은 단순 도구 호출 모듈에서 커넥터와 자율 서브 에이전트로 진화합니다. 여섯 개의 비전 축을 v1부터 v4까지 단계적으로 펼쳐 갑니다. 일정은 아직 확정하지 않았습니다.",
    axesLabel: "여섯 개 비전 축",
    stationsLabel: "네 분기 타임라인",
    footer: (
      <>
        이 로드맵은 방향성입니다. 자세한 마일스톤, 코드 진입점, 상태는{" "}
      </>
    ),
    footerLink: "로드맵 문서 ",
    footerSuffix: "에서 분기별 회고와 함께 갱신됩니다.",
    axes: [
      {
        icon: ArrowLeftRight,
        num: "01",
        title: "Plugin → Connector + UI",
        body: "도구 호출에서 멈추지 않고, 양방향 스트리밍 UI · 자체 워크스페이스 · 인터랙티브 위젯까지 제공하는 1급 커넥터로 확장합니다.",
      },
      {
        icon: Bot,
        num: "02",
        title: "Plugin = Sub-agent",
        body: "플러그인이 자체 프롬프트 · 도구 세트 · 의사결정 루프를 갖고 자율적으로 행동합니다. 위임 범위는 agentApproval 권한 범위로 격리합니다.",
      },
      {
        icon: Moon,
        num: "03",
        title: "Idle-time Intelligence",
        body: "OS 유휴 상태를 감지해 남는 시간에 인덱싱 · 요약 · 브리핑 준비를 처리합니다. 사용자가 돌아오면 즉시 작업을 양보합니다.",
      },
      {
        icon: Package,
        num: "04",
        title: "Capability Pack",
        body: "현재 나뉘어 있는 네 가지 카탈로그(plugin · agent · MCP · skill)를 하나의 배포 단위로 묶습니다. 사용자는 한 번만 설치하면 됩니다.",
      },
      {
        icon: Zap,
        num: "05",
        title: "Trigger DSL",
        body: "shutdown · schedule 트리거를 이벤트 트리 · 조건 조합 · debounce · 가중치까지 확장합니다. 루틴은 작은 워크플로 엔진이 됩니다.",
      },
      {
        icon: Plug,
        num: "06",
        title: "Hooks — Lifecycle + Interceptor",
        body: "현재 start · stop뿐인 lifecycle을 install · activate · tokenRefresh · pre/postToolCall · onPermissionGranted까지 확장합니다. 외부 코드가 흐름에 안전하게 끼어드는 표준 접점을 마련합니다.",
      },
    ],
    stations: [
      { name: "v1", tag: "기반 다지기", items: ["Connector UI", "Capability Pack v1", "Trigger DSL v2", "Plugin Lifecycle Hook v1"] },
      { name: "v2", tag: "자율로 한 걸음", items: ["Plugin-as-Sub-Agent", "Idle-time Intelligence", "인터랙티브 위젯", "호스트 훅 접점"] },
      { name: "v3", tag: "열리는 호스트", items: ["Local LLM Fallback", "Federation v1", "외부 MCP 자동 분류"] },
      { name: "v4", tag: "다음 단계의 LVIS", items: ["WASM Sandbox", "ROI Dashboard", "Mobile · Raycast · VSCode Companion"] },
    ],
  },
  en: {
    deadline: "Ends July 31",
    heading: "From static integrations to autonomous collaboration.",
    lead: "Plugins evolve from simple tool-calling modules into connectors and autonomous sub-agents. We're rolling out six vision axes across v1 through v4. Timing isn't finalized yet.",
    axesLabel: "Six vision axes",
    stationsLabel: "Four-quarter timeline",
    footer: (
      <>
        This roadmap is directional. Detailed milestones, code entry points, and status are updated with quarterly retrospectives in the{" "}
      </>
    ),
    footerLink: "roadmap docs ",
    footerSuffix: ".",
    axes: [
      {
        icon: ArrowLeftRight,
        num: "01",
        title: "Plugin → Connector + UI",
        body: "We're going beyond tool calls, expanding into first-class connectors that offer bidirectional streaming UI, their own workspace, and interactive widgets.",
      },
      {
        icon: Bot,
        num: "02",
        title: "Plugin = Sub-agent",
        body: "Plugins act autonomously with their own prompts, tool sets, and decision loops. Delegated scope is isolated by the agentApproval permission scope.",
      },
      {
        icon: Moon,
        num: "03",
        title: "Idle-time Intelligence",
        body: "Detects OS idle state to handle indexing, summarizing, and briefing prep in spare time. Yields immediately the moment the user returns.",
      },
      {
        icon: Package,
        num: "04",
        title: "Capability Pack",
        body: "Bundles today's four separate catalogs (plugin · agent · MCP · skill) into a single deployment unit. Users only need to install once.",
      },
      {
        icon: Zap,
        num: "05",
        title: "Trigger DSL",
        body: "Extends shutdown/schedule triggers into event trees, condition combinations, debounce, and weighting. Routines become a small workflow engine.",
      },
      {
        icon: Plug,
        num: "06",
        title: "Hooks — Lifecycle + Interceptor",
        body: "Extends today's start/stop-only lifecycle to install, activate, tokenRefresh, pre/postToolCall, and onPermissionGranted. Establishes a standard point where external code can safely hook into the flow.",
      },
    ],
    stations: [
      { name: "v1", tag: "Laying the foundation", items: ["Connector UI", "Capability Pack v1", "Trigger DSL v2", "Plugin Lifecycle Hook v1"] },
      { name: "v2", tag: "A step toward autonomy", items: ["Plugin-as-Sub-Agent", "Idle-time Intelligence", "Interactive widgets", "Host hook surface"] },
      { name: "v3", tag: "An opening host", items: ["Local LLM Fallback", "Federation v1", "Automatic external MCP classification"] },
      { name: "v4", tag: "The next stage of LVIS", items: ["WASM Sandbox", "ROI Dashboard", "Mobile · Raycast · VSCode Companion"] },
    ],
  },
} as const;

export function Roadmap({ locale = "ko" }: { locale?: Locale }) {
  const t = copy[locale];
  return (
    <section id="roadmap" className="mx-auto max-w-[1120px] scroll-mt-20 px-6 py-24">
      <Reveal>
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-muted-foreground">Roadmap</p>
          <span className="rounded-full border border-border bg-secondary px-2.5 py-0.5 text-[11px] font-semibold text-muted-foreground">
            {t.deadline}
          </span>
        </div>
        <h2 className="mt-2 max-w-2xl text-[clamp(1.75rem,3.5vw,2.5rem)] font-semibold tracking-[-0.02em] text-ink">
          {t.heading}
        </h2>
        <p className="mt-4 max-w-2xl text-[16px] leading-relaxed text-muted-foreground">
          {t.lead}
        </p>
      </Reveal>

      <ol className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3" aria-label={t.axesLabel}>
        {t.axes.map((a, i) => {
          const Icon = a.icon;
          return (
            <Reveal as="li" key={a.num} delay={i * 60}>
              <article className="h-full rounded-2xl border border-border bg-white p-5 transition hover:-translate-y-0.5 hover:border-ink/15 hover:shadow-md">
                <div className="mb-3 flex items-center justify-between">
                  <span className="icon-chip inline-grid h-10 w-10">
                    <Icon className="h-[18px] w-[18px]" />
                  </span>
                  <span className="text-[22px] font-semibold tracking-tight text-ink/20">{a.num}</span>
                </div>
                <h3 className="text-[15.5px] font-semibold text-ink">{a.title}</h3>
                <p className="mt-2 text-[13px] leading-relaxed text-muted-foreground">{a.body}</p>
              </article>
            </Reveal>
          );
        })}
      </ol>

      <div className="mt-10 grid gap-2.5 sm:grid-cols-2 lg:grid-cols-4" aria-label={t.stationsLabel}>
        {t.stations.map((s, i) => (
          <Reveal key={s.name} delay={i * 70}>
            <div className="h-full rounded-2xl border border-border bg-white p-5">
              <div className="flex items-baseline gap-2">
                <span className="grid h-8 min-w-[32px] place-items-center rounded-full bg-secondary px-2 font-mono text-[12.5px] font-bold text-ink">
                  {s.name}
                </span>
                <p className="text-[12px] font-bold uppercase tracking-wider text-muted-foreground">{s.tag}</p>
              </div>
              <ul className="mt-3 grid gap-1.5">
                {s.items.map((it) => (
                  <li key={it} className="flex items-center gap-2 text-[13px] text-ink-soft">
                    <span className="h-1 w-1 shrink-0 rounded-full bg-ink/40" />
                    {it}
                  </li>
                ))}
              </ul>
            </div>
          </Reveal>
        ))}
      </div>

      <Reveal delay={120}>
        <p className="mt-8 text-[13.5px] leading-relaxed text-muted-foreground">
          {t.footer}
          <Link href={href(locale, "/docs/roadmap")} className="inline-flex items-center gap-1 font-semibold text-ink hover:underline">
            {t.footerLink}<ArrowRight className="h-3.5 w-3.5" />
          </Link>
          {t.footerSuffix}
        </p>
      </Reveal>
    </section>
  );
}
