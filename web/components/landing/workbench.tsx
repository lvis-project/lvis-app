import { LayoutGrid, PanelRight, ListTree, MessageSquarePlus, CornerUpLeft, SlidersHorizontal } from "lucide-react";
import { Reveal } from "@/components/motion/reveal";
import type { Locale } from "@/lib/i18n";

interface Card {
  icon: typeof LayoutGrid;
  title: string;
  body: string;
}

const copy = {
  ko: {
    eyebrow: "Workbench",
    heading: "하나의 창 안에서, 여러 대화를 나란히.",
    lead: "작업 모드에서 대화 영역은 최대 네 개의 타일로 나뉩니다. 각 타일은 자기 대화를 갖고, 자기 작업 패널을 갖습니다. 하나를 들여다보는 동안 나머지가 멈추지 않습니다.",
    figureLabel: "네 개로 나뉜 작업 영역",
    tiles: [
      { name: "주간보고 초안", meta: "응답 중", active: true },
      { name: "회의 후속 정리", meta: "대기", active: false },
      { name: "문서 검색", meta: "대기", active: false },
      { name: "메일 답장", meta: "대기", active: false },
    ],
    panelLabel: "작업 패널",
    panelTabs: ["파일", "웹 출처", "서브 에이전트"],
    cards: [
      {
        icon: LayoutGrid,
        title: "좌우로, 또는 위아래로 나누기",
        body: "타일의 분할 메뉴에서 좌우 · 위아래 방향을 고릅니다. 타일은 언제든 닫거나 하나만 크게 볼 수 있고, 한 대화는 한 타일에서만 열립니다.",
      },
      {
        icon: PanelRight,
        title: "타일마다 자기 작업 패널",
        body: "패널은 어떤 폭에서도 같은 카드 모양을 유지하며 타일 높이를 그대로 씁니다. 파일 · 웹 출처 · 서브 에이전트를 탭으로 넘겨 보고, 실행 중인 도구는 실행기에서 바로 드러납니다.",
      },
      {
        icon: ListTree,
        title: "카드는 그 대화가 있는 판에 머뭅니다",
        body: "도구 승인과 질문 카드는 그 대화가 열린 판 안에서 답합니다 — 그 판이 워크보드나 설정을 보여주는 중이어도 그렇습니다. 앱 업데이트 같은 창 전체 알림은 타일 격자 위에 한 번만 놓이고, 창 하단에 카드를 모아 두던 띠는 없어졌습니다.",
      },
      {
        icon: MessageSquarePlus,
        title: "사이드바가 상태를 알려줍니다",
        body: "대화마다 응답 중 표시와 읽지 않은 turn 표시가 붙고, 답을 기다리는 대화에는 노란 점이 붙어 카드가 다른 판에 가려져 있어도 어디가 멈췄는지 보입니다. 목록에는 본 대화와 함께 루틴 실행 · 워크보드 실행이 나타나고, 사이드 챗은 그것을 연 대화 아래에 들여쓰기로 붙습니다.",
      },
      {
        icon: CornerUpLeft,
        title: "보낸 메시지로 되돌아가기",
        body: "내 메시지 카드에는 보낸 시각이 표시되고, ‘여기로 되돌아가기’ 로 그 메시지를 입력창에 되돌린 뒤 이후 내용을 버릴 수 있습니다. 답이 어긋났을 때 처음부터 다시 쓰지 않아도 됩니다.",
      },
      {
        icon: SlidersHorizontal,
        title: "모델은 카드에서 고르고 저장합니다",
        body: "설정의 제공자 카드에서 바로 저장합니다. 주소 입력란은 직접 지정하는 제공자에만 나타나고, 모델 목록은 제공자에서 받아옵니다. OpenAI 는 브라우저 로그인 · 기기 코드 · API 키 중에 고릅니다.",
      },
    ],
    composerNote: "입력창에서 — 보내지 못한 메시지는 그대로 알려주고, 답변이 도는 중에 Enter 는 다음 메시지를 대기열에 넣고 ⌘↩ 는 지금 답변을 끊습니다.",
  },
  en: {
    eyebrow: "Workbench",
    heading: "Several conversations side by side, in one window.",
    lead: "In work mode the conversation area splits into as many as four tiles. Each tile holds its own conversation and its own work panel, so looking closely at one does not stop the others.",
    figureLabel: "A work area split into four tiles",
    tiles: [
      { name: "Weekly report draft", meta: "Responding", active: true },
      { name: "Meeting follow-ups", meta: "Idle", active: false },
      { name: "Document search", meta: "Idle", active: false },
      { name: "Mail reply", meta: "Idle", active: false },
    ],
    panelLabel: "Work panel",
    panelTabs: ["Files", "Web sources", "Sub-agents"],
    cards: [
      {
        icon: LayoutGrid,
        title: "Split left/right, or top/bottom",
        body: "Pick the direction from the tile's split menu. Any tile can be closed or maximized on its own, and a conversation is only ever open in one tile at a time.",
      },
      {
        icon: PanelRight,
        title: "A work panel per tile",
        body: "The panel keeps one card shape at every width and takes the full height of its tile. Files, web sources, and sub-agents sit behind tabs, and the launcher shows which tool is running right now.",
      },
      {
        icon: ListTree,
        title: "Cards stay in the pane their conversation is in",
        body: "Tool approvals and question cards are answered inside their own pane, even while that pane is showing the work board or settings. A window-wide notice such as an app update sits once above the tile grid, and the band that used to collect cards at the bottom of the window is gone.",
      },
      {
        icon: MessageSquarePlus,
        title: "The sidebar tells you where things stand",
        body: "Each conversation carries a responding dot, a mark for turns you have not read, and a yellow dot while it waits on your answer — so you can see what is stalled even when its card sits behind another pane. The list holds routine runs and work board runs alongside your own conversations, and a side chat is indented under the conversation that opened it.",
      },
      {
        icon: CornerUpLeft,
        title: "Return to a message you sent",
        body: "Your own message card shows when you sent it, and “Return here” puts that message back in the composer and discards what came after it. A reply that went the wrong way no longer means retyping from scratch.",
      },
      {
        icon: SlidersHorizontal,
        title: "Choose a model on the card, save it there",
        body: "Provider cards in settings save on the card itself. An endpoint field appears only for providers you point somewhere yourself, and the model list is fetched from the provider. For OpenAI, sign in through the browser, use a device code, or paste an API key.",
      },
    ],
    composerNote: "In the composer — a send that was refused says so, and while a turn is running Enter queues your next message while ⌘↩ interrupts the one in flight.",
  },
} as const;

