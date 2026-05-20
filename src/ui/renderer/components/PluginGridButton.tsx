import { Suspense, useEffect, useRef, useState } from "react";
import { Popover as PopoverPrimitive } from "radix-ui";
import { LayoutGrid, ExternalLink, Plug } from "lucide-react";
import { Button } from "../../../components/ui/button.js";
import { Popover, PopoverContent, PopoverTrigger } from "../../../components/ui/popover.js";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../../components/ui/tooltip.js";
import { pluginIconFor } from "../utils/plugin-icon.js";
import type { InstallPhase } from "../hooks/use-plugin-marketplace.js";

const PHASE_LABEL: Record<InstallPhase, string> = {
  downloading: "다운로드",
  verifying: "검증",
  installing: "설치",
  registering: "등록",
  restarting: "재시작",
  preparing: "준비",
};

export interface PluginEntry {
  viewKey: string;
  /** Plugin id owning the view — drives auth-state lookup. @optional */
  pluginId?: string;
  /** Request slugs that install/update this plugin, including marketplace aliases. */
  installAliases?: string[];
  label: string;
  /** Lucide icon name from the plugin manifest (PascalCase, e.g. "Mic"). */
  icon?: string;
  /**
   * Short text (1-4 chars) rendered in place of the Lucide icon — e.g.
   * `"EP"`. Takes precedence over `icon` when both are set.
   */
  iconText?: string;
  /**
   * `true` when the owning plugin declares `manifest.auth` and its current
   * statusTool result is `kind: "unauthed"`. The grid renders a small 🔒
   * indicator on those entries so users see the missing-auth state without
   * first opening Settings (architecture.md §9.4a).
   */
  unauthed?: boolean;
}

interface PluginGridButtonProps {
  plugins: PluginEntry[];
  /**
   * Plugin slugs currently being installed mapped to their pipeline phase.
   * Drives both: the spinner overlay on already-registered cells (e.g. a
   * restart pass on an updating plugin) and a fresh placeholder cell for
   * slugs that aren't yet in `plugins` (a brand-new install before the
   * runtime registers it).
   */
  installingPlugins?: ReadonlyMap<string, InstallPhase>;
  onSelect: (viewKey: string) => void;
  /** Called when the user clicks the marketplace cell or the empty-state CTA. */
  onOpenMarketplace: () => void;
  /** `true` once the marketplace URL has finished loading and is non-empty; false while loading or when settings provided no URL. */
  marketplaceUrlReady?: boolean;
}

