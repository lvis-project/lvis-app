/**
 * PluginShowcase (Z onboarding chain step 6) — installed-plugin tour.
 *
 * Mounted right after `SpotlightTour` completes (`tourCompleted=true`).
 * Surfaces a short carded explanation of every installed plugin so the
 * user understands what each plugin *does* before being dropped into
 * an empty chat surface. 2026-05-20 redesign — each card now has a
 * "펼쳐보기 ↓" toggle that *inline-expands* a short list of the plugin's
 * onboarding scenarios. The previous "둘러보기" button dispatched
 * `api.tour.start` (external navigation) and visibly retriggered the
 * SpotlightTour on top of the showcase — the new inline expansion path
 * removes that double-tour artefact.
 *
 * A separate "끝내기 →" footer button closes the entire showcase and
 * marks onboarding complete.
 *
 * Catalog model:
 *   - The component receives the installed-plugin id list as a prop and
 *     filters the static `PLUGIN_DESCRIPTIONS` table to the intersection.
 *     Plugins without an entry render a generic fallback card so the
 *     user is never shown an empty surface even on a non-standard install.
 *   - The static descriptions are intentionally short (1 sentence each)
 *     to fit the 460×840 narrow window without scroll-shenanigans.
 *
 * The component is presentational only — install/uninstall lifecycle is
 * not its concern; it just reflects the host's current pluginCards list.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "../../../components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../../../components/ui/dialog.js";

export interface PluginShowcaseApi {
  tour: {
    start: (scenarioId: string) => Promise<unknown> | unknown;
  };
}

export interface PluginShowcaseProps {
  open: boolean;
  /**
   * Installed plugin id list — typically `pluginCards.map(c => c.id)`
   * from App.tsx. Used to filter the static description catalog so the
   * showcase only mentions plugins the user actually has.
   */
  installedPluginIds: readonly string[];
  api: PluginShowcaseApi;
  /** Called when the user closes the showcase (끝내기 / skip / close). */
  onClose: () => void;
  /**
   * ScenarioShowcase carry (Option A) — when set, the matching plugin
   * is hoisted to the top of the showcase list so the user lands on
   * the same scenario they picked at the start of the chain. `null`
   * preserves the catalog order.
   *
   * Scenario id → plugin id map:
   *   meeting       → meeting
   *   docs          → local-indexer
   *   work          → work-proactive
   *   multi-agent   → agent-hub
   */
  prioritizedScenarioId?: string | null;
}

/**
 * ScenarioShowcase id → PluginShowcase plugin id. Pure for unit
 * testability. Unknown ids → null (caller treats as no-op).
 */
export function scenarioToPluginId(
  scenarioId: string | null | undefined,
): string | null {
  switch (scenarioId) {
    case "meeting":
      return "meeting";
    case "docs":
      return "local-indexer";
    case "work":
      return "work-proactive";
    case "multi-agent":
      return "agent-hub";
    default:
      return null;
  }
}

interface PluginDescription {
  /** Plugin id as it appears in pluginCards / manifests. */
  id: string;
  emoji: string;
  /** Korean display name (short, ≤ 12 chars). */
  label: string;
  /** One-sentence Korean description (~80 chars). */
  body: string;
  /** Spotlight tour id for the per-plugin walkthrough. */
  tourScenarioId: string;
  /**
   * Short list of onboarding scenarios the plugin can run. Rendered inline
   * inside the card when the user clicks "펼쳐보기 ↓". Each entry is a
   * 1-line Korean phrase describing a concrete first task the plugin
   * supports — surfaces the plugin's value without an external navigation.
   */
  scenarios: readonly string[];
}

/**
 * Static catalog — keyed by the canonical plugin id (NOT the marketplace
 * slug; the runtime PluginCard.id uses the bare manifest id).
 * Order is the intended introduction order: meeting → docs → work →
 * multi-agent → others. New plugins land at the bottom until a designer
 * decides where to slot them.
 */