export function Workbench({ locale = "ko" }: { locale?: Locale }) {
  const t = copy[locale];
  return (
    <section id="workbench" className="mx-auto max-w-[1120px] scroll-mt-20 px-6 py-24">
      <Reveal>
        <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-muted-foreground">{t.eyebrow}</p>
        <h2 className="mt-2 max-w-2xl text-[clamp(1.75rem,3.5vw,2.5rem)] font-semibold tracking-[-0.02em] text-ink">
          {t.heading}
        </h2>
        <p className="mt-4 max-w-2xl text-[16px] leading-relaxed text-muted-foreground">
          {t.lead}
        </p>
      </Reveal>

      {/* Static mock of the tiled work area — a diagram, not a capture. */}
      <Reveal delay={80}>
        <div
          className="mt-10 overflow-hidden rounded-2xl border border-border bg-white p-3 shadow-sm"
          role="figure"
          aria-label={t.figureLabel}
        >
          <div className="grid gap-2 sm:grid-cols-2" aria-hidden>
            {t.tiles.map((tile) => (
              <div
                key={tile.name}
                className={
                  tile.active
                    ? "grid grid-cols-[1fr_92px] gap-2 rounded-xl border border-ink/25 bg-secondary/40 p-2.5"
                    : "grid grid-cols-[1fr_92px] gap-2 rounded-xl border border-border bg-secondary/20 p-2.5"
                }
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5">
                    {tile.active ? <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-ink" /> : null}
                    <p className="truncate text-[12.5px] font-semibold text-ink">{tile.name}</p>
                  </div>
                  <p className="mt-0.5 text-[10.5px] text-muted-foreground">{tile.meta}</p>
                  <div className="mt-2.5 grid gap-1">
                    <span className="h-1.5 w-11/12 rounded-full bg-ink/10" />
                    <span className="h-1.5 w-8/12 rounded-full bg-ink/10" />
                    <span className="h-1.5 w-9/12 rounded-full bg-ink/[0.07]" />
                  </div>
                </div>
                {/* the tile's own work panel — full tile height, one card shape */}
                <div className="rounded-lg border border-border bg-white p-1.5">
                  <p className="truncate text-[9px] font-bold uppercase tracking-wider text-muted-foreground">
                    {t.panelLabel}
                  </p>
                  <div className="mt-1.5 grid gap-1">
                    {t.panelTabs.map((tab) => (
                      <span
                        key={tab}
                        className="truncate rounded bg-secondary/70 px-1.5 py-0.5 text-[9px] font-medium text-muted-foreground"
                      >
                        {tab}
                      </span>
                    ))}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </Reveal>

      <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {(t.cards as readonly Card[]).map((c, i) => {
          const Icon = c.icon;
          return (
            <Reveal key={c.title} delay={i * 60}>
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
        <p className="mt-6 max-w-3xl text-[13.5px] leading-relaxed text-muted-foreground">
          {t.composerNote}
        </p>
      </Reveal>
    </section>
  );
}
