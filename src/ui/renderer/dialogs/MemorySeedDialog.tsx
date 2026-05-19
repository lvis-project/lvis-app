/**
 * MemorySeedDialog (Tutorial-B / O-X2 시안) — first-boot Memory Seed wizard.
 *
 * Replaces the legacy OnboardingDialog (#893) on the first-boot surface.
 * The wizard captures (a) the user's preferred 호칭 and (b) a one-line
 * self-introduction, persists both into `~/.lvis/memories/MEMORY.md`
 * Urgent Memory section via `api.memoryUpdateIndexSections`, then chains
 * into the SpotlightTour by broadcasting `api.tour.start("first-boot-essentials")`.
 *
 * Design contract (mockup `O-X2 Memory Seed` in `/tmp/login-lvis/index.html`):
 *   - Brand header ✦ "LVIS — 기억을 시작합니다"
 *   - LVIS welcome card explaining MEMORY.md
 *   - Name input + 2-line self-intro textarea
 *   - Live "✨ 분석 결과" gradient card with recommended-plugin chips
 *     (driven by `inferRecommendedPlugins`)
 *   - "기억하고 시작하기" CTA (violet→blue gradient) and "건너뛰기" ghost
 *
 * Storage:
 *   - Self-intro + 호칭 → MEMORY.md Urgent Memory section (single
 *     deterministic line; persists across reboots via MemoryManager.load()).
 *   - `features.onboardingCompleted = true` always flips on dismissal so
 *     the wizard never re-renders. Re-entry is handled by ⌘+Shift+/ which
 *     fires `api.tour.start` (the same SpotlightTour scenario this wizard
 *     auto-launches on submit).
 *
 * Error contract: every IPC call is best-effort with try/catch — disk
 * failures must never trap the user on the first-boot dialog. The English
 * IPC error codes from the host are intentionally swallowed because the
 * UX requirement is "always advance to the chat surface".
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
import { Input } from "../../../components/ui/input.js";
import { Label } from "../../../components/ui/label.js";
import { Textarea } from "../../../components/ui/textarea.js";
import { cn } from "../../../lib/utils.js";
import type { LvisApi } from "../types.js";
import { inferRecommendedPlugins } from "../onboarding/plugin-recommendation-matrix.js";

export interface MemorySeedDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Subset of LvisApi we depend on so tests can stub without instantiating
   * the full preload surface. `tutorialInstallPlugin` is optional so the
   * existing fixture-stubs (which omit it) keep mounting unchanged; the
   * chip simply becomes a no-op when the bridge isn't wired.
   */
  api: Pick<LvisApi, "memoryUpdateIndexSections" | "tour" | "updateSettings"> & {
    tutorialInstallPlugin?: LvisApi["tutorialInstallPlugin"];
    /**
     * Tutorial-X4 — optional onboarding-context writer. When wired the
     * wizard writes a short markdown synth (호칭 + 자기소개 + clicked
     * install requests) so the SystemPromptBuilder injects it as section
     * id=9.86 on every subsequent turn. Omitted in tests/fixtures.
     */
    onboardingContextSet?: LvisApi["onboardingContextSet"];
  };
  /** Called after dismissal (Submit or Skip). Flips `features.onboardingCompleted`. */
  onDismissed: () => void;
  /**
   * ScenarioShowcase carry — the card id the user clicked in the first
   * step (e.g. "meeting" / "docs" / "work" / "multi-agent"). When set,
   * the intro textarea placeholder swaps to a scenario-tinted hint so
   * the user sees an example aligned with their pick. `null` means no
   * scenario was selected and the legacy generic placeholder applies.
   */
  selectedScenarioId?: string | null;
}

/**
 * Scenario-tinted intro placeholder. Pure so the unit test pins each
 * scenario id → placeholder mapping. Unknown / null ids fall through
 * to the legacy generic example.
 */
