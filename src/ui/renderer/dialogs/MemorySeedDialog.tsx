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
import { t } from "../../../i18n/runtime.js";
import { useTranslation } from "../../../i18n/react.js";

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
      return t("memorySeedDialog.placeholderMeeting");
    case "docs":
      return t("memorySeedDialog.placeholderDocs");
    case "work":
      return t("memorySeedDialog.placeholderWork");
    case "multi-agent":
      return t("memorySeedDialog.placeholderMultiAgent");
    default:
      return t("memorySeedDialog.placeholderDefault");
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
    lines.push(t("memorySeedDialog.seedName", { name: trimmedName }));
  }
  if (trimmedIntro.length > 0) {
    lines.push(t("memorySeedDialog.seedIntro", { intro: trimmedIntro }));
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
    lines.push(t("memorySeedDialog.ctxUserName", { name: trimmedName }));
    lines.push(t("memorySeedDialog.ctxNameRule", { name: trimmedName }));
  }
  if (trimmedIntro.length > 0) {
    lines.push(t("memorySeedDialog.ctxUserIntro", { intro: trimmedIntro }));
  }
  if (slugs.length > 0) {
    lines.push(t("memorySeedDialog.ctxPlugins", { slugs: slugs.join(", ") }));
  }
  lines.push(t("memorySeedDialog.ctxFirstTurnGuideline"));
  return lines.join("\n");
}

export function MemorySeedDialog({
  open,
  onOpenChange,
  api,
  onDismissed,
  selectedScenarioId = null,
}: MemorySeedDialogProps) {
  const { t } = useTranslation();
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
                {t("memorySeedDialog.brandTitle")}
              </DialogTitle>
              <DialogDescription className="text-[10px]">
                {t("memorySeedDialog.brandSubtitle")}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="px-6 pb-6 space-y-3">
          {/* LVIS welcome message card — MEMORY.md 첫 항목 안내 */}
          <div className="rounded-lg bg-[hsl(var(--muted))] px-3 py-3 text-[12.5px] leading-relaxed">
            <b>{t("memorySeedDialog.cardHeading")}</b>
            <br />
            {t("memorySeedDialog.cardBody")}
            <br />
            <span className="text-[10.5px] text-muted-foreground">
              {t("memorySeedDialog.cardNote")}
            </span>
          </div>

          {/* Name */}
          <div className="space-y-1.5">
            <Label htmlFor="memory-seed-name" className="text-[11px]">
              {t("memorySeedDialog.labelName")}
            </Label>
            <Input
              id="memory-seed-name"
              data-testid="memory-seed-dialog:name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("memorySeedDialog.placeholderName")}
              autoFocus
            />
          </div>

          {/* One-liner intro */}
          <div className="space-y-1.5">
            <Label htmlFor="memory-seed-intro" className="text-[11px]">
              {t("memorySeedDialog.labelIntro")}
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
              {t("memorySeedDialog.introHint")}
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
              {t("memorySeedDialog.analysisHeading")}
            </div>
            <div className="text-[12px] mt-1.5">
              {t("memorySeedDialog.analysisBody")}
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
                          ? t("memorySeedDialog.chipTitleInstalled")
                          : t("memorySeedDialog.chipTitleInstall")
                        : t("memorySeedDialog.chipTitleNoPlugin")
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
              {t("memorySeedDialog.chipInstallHint")}
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
            {t("memorySeedDialog.submitButton")}
          </Button>
          <Button
            type="button"
            variant="ghost"
            className="w-full text-[11px]"
            data-testid="memory-seed-dialog:skip"
            onClick={handleSkip}
            disabled={submitting}
          >
            {t("memorySeedDialog.skipButton")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