const PLUGIN_DESCRIPTIONS: readonly PluginDescription[] = [
  {
    id: "meeting",
    emoji: "🎙️",
    label: "회의 자동 요약",
    body: "회의 녹음 → 자동 STT → 요약과 액션 아이템 추출까지 한 번에 처리합니다.",
    tourScenarioId: "meeting-walkthrough",
    scenarios: [
      "회의 녹음을 시작하고 실시간 STT 로 텍스트화",
      "회의 종료 후 자동 요약과 핵심 결정사항 정리",
      "추출된 액션 아이템을 LVIS 할 일로 등록",
      "지난 회의 검색 — '지난주 PM 회의 요약 보여줘'",
    ],
  },
  {
    id: "local-indexer",
    emoji: "📚",
    label: "로컬 문서 검색",
    body: "PDF·Word·마크다운을 로컬에서 인덱싱하고 자연어로 답합니다. 문서는 외부로 나가지 않습니다.",
    tourScenarioId: "indexer-walkthrough",
    scenarios: [
      "폴더를 추가하면 PDF / Word / 마크다운 자동 인덱싱",
      "자연어 검색 — '지난 분기 보안 정책 요약'",
      "검색 결과에 원문 출처 표시 (페이지 / 섹션)",
      "민감 정보 PII 자동 마스킹 후 인덱싱",
    ],
  },
  {
    id: "work-proactive",
    emoji: "💼",
    label: "업무 도우미",
    body: "이메일·일정에서 액션 아이템 후보를 추출해 적절한 시점에 카드로 알려줍니다.",
    tourScenarioId: "work-assistant-walkthrough",
    scenarios: [
      "받은편지함 자동 스캔 → 액션 아이템 후보 추출",
      "오버레이 카드로 후보 검토 → 한 번에 승인/무시",
      "발신자·키워드별 우선순위 규칙 설정",
      "캘린더와 연결 — 미팅 1시간 전 사전 브리핑",
    ],
  },
  {
    id: "agent-hub",
    emoji: "🤖",
    label: "Multi-agent",
    body: "여러 에이전트가 작업을 분산해 처리하고 결과를 다시 합성합니다.",
    tourScenarioId: "multi-agent-tour",
    scenarios: [
      "리서치 / 분석을 여러 에이전트에게 동시 dispatch",
      "에이전트별 LLM·도구 권한 분리 설정",
      "토큰 / 비용 실시간 추적 + 한도 관리",
      "결과를 자동 합성 → 단일 보고서로 정리",
    ],
  },
  {
    id: "ms-graph",
    emoji: "📅",
    label: "MS Graph 연동",
    body: "Microsoft 365 의 이메일·캘린더와 연결해 LVIS 가 일정과 메일을 활용하도록 합니다.",
    tourScenarioId: "first-boot-essentials",
    scenarios: [
      "Microsoft 365 계정 OAuth 연결",
      "Outlook 받은편지함 → LVIS 컨텍스트로 활용",
      "캘린더 이벤트 기반 자동 브리핑",
    ],
  },
  {
    id: "lge-api",
    emoji: "🏢",
    label: "사내 API 연동",
    body: "사내 내부 시스템과 연동해 조직 데이터·도구를 LVIS 에서 함께 사용합니다.",
    tourScenarioId: "first-boot-essentials",
    scenarios: [
      "사내 SSO 로 내부 API 연결",
      "조직 데이터 검색 (사번 / 부서 / 프로젝트)",
      "사내 도구를 LVIS 에서 직접 호출",
    ],
  },
];

const PLUGIN_DESCRIPTION_BY_ID = new Map<string, PluginDescription>(
  PLUGIN_DESCRIPTIONS.map((entry) => [entry.id, entry] as const),
);

/**
 * Resolve the ordered list of cards to render. Installed plugins matching
 * the catalog come first (in catalog order); unknown installed plugins
 * append a generic fallback card so the user always sees something for
 * each installed plugin.
 *
 * When `prioritizedPluginId` is set the matching card is hoisted to the
 * top so a Showcase Option A user lands on the plugin they picked
 * earlier in the chain.
 *
 * Pure for unit-testability — caller passes the raw id list + optional
 * priority plugin id.
 */
export function resolveShowcaseCards(
  installedPluginIds: readonly string[],
  prioritizedPluginId: string | null = null,
): readonly PluginDescription[] {
  const installed = new Set(installedPluginIds);
  const known: PluginDescription[] = [];
  for (const entry of PLUGIN_DESCRIPTIONS) {
    if (installed.has(entry.id)) known.push(entry);
  }
  const unknown: PluginDescription[] = [];
  for (const id of installedPluginIds) {
    if (PLUGIN_DESCRIPTION_BY_ID.has(id)) continue;
    unknown.push({
      id,
      emoji: "🧩",
      label: id,
      body: "사용자가 추가로 설치한 플러그인입니다. 설정 → 플러그인에서 자세히 확인할 수 있어요.",
      tourScenarioId: "first-boot-essentials",
      scenarios: [
        "설정 → 플러그인에서 자세한 동작 확인",
        "플러그인 manifest 의 소개 페이지 열기",
      ],
    });
  }
  const ordered = [...known, ...unknown];
  if (!prioritizedPluginId) return ordered;
  const idx = ordered.findIndex((card) => card.id === prioritizedPluginId);
  if (idx <= 0) return ordered;
  const head = ordered[idx];
  return [head, ...ordered.slice(0, idx), ...ordered.slice(idx + 1)];
}

function usePrefersReducedMotion(): boolean {
  const [reduce, setReduce] = useState<boolean>(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return false;
    }
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  });
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return;
    }
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = () => setReduce(mq.matches);
    if (typeof mq.addEventListener === "function") {
      mq.addEventListener("change", onChange);
      return () => mq.removeEventListener("change", onChange);
    }
    mq.addListener(onChange);
    return () => mq.removeListener(onChange);
  }, []);
  return reduce;
}