export function scenarioIntroPlaceholder(
  scenarioId: string | null | undefined,
): string {
  switch (scenarioId) {
    case "meeting":
      return "예) 매주 회의가 많은 PM. 회의록 정리와 액션 아이템 추출에 관심.";
    case "docs":
      return "예) 사내 문서가 많은 시니어 엔지니어. 빠른 검색과 요약이 필요.";
    case "work":
      return "예) 메일·일정이 폭주하는 매니저. 우선순위 정리와 알림 자동화에 관심.";
    case "multi-agent":
      return "예) 리서치/분석을 여러 갈래로 동시 진행하는 PM·전략가.";
    default:
      return "예) 매주 회의가 많은 PM. 회의록 정리와 일정 관리 자동화에 관심.";
  }
}

const TOUR_SCENARIO_ID = "first-boot-essentials";

/**
 * Composes the Urgent Memory body the wizard writes into MEMORY.md.
 * Kept pure so the unit test can assert the exact persistence shape.
 */
export function composeUrgentMemorySeed(name: string, intro: string): string {
  const trimmedName = name.trim();
  const trimmedIntro = intro.trim();
  const lines: string[] = [];
  if (trimmedName.length > 0) {
    lines.push(`- 호칭: ${trimmedName}`);
  }
  if (trimmedIntro.length > 0) {
    lines.push(`- 자기소개: ${trimmedIntro}`);
  }
  return lines.join("\n");
}

/**
 * Tutorial-X4 — compose the markdown block the host writes to
 * `~/.lvis/onboarding/onboarding-context.md`. The SystemPromptBuilder
 * picks this up as section id=9.86 so the LLM's first post-onboarding
 * turn can greet the user by 호칭, reference their 자기소개, and suggest
 * tasks bound to the plugins the user just chose to install.
 *
 * Pure for unit testability — caller composes from the same state the
 * Memory Seed wizard collected. Returns "" when nothing useful would be
 * emitted so the system-prompt section silently drops out.
 */
export function composeOnboardingContext(
  name: string,
  intro: string,
  installedSlugs: readonly string[],
): string {
  const trimmedName = name.trim();
  const trimmedIntro = intro.trim();
  const slugs = installedSlugs.filter((s) => s.length > 0);
  if (
    trimmedName.length === 0 &&
    trimmedIntro.length === 0 &&
    slugs.length === 0
  ) {
    return "";
  }
  const lines: string[] = [];
  if (trimmedName.length > 0) {
    lines.push(`- 사용자 호칭: ${trimmedName}`);
    lines.push(
      `- 호칭 사용 규칙: 첫 turn 의 인사에서 "${trimmedName}" 호칭을 자연스럽게 한 번 사용하고, 이후 turn 에서는 과도하게 반복하지 않습니다.`,
    );
  }
  if (trimmedIntro.length > 0) {
    lines.push(`- 사용자 자기소개: ${trimmedIntro}`);
  }
  if (slugs.length > 0) {
    lines.push(
      `- 방금 설치 요청한 플러그인: ${slugs.join(", ")}. 첫 turn 에서 이 플러그인 중 하나로 시작할 수 있는 *진짜 첫 작업* 을 자연스럽게 제안하세요.`,
    );
  }
  lines.push(
    `- 첫 turn 가이드라인: 사용자가 방금 LVIS 의 온보딩을 마쳤습니다. 일반적인 환영 인사가 아닌, 위 정보 기반의 *구체적 다음 행동* 을 1~2 문장으로 제시하세요.`,
  );
  return lines.join("\n");
}

