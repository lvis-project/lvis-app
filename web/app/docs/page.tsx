import Link from "next/link";
import {
  ArrowRight, Plug, Bot, MessagesSquare, Server, Workflow, ShieldCheck,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { HeroBackdrop } from "@/components/motion/hero-backdrop";
import { Reveal } from "@/components/motion/reveal";

const stats = [
  { value: "41", label: "정적 라우트" },
  { value: "61", label: "제품 스크린샷" },
  { value: "11", label: "repo 사실 검증" },
];

const layers = [
  { tag: "Desktop Host", label: "LVIS App", note: "ChatView · MainToolbar · MessageQueuePanel · SessionTodoPanel" },
  { tag: "Plugin Runtime", label: "6 plugins", note: "ms-graph · local-indexer · meeting · work-assistant · agent-hub · lge-api" },
  { tag: "Storage", label: "~/.lvis", note: "0o700 dir · 0o600 file · audit/<YYYY-MM-DD>.jsonl" },
  { tag: "Servers", label: "Marketplace · Agent Hub", note: "FastAPI · React 19 · Ed25519 · HTTPBearer + ApiKey sha256" },
];

const features = [
  { eyebrow: "Host · Chat", title: "데스크톱 채팅 가이드", desc: "메시지 큐, Tool/Thinking, 질문 카드, 권한 흐름까지 호스트 앱 핵심 화면 8가지를 한 흐름으로.", href: "/docs/chat/layout", icon: MessagesSquare, span: "lg:col-span-4" },
  { eyebrow: "Routines", title: "루틴 등록 & 트리거", desc: "shutdown / schedule 두 트리거 + per-fire fresh ConversationLoop 격리 패턴.", href: "/docs/routines/overview", icon: Workflow, span: "lg:col-span-2" },
  { eyebrow: "Plugins", title: "6개 active 플러그인", desc: "Local Indexer · MS-Graph · Meeting · Work Assistant · Agent Hub · LGE EP.", href: "/docs/plugins", icon: Plug, span: "lg:col-span-3" },
  { eyebrow: "Architecture", title: "시스템 구조도", desc: "HostApi 컨트랙트 · ~/.lvis 스토리지 트리 · RiskLevel × Category 격자.", href: "/docs/architecture/overview", icon: Bot, span: "lg:col-span-3" },
  { eyebrow: "Trust", title: "권한 & 위험 관리", desc: "디렉토리 grant · LLM 자율 검토 4모드 · agentApproval cryptographic chain.", href: "/docs/chat/permissions/directory", icon: ShieldCheck, span: "lg:col-span-2" },
  { eyebrow: "Servers", title: "Marketplace & Agent Hub", desc: "FastAPI + SQLAlchemy 2.0 카탈로그 · 보드 · 워크로그 · Ed25519 패키지 서명.", href: "/docs/servers/marketplace", icon: Server, span: "lg:col-span-4" },
];

const tour = [
  { step: "01", time: "5분", title: "설치 → 로그인", desc: "OS 빌드 설치 후 첫 실행. Marketplace SSO + ApiKey sha256." },
  { step: "02", time: "10분", title: "플러그인 권한 허용", desc: "capabilities 12종 + tools[] + pluginAccess 통합 다이얼로그." },
  { step: "03", time: "15분", title: "루틴 + 첫 카드", desc: "schedule 트리거 등록, work-assistant proactive 카드 받아보기." },
];

export default function HomePage() {
  return (
    <>
      {/* ───────────────────────── Hero ───────────────────────── */}
      <section className="relative isolate overflow-hidden">
        <HeroBackdrop />
        <div className="mx-auto w-full max-w-[1000px] px-6 py-20 text-center sm:py-24">
          <Reveal>
            <p className="mb-6 inline-flex items-center gap-2 rounded-full border border-border bg-white/60 px-3.5 py-1.5 text-[11px] font-bold uppercase tracking-[0.18em] text-ink-soft backdrop-blur">
              <span className="h-1.5 w-1.5 rounded-full bg-ink" />
              LVIS AI Docs · v1
            </p>
          </Reveal>
          <Reveal delay={60}>
            <h1 className="mx-auto max-w-4xl text-[clamp(2.25rem,5vw,3.5rem)] font-semibold leading-[1.06] tracking-[-0.025em] text-ink">
              앱·플러그인·에이전트 허브가
              <br />
              함께 움직이는 <span className="text-ink-soft">업무 AI</span>
            </h1>
          </Reveal>
          <Reveal delay={120}>
            <p className="mx-auto mt-6 max-w-xl text-[17px] leading-relaxed text-muted-foreground">
              로그인부터 채팅 · 권한 · 루틴 · 7개 도메인 플러그인 · 두 서버까지 —
              실제 소스에서 검증된 시그니처와 파일·라인 인용 기반의 통합 사용자 가이드.
            </p>
          </Reveal>
          <Reveal delay={180}>
            <div className="mt-9 flex flex-wrap items-center justify-center gap-2.5">
              <Button asChild size="lg" variant="default" className="text-[15px]">
                <Link href="/docs/getting-started/install">처음 시작하기 <ArrowRight className="h-4 w-4" /></Link>
              </Button>
              <Button asChild size="lg" variant="outline" className="text-[15px]">
                <Link href="/docs/plugins">플러그인 6종 둘러보기</Link>
              </Button>
            </div>
          </Reveal>

          <Reveal delay={240}>
            <div className="mt-12 flex flex-wrap items-center justify-center gap-x-10 gap-y-3">
              {stats.map((s) => (
                <div key={s.label} className="flex items-baseline gap-2">
                  <span className="text-[22px] font-semibold tracking-tight text-ink">{s.value}</span>
                  <span className="text-[13px] text-muted-foreground">{s.label}</span>
                </div>
              ))}
            </div>
          </Reveal>
        </div>
      </section>

      {/* ───────────────────────── Platform map ───────────────────────── */}
      <section className="mx-auto max-w-[1120px] px-6 py-24">
        <Reveal>
          <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-muted-foreground">Platform Map</p>
          <h2 className="mt-2 max-w-2xl text-[clamp(1.75rem,3.5vw,2.5rem)] font-semibold tracking-[-0.02em] text-ink">
            네 개의 레이어 — 같은 사용자 신호 위에서
          </h2>
        </Reveal>
        <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {layers.map((l, i) => (
            <Reveal key={l.tag} delay={i * 70}>
              <div className="group h-full rounded-2xl border border-border bg-white p-5 transition hover:-translate-y-1 hover:border-ink/15 hover:shadow-md">
                <div className="mb-4 flex h-8 w-8 items-center justify-center rounded-lg bg-secondary text-[13px] font-bold text-ink-soft">
                  {i + 1}
                </div>
                <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">{l.tag}</p>
                <p className="mt-1 text-[16px] font-semibold text-ink">{l.label}</p>
                <p className="mt-2 text-[12.5px] leading-relaxed text-muted-foreground">{l.note}</p>
              </div>
            </Reveal>
          ))}
        </div>
      </section>

      {/* ───────────────────────── Bento — read in any order ───────────────────────── */}
      <section className="mx-auto max-w-[1120px] px-6 pb-24">
        <Reveal>
          <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-muted-foreground">Read in any order</p>
          <h2 className="mt-2 max-w-2xl text-[clamp(1.75rem,3.5vw,2.5rem)] font-semibold tracking-[-0.02em] text-ink">
            관심 있는 영역부터 골라 들어가세요
          </h2>
        </Reveal>
        <div className="mt-10 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-6">
          {features.map((f, i) => {
            const Icon = f.icon;
            return (
              <Reveal key={f.href} delay={i * 60} className={f.span}>
                <Link
                  href={f.href}
                  className="group flex h-full flex-col overflow-hidden rounded-2xl border border-border bg-white p-6 transition hover:-translate-y-1 hover:border-ink/15 hover:shadow-md"
                >
                  <div className="mb-4 flex items-center gap-3">
                    <span className="icon-chip h-10 w-10">
                      <Icon className="h-[18px] w-[18px]" />
                    </span>
                    <span className="text-[10.5px] font-bold uppercase tracking-wider text-muted-foreground">
                      {f.eyebrow}
                    </span>
                  </div>
                  <p className="text-[17px] font-semibold tracking-[-0.01em] text-ink">{f.title}</p>
                  <p className="mt-2 flex-1 text-[13.5px] leading-relaxed text-muted-foreground">{f.desc}</p>
                  <span className="mt-4 inline-flex items-center gap-1 text-[12.5px] font-semibold text-ink transition-all group-hover:gap-2">
                    바로 가기 <ArrowRight className="h-3.5 w-3.5" />
                  </span>
                </Link>
              </Reveal>
            );
          })}
        </div>
      </section>

      {/* ───────────────────────── Quick tour ───────────────────────── */}
      <section className="mx-auto max-w-[1120px] px-6 pb-28">
        <Reveal>
          <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-muted-foreground">Quick Tour</p>
          <h2 className="mt-2 max-w-2xl text-[clamp(1.75rem,3.5vw,2.5rem)] font-semibold tracking-[-0.02em] text-ink">
            처음 30분 동안 이렇게 흘러갑니다
          </h2>
        </Reveal>
        <div className="mt-10 grid gap-4 lg:grid-cols-3">
          {tour.map((t, i) => (
            <Reveal key={t.step} delay={i * 80}>
              <div className="relative h-full rounded-2xl border border-border bg-white p-6 transition hover:-translate-y-1 hover:shadow-md">
                <div className="flex items-baseline justify-between">
                  <span className="text-[28px] font-semibold tracking-tight text-ink/25">{t.step}</span>
                  <span className="rounded-full bg-secondary px-2.5 py-0.5 text-[11px] font-semibold text-muted-foreground">{t.time}</span>
                </div>
                <p className="mt-4 text-[16px] font-semibold text-ink">{t.title}</p>
                <p className="mt-2 text-[13px] leading-relaxed text-muted-foreground">{t.desc}</p>
              </div>
            </Reveal>
          ))}
        </div>
        <Reveal delay={120}>
          <div className="mt-10 flex justify-center">
            <Button asChild size="lg" variant="default" className="text-[15px]">
              <Link href="/docs/getting-started/install">설치 가이드로 시작 <ArrowRight className="h-4 w-4" /></Link>
            </Button>
          </div>
        </Reveal>
      </section>
    </>
  );
}