export function PluginShowcase({
  open,
  installedPluginIds,
  api: _api,
  onClose,
  prioritizedScenarioId = null,
}: PluginShowcaseProps) {
  // `api` was previously used to fire `api.tour.start` from the
  // "둘러보기 →" button. 2026-05-20 redesign — that path is removed in
  // favour of inline scenario expansion (no external navigation), so
  // the prop is intentionally unused. Kept on the public interface so
  // existing call sites compile without changes.
  void _api;
  const reduceMotion = usePrefersReducedMotion();
  const prioritizedPluginId = useMemo(
    () => scenarioToPluginId(prioritizedScenarioId),
    [prioritizedScenarioId],
  );
  const cards = useMemo(
    () => resolveShowcaseCards(installedPluginIds, prioritizedPluginId),
    [installedPluginIds, prioritizedPluginId],
  );

  // 2026-05-20: inline scenario expansion. Each card has a "펼쳐보기 ↓"
  // toggle; the expanded set lives in local state so toggling one card
  // doesn't affect the others. Closing the showcase resets the set.
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    if (!open) setExpandedIds(new Set());
  }, [open]);

  const handleToggleExpand = useCallback((cardId: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(cardId)) {
        next.delete(cardId);
      } else {
        next.add(cardId);
      }
      return next;
    });
  }, []);

  const handleClose = useCallback(() => {
    onClose();
  }, [onClose]);

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) handleClose(); }}>
      <DialogContent
        size="sm"
        data-testid="plugin-showcase"
        data-reduce-motion={reduceMotion ? "true" : "false"}
        className="p-0 overflow-hidden"
      >
        <DialogHeader className="px-6 pt-6 pb-3 space-y-0">
          <div className="flex items-center gap-2">
            <span
              aria-hidden
              className="grid h-7 w-7 place-items-center rounded-md text-[11px] text-primary-foreground"
              style={{
                background:
                  "linear-gradient(135deg, hsl(var(--p-purple-500)), hsl(var(--p-blue-500)))",
              }}
            >
              ✦
            </span>
            <div className="min-w-0">
              <DialogTitle className="text-sm font-medium">
                설치된 플러그인 둘러보기
              </DialogTitle>
              <DialogDescription className="text-[11px]">
                각 플러그인이 무엇을 도와드리는지 1줄로 소개합니다.
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="px-6 pb-6 space-y-3">
          {cards.length === 0 ? (
            <p
              data-testid="plugin-showcase:empty"
              className="rounded-lg bg-[hsl(var(--muted))] px-3 py-3 text-[12.5px] leading-relaxed text-muted-foreground"
            >
              현재 설치된 플러그인이 없어요. 설정 → 마켓플레이스에서 필요한
              도구를 추가할 수 있습니다.
            </p>
          ) : (
            <div
              data-testid="plugin-showcase:list"
              className="space-y-2 max-h-[420px] overflow-y-auto pr-1"
            >
              {cards.map((card) => {
                const expanded = expandedIds.has(card.id);
                return (
                  <div
                    key={card.id}
                    data-testid={`plugin-showcase:card:${card.id}`}
                    data-expanded={expanded ? "true" : "false"}
                    className="rounded-lg border border-border/70 bg-[hsl(var(--muted))] px-3 py-3"
                  >
                    <div className="flex items-start gap-2">
                      <span className="text-base leading-none" aria-hidden="true">
                        {card.emoji}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="text-[12.5px] font-medium">{card.label}</div>
                        <div className="mt-1 text-[10.5px] leading-snug text-muted-foreground">
                          {card.body}
                        </div>
                        <div className="mt-2 flex items-center gap-2">
                          <Button
                            type="button"
                            variant="secondary"
                            size="sm"
                            className="h-6 px-2 text-[10.5px]"
                            data-testid={`plugin-showcase:card:${card.id}:expand`}
                            aria-expanded={expanded}
                            onClick={() => handleToggleExpand(card.id)}
                          >
                            {expanded ? "접기 ↑" : "펼쳐보기 ↓"}
                          </Button>
                        </div>
                        {expanded && (
                          <ul
                            data-testid={`plugin-showcase:card:${card.id}:scenarios`}
                            className="mt-2 space-y-1 rounded-md bg-background/40 px-2 py-2 text-[10.5px] leading-snug text-muted-foreground"
                          >
                            {card.scenarios.map((scenario) => (
                              <li
                                key={scenario}
                                className="flex items-start gap-1.5"
                              >
                                <span
                                  aria-hidden="true"
                                  style={{ color: "hsl(var(--p-purple-500))" }}
                                >
                                  •
                                </span>
                                <span>{scenario}</span>
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          <Button
            type="button"
            data-testid="plugin-showcase:close"
            onClick={handleClose}
            className="w-full text-primary-foreground"
            style={{
              background:
                "linear-gradient(135deg, hsl(var(--p-purple-500)), hsl(var(--p-blue-500)))",
            }}
          >
            끝내기 →
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