export function PluginGridButton({
  plugins,
  installingPlugins,
  onSelect,
  onOpenMarketplace,
  marketplaceUrlReady = false,
}: PluginGridButtonProps) {
  const [open, setOpen] = useState(false);
  // Match popover width to the chat composer's INNER input-bar and shift
  // it left via `alignOffset` so the popover's left edge aligns with the
  // input-bar's left edge — otherwise `align="start"` anchors at the
  // trigger and the popover visually slides off-center to the right.
  // ResizeObserver keeps both values in sync as the chat panel resizes.
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const [popoverWidth, setPopoverWidth] = useState<number | null>(null);
  const [alignOffset, setAlignOffset] = useState(0);
  useEffect(() => {
    if (!open) return;
    const triggerEl = triggerRef.current;
    if (!triggerEl) return;
    // Scope DOM lookup to the trigger's nearest ancestor that contains
    // the composer — keeps this robust against multi-pane layouts where
    // a document-global query could grab the wrong panel's composer.
    let scope: Element | null = triggerEl.parentElement;
    while (scope && !scope.querySelector('[data-testid="composer"]')) {
      scope = scope.parentElement;
    }
    const composer = scope?.querySelector('[data-testid="composer"]') as HTMLElement | null;
    if (!composer) return;
    const measure = () => {
      // Re-query the input-bar each tick by its stable testid — keeps
      // sizing correct if the composer's children swap (warning row
      // appearing on attach-cap, future siblings, etc.).
      const innerBar = composer.querySelector(
        '[data-testid="composer-input-bar"]',
      ) as HTMLElement | null;
      if (!innerBar) return;
      const innerRect = innerBar.getBoundingClientRect();
      const triggerRect = triggerEl.getBoundingClientRect();
      setPopoverWidth(innerRect.width);
      setAlignOffset(-(triggerRect.left - innerRect.left));
    };
    measure();
    // Observe the composer wrapper itself (stable parent) so any
    // child-swap or chip-mounted resize re-fires `measure`.
    const ro = new ResizeObserver(measure);
    ro.observe(composer);
    return () => ro.disconnect();
  }, [open]);
  const anyUnauthed = plugins.some((p) => p.unauthed);
  const tooltipLabel = anyUnauthed ? "플러그인 — 인증 필요" : "플러그인";

  const handleSelect = (viewKey: string) => {
    setOpen(false);
    onSelect(viewKey);
  };

  const isEmpty = plugins.length === 0 && (!installingPlugins || installingPlugins.size === 0);

  // Slugs that are installing but not yet registered as PluginEntry — render
  // them as placeholder cells so the user sees their click registered the
  // moment the install pipeline starts, before the runtime emits a view.
  const installKeysFor = (plugin: PluginEntry): string[] => {
    const pluginId = plugin.pluginId ?? plugin.viewKey.split(":")[1] ?? "";
    return [pluginId, ...(plugin.installAliases ?? [])].filter((key) => key.length > 0);
  };
  const registeredIds = new Set(plugins.flatMap(installKeysFor));
  const placeholderInstalls: Array<[string, InstallPhase]> = installingPlugins
    ? Array.from(installingPlugins.entries()).filter(([slug]) => !registeredIds.has(slug))
    : [];

  // Small red dot on the LayoutGrid trigger when any plugin in the popover
  // is unauthenticated. Without this users only see the missing-auth state
  // by opening the popover; the dot draws attention from outside.
  const triggerInner = (
    <span className="relative inline-flex h-3.5 w-3.5">
      <LayoutGrid className="h-3.5 w-3.5" />
      {anyUnauthed && (
        <span
          aria-label="미인증 플러그인 있음"
          data-testid="plugin-grid-unauthed-dot"
          className="absolute -right-1 -top-1 h-2 w-2 rounded-full bg-destructive ring-1 ring-background"
        />
      )}
    </span>
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button
              ref={triggerRef}
              variant="ghost"
              size="sm"
              className="h-7 w-7 p-0"
              aria-label="플러그인 열기"
              data-testid="plugin-grid-button"
              // SpotlightTour anchor — step 8 ("플러그인 — 회의·문서·업무 도우미")
              // in `first-boot-essentials` pins to this trigger. See
              // `default-tour-scenarios.ts` and the live-anchor regression
              // gate in `__tests__/tour-anchors-trigger.test.tsx`.
              data-tour-anchor="plugin-entry"
            >
              {triggerInner}
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="top">{tooltipLabel}</TooltipContent>
      </Tooltip>

      <PopoverContent
        align="start"
        alignOffset={alignOffset}
        side="top"
        className="px-4 py-3 border border-border shadow-lg bg-input-bar text-foreground"
        style={popoverWidth ? { width: popoverWidth, maxWidth: "none" } : undefined}
        data-testid="plugin-grid-popover"
      >
        {/* Speech-bubble tail pointing back at the plugin grid trigger.
            Positioned via Radix's auto-aligned arrow primitive — sits at
            the popover's bottom (because side="top") and tracks the
            trigger's center horizontally. fill matches popover bg so the
            tail looks contiguous with the bubble. */}
        <PopoverPrimitive.Arrow
          width={14}
          height={7}
          className="fill-input-bar"
        />
        {isEmpty ? (
          <div className="py-6 text-center" data-testid="plugin-grid-empty">
            <div className="mb-3 flex justify-center">
              <span className="flex h-11 w-11 items-center justify-center rounded-full border border-dashed border-muted-foreground/40 text-muted-foreground">
                <Plug className="h-5 w-5" />
              </span>
            </div>
            <p className="text-sm mb-1">플러그인이 없습니다</p>
            <p className="text-xs text-muted-foreground">마켓플레이스에서 설치해보세요</p>
            <Button
              size="sm"
              variant="outline"
              className="mt-3 gap-1"
              disabled={!marketplaceUrlReady}
              onClick={() => {
                setOpen(false);
                onOpenMarketplace();
              }}
            >
              {marketplaceUrlReady ? (
                <>마켓플레이스 열기 <ExternalLink className="h-3 w-3" /></>
              ) : (
                "로딩 중..."
              )}
            </Button>
          </div>
        ) : (
          <div
            className="grid grid-cols-[repeat(auto-fill,minmax(80px,1fr))] gap-x-3 gap-y-1 max-h-[220px] overflow-y-auto scrollbar-thin pr-1"
            data-testid="plugin-grid"
          >
            {plugins.map((p) => {
              // viewKey drives the testid so a single plugin exposing multiple
              // plugin UI extensions still gets unique cells.
              const cellTestId = p.viewKey.replace(/:/g, "-");
              const phase = installKeysFor(p)
                .map((key) => installingPlugins?.get(key))
                .find((value): value is InstallPhase => value !== undefined);
              const isInstalling = phase !== undefined;
              const Icon = pluginIconFor({ icon: p.icon, iconText: p.iconText });

              return (
                <button
                  key={p.viewKey}
                  className={`plugin-cell flex flex-col items-center gap-1 rounded-lg px-2 py-1 transition-all${isInstalling ? " cell-installing cursor-default" : " hover:bg-muted hover:-translate-y-0.5"}`}
                  disabled={isInstalling}
                  onClick={() => !isInstalling && handleSelect(p.viewKey)}
                  data-viewkey={p.viewKey}
                  data-testid={`plugin-cell-${cellTestId}`}
                  data-unauthed={p.unauthed ? "true" : undefined}
                  aria-busy={isInstalling}
                  aria-describedby={p.unauthed ? `${p.viewKey}-unauthed` : undefined}
                  title={
                    isInstalling
                      ? `${p.label} ${PHASE_LABEL[phase]} 중...`
                      : p.unauthed
                        ? `${p.label} — 클릭하여 로그인`
                        : undefined
                  }
                >
                  <span className="plugin-icon relative flex h-11 w-11 items-center justify-center rounded-full bg-muted">
                    <Suspense fallback={<Plug className="h-7 w-7 opacity-30" />}>
                      <Icon className="h-7 w-7" strokeWidth={1.6} />
                    </Suspense>
                    {isInstalling && (
                      <>
                        <span
                          className="install-overlay absolute inset-0 rounded-full bg-background/60"
                          aria-hidden="true"
                        />
                        <span
                          className="install-spinner absolute inset-0 rounded-full border-2 border-transparent border-t-primary border-r-primary animate-spin"
                          aria-hidden="true"
                        />
                        <span
                          className="absolute inset-0 flex items-center justify-center text-[8px] font-semibold text-foreground leading-none z-10 pointer-events-none"
                          data-testid={`plugin-cell-${cellTestId}-phase`}
                        >
                          {PHASE_LABEL[phase]}
                        </span>
                      </>
                    )}
                    {p.unauthed && (
                      <span
                        id={`${p.viewKey}-unauthed`}
                        aria-label="미인증"
                        className="absolute -right-0.5 -top-0.5 inline-flex items-center justify-center rounded-full bg-destructive px-1 py-px text-[8px] font-medium text-destructive-foreground shadow"
                      >
                        🔒
                      </span>
                    )}
                  </span>
                  <span className="text-[11px] font-bold truncate max-w-[64px]">{p.label}</span>
                </button>
              );
            })}

            {/* Placeholder cells for in-flight plugins not yet registered as
                PluginEntry. Brand-new installs land here while download →
                verify → install → register → restart drives the pipeline; once
                the runtime registers a view, the slug moves into `plugins`
                and the placeholder disappears in the same render. */}
            {placeholderInstalls.map(([slug, phase]) => (
              <div
                key={`installing:${slug}`}
                className="plugin-cell cell-installing flex flex-col items-center gap-1 rounded-lg px-2 py-1 cursor-default"
                data-testid={`plugin-cell-installing-${slug}`}
                aria-busy="true"
                aria-label={`${slug} ${PHASE_LABEL[phase]} 중`}
                title={`${slug} ${PHASE_LABEL[phase]} 중...`}
              >
                <span className="plugin-icon relative flex h-11 w-11 items-center justify-center rounded-full bg-muted">
                  <Plug className="h-7 w-7 opacity-40" strokeWidth={1.6} />
                  <span
                    className="install-overlay absolute inset-0 rounded-full bg-background/60"
                    aria-hidden="true"
                  />
                  <span
                    className="install-spinner absolute inset-0 rounded-full border-2 border-transparent border-t-primary border-r-primary animate-spin"
                    aria-hidden="true"
                  />
                  <span
                    className="absolute inset-0 flex items-center justify-center text-[8px] font-semibold text-foreground leading-none z-10 pointer-events-none"
                    data-testid={`plugin-cell-installing-${slug}-phase`}
                  >
                    {PHASE_LABEL[phase]}
                  </span>
                </span>
                <span className="text-[11px] font-bold truncate max-w-[64px] text-muted-foreground">
                  {slug}
                </span>
              </div>
            ))}

            {/* Marketplace cell — sits at the end of the grid in scenario
                1/2 (with registered plugins) so users always have an entry
                point to install more. The empty-state branch above handles
                scenario 3 with a centered marketplace CTA instead. */}
            <button
              className={`plugin-cell flex flex-col items-center gap-1 rounded-lg px-2 py-1${marketplaceUrlReady ? " hover:bg-muted hover:-translate-y-0.5" : " cursor-default opacity-50"}`}
              disabled={!marketplaceUrlReady}
              onClick={() => {
                if (!marketplaceUrlReady) return;
                setOpen(false);
                onOpenMarketplace();
              }}
              data-testid="plugin-cell-add"
              title="마켓플레이스 열기"
              aria-label="마켓플레이스 열기"
            >
              <span className="plugin-icon flex h-11 w-11 items-center justify-center rounded-full border border-dashed border-muted-foreground/40 text-muted-foreground">
                {marketplaceUrlReady ? (
                  <ExternalLink className="h-[18px] w-[18px]" />
                ) : (
                  <span className="text-[10px]">...</span>
                )}
              </span>
              <span className="text-[11px] text-muted-foreground truncate max-w-[64px]">
                {marketplaceUrlReady ? "마켓" : "로딩 중"}
              </span>
            </button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