export function MemorySeedDialog({
  open,
  onOpenChange,
  api,
  onDismissed,
  selectedScenarioId = null,
}: MemorySeedDialogProps) {
  const [name, setName] = useState("");
  const [intro, setIntro] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // Reset transient state every time the dialog re-opens. Without this the
  // submit lock would persist across re-opens after a failed write.
  useEffect(() => {
    if (open) {
      setSubmitting(false);
    }
  }, [open]);

  const recommendations = useMemo(() => inferRecommendedPlugins(intro), [intro]);

  // Tutorial-X2 — track chips the user has *clicked* so they remain
  // visibly distinct after install was requested. The Set lives in
  // component state so re-renders preserve the "installing"/"installed"
  // badge; it never persists across remounts (the user closes the wizard
  // once and onboardingCompleted flips true).
  const [installRequested, setInstallRequested] = useState<Set<string>>(
    () => new Set(),
  );
  const handleChipClick = useCallback(
    (slug: string | null, pluginId: string) => {
      if (!slug) return; // chat-basics fallback — meta recommendation only
      if (installRequested.has(pluginId)) return; // already requested
      setInstallRequested((prev) => {
        const next = new Set(prev);
        next.add(pluginId);
        return next;
      });
      if (typeof api.tutorialInstallPlugin === "function") {
        void api.tutorialInstallPlugin(slug).catch(() => {
          // install path emits its own audit + lifecycle broadcasts; the
          // wizard never blocks the user on a transient install error
        });
      }
    },
    [api, installRequested],
  );

  const startTour = useCallback(() => {
    // Fire-and-forget — the SpotlightTour mounts unconditionally in App.tsx
    // and listens for the broadcast. Failure to start the tour must not
    // block onboarding completion.
    try {
      void api.tour.start(TOUR_SCENARIO_ID);
    } catch {
      // ignore — see component contract.
    }
  }, [api]);

  const handleSubmit = useCallback(async () => {
    if (submitting) return;
    setSubmitting(true);
    const urgentMemory = composeUrgentMemorySeed(name, intro);
    if (urgentMemory.length > 0) {
      try {
        await api.memoryUpdateIndexSections({ urgentMemory });
      } catch {
        // disk failure is non-fatal — proceed to tour anyway.
      }
    }
    // Tutorial-X4 — write the synthesized onboarding context so the
    // SystemPromptBuilder injects it as section id=9.86 on subsequent
    // turns. Fire-and-forget: disk failure must not block the tour
    // hand-off because the user is already mid-flow.
    if (typeof api.onboardingContextSet === "function") {
      const installedSlugs = Array.from(installRequested);
      const onboardingContext = composeOnboardingContext(
        name,
        intro,
        installedSlugs,
      );
      try {
        await api.onboardingContextSet(onboardingContext);
      } catch {
        // file-write failure stays local — the LLM simply won't see the
        // section on the first turn, which is still a valid UX.
      }
    }
    onDismissed();
    onOpenChange(false);
    startTour();
  }, [
    api,
    intro,
    name,
    onDismissed,
    onOpenChange,
    startTour,
    submitting,
    installRequested,
  ]);

  const handleSkip = useCallback(() => {
    onDismissed();
    onOpenChange(false);
    startTour();
  }, [onDismissed, onOpenChange, startTour]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        size="sm"
        data-testid="memory-seed-dialog"
        className="p-0 overflow-hidden"
      >
        {/* Brand header — gradient avatar + title mirrors mockup line 441 */}
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
            <div>
              <DialogTitle className="text-sm font-medium">
                LVIS — 기억을 시작합니다
              </DialogTitle>
              <DialogDescription className="text-[10px]">
                저를 어떻게 부르고 싶으세요?
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="px-6 pb-6 space-y-3">
          {/* LVIS welcome message card — MEMORY.md 첫 항목 안내 */}
          <div className="rounded-lg bg-[hsl(var(--muted))] px-3 py-3 text-[12.5px] leading-relaxed">
            <b>저를 어떻게 부르고 싶으세요?</b>
            <br />
            그리고 LVIS 가 무엇을 가장 자주 도와드리면 좋을지 한 줄로
            적어주세요.
            <br />
            <span className="text-[10.5px] text-muted-foreground">
              이 한 줄은 영구 메모리(MEMORY.md)로 저장되어 모든 대화에
              반영됩니다.
            </span>
          </div>

          {/* Name */}
          <div className="space-y-1.5">
            <Label htmlFor="memory-seed-name" className="text-[11px]">
              호칭
            </Label>
            <Input
              id="memory-seed-name"
              data-testid="memory-seed-dialog:name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="이름 또는 호칭"
              autoFocus
            />
          </div>

          {/* One-liner intro */}
          <div className="space-y-1.5">
            <Label htmlFor="memory-seed-intro" className="text-[11px]">
              한 줄 자기소개
            </Label>
            <Textarea
              id="memory-seed-intro"
              data-testid="memory-seed-dialog:intro"
              value={intro}
              onChange={(e) => setIntro(e.target.value)}
              rows={2}
              className="resize-none"
              placeholder={scenarioIntroPlaceholder(selectedScenarioId)}
            />
            <p className="text-[10px] text-muted-foreground">
              ✦ 이 내용이 MEMORY.md 의 첫 항목이 됩니다.
            </p>
          </div>

          {/* Predicted plugins card — violet→orange gradient + chip strip */}
          <div
            data-testid="memory-seed-dialog:recommendations"
            className="rounded-lg p-3"
            style={{
              background:
                "linear-gradient(135deg, hsl(var(--p-purple-500) / 0.10), hsl(var(--p-orange-500) / 0.07))",
              border: "1px solid hsl(var(--p-purple-500) / 0.30)",
            }}
          >
            <div
              className="text-[10.5px] uppercase tracking-wider"
              style={{ color: "hsl(var(--p-purple-500))" }}
            >
              ✨ 분석 결과
            </div>
            <div className="text-[12px] mt-1.5">
              자기소개 기반으로 다음 도구를 추천합니다:
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {recommendations.map((rec) => {
                const requested = installRequested.has(rec.pluginId);
                const installable = rec.marketplaceSlug !== null;
                return (
                  <button
                    type="button"
                    key={rec.pluginId}
                    data-testid={`memory-seed-dialog:chip:${rec.pluginId}`}
                    data-install-requested={requested ? "true" : "false"}
                    onClick={() => handleChipClick(rec.marketplaceSlug, rec.pluginId)}
                    disabled={!installable || requested}
                    title={
                      installable
                        ? requested
                          ? "설치 요청을 보냈습니다"
                          : "클릭하면 설치합니다"
                        : "이 추천은 설치 가능한 플러그인이 없습니다"
                    }
                    className={
                      "text-[11px] px-2 py-0.5 rounded-full transition disabled:cursor-default"
                    }
                    style={{
                      background: requested
                        ? "hsl(var(--p-purple-500) / 0.30)"
                        : "hsl(var(--p-purple-500) / 0.18)",
                      color: "hsl(var(--p-purple-500))",
                    }}
                  >
                    {rec.emoji} {rec.label}
                    {requested ? " ✓" : installable ? "" : ""}
                  </button>
                );
              })}
            </div>
            {/* Microcopy explains the chip becomes a real install. The
                fallback chat-basics chip stays a non-button (disabled). */}
            <p className="mt-2 text-[10.5px] text-muted-foreground">
              ✦ 클릭하면 해당 플러그인이 즉시 설치됩니다.
            </p>
          </div>

          {/* CTAs */}
          <Button
            type="button"
            className={cn("w-full text-primary-foreground")}
            data-testid="memory-seed-dialog:submit"
            onClick={handleSubmit}
            disabled={submitting}
            style={{
              background:
                "linear-gradient(135deg, hsl(var(--p-purple-500)), hsl(var(--p-blue-500)))",
            }}
          >
            기억하고 시작하기 →
          </Button>
          <Button
            type="button"
            variant="ghost"
            className="w-full text-[11px]"
            data-testid="memory-seed-dialog:skip"
            onClick={handleSkip}
            disabled={submitting}
          >
            건너뛰기 (나중에 ⌘? 로 재진입)
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
