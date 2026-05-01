import { Suspense, useState } from "react";
import { LayoutGrid, ExternalLink, Plus, Plug } from "lucide-react";
import { Button } from "../../../components/ui/button.js";
import { Popover, PopoverContent, PopoverTrigger } from "../../../components/ui/popover.js";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../../components/ui/tooltip.js";
import { pluginIconFor } from "../utils/plugin-icon.js";

export interface PluginEntry {
  viewKey: string;
  /** Plugin id owning the view — drives auth-state lookup. @optional */
  pluginId?: string;
  label: string;
  /** Lucide icon name from the plugin manifest (PascalCase, e.g. "Mic"). */
  icon?: string;
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
  /** Set of plugin slugs (IDs) currently being installed. */
  installingPluginIds?: Set<string>;
  onSelect: (viewKey: string) => void;
  /** Called when the user clicks the "+" cell or the empty-state CTA. */
  onOpenMarketplace: () => void;
  /** `true` while the marketplace URL is being loaded — disables CTA and "+" cell. */
  marketplaceUrlReady?: boolean;
}

export function PluginGridButton({
  plugins,
  installingPluginIds,
  onSelect,
  onOpenMarketplace,
  marketplaceUrlReady = false,
}: PluginGridButtonProps) {
  const [open, setOpen] = useState(false);
  const anyUnauthed = plugins.some((p) => p.unauthed);
  const tooltipLabel = anyUnauthed ? "플러그인 — 인증 필요" : "플러그인";

  const handleSelect = (viewKey: string) => {
    setOpen(false);
    onSelect(viewKey);
  };

  const isEmpty = plugins.length === 0 && (!installingPluginIds || installingPluginIds.size === 0);

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
          className="absolute -right-1 -top-1 h-2 w-2 rounded-full bg-red-500 ring-1 ring-background"
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
              variant="outline"
              size="sm"
              className="h-7 w-7 p-0"
              aria-label="플러그인 열기"
              data-testid="plugin-grid-button"
            >
              {triggerInner}
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="top">{tooltipLabel}</TooltipContent>
      </Tooltip>

      <PopoverContent
        align="start"
        side="top"
        className="w-[460px] p-4"
        data-testid="plugin-grid-popover"
      >
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
            className="grid grid-cols-5 gap-3 max-h-[220px] overflow-y-auto scrollbar-thin pr-1"
            data-testid="plugin-grid"
          >
            {plugins.map((p) => {
              // Use explicit pluginId from PluginEntry when available; fall back
              // to deriving from viewKey for cases where the caller omits it.
              const pluginId = p.pluginId ?? p.viewKey.split(":")[1] ?? "";
              const isInstalling = installingPluginIds?.has(pluginId) ?? false;
              const Icon = pluginIconFor({ icon: p.icon });

              return (
                <button
                  key={p.viewKey}
                  className={`plugin-cell flex flex-col items-center gap-1.5 rounded-lg p-2 transition-all${isInstalling ? " cell-installing cursor-default" : " hover:bg-muted hover:-translate-y-0.5"}`}
                  disabled={isInstalling}
                  onClick={() => !isInstalling && handleSelect(p.viewKey)}
                  data-viewkey={p.viewKey}
                  data-testid={`plugin-cell-${pluginId}`}
                  data-unauthed={p.unauthed ? "true" : undefined}
                  aria-busy={isInstalling}
                  aria-describedby={p.unauthed ? `${p.viewKey}-unauthed` : undefined}
                  title={p.unauthed ? `${p.label} — 클릭하여 로그인` : undefined}
                >
                  <span className="plugin-icon relative flex h-11 w-11 items-center justify-center rounded-full bg-muted">
                    <Suspense fallback={<Plug className="h-5 w-5 opacity-30" />}>
                      <Icon className="h-5 w-5" strokeWidth={1.6} />
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
                      </>
                    )}
                    {p.unauthed && (
                      <span
                        id={`${p.viewKey}-unauthed`}
                        aria-label="미인증"
                        className="absolute -right-0.5 -top-0.5 inline-flex items-center justify-center rounded-full bg-red-500 px-1 py-px text-[8px] font-medium text-white shadow"
                      >
                        🔒
                      </span>
                    )}
                  </span>
                  <span className="text-[11px] truncate max-w-[64px]">{p.label}</span>
                </button>
              );
            })}

            {/* "+" cell — open marketplace */}
            <button
              className={`plugin-cell flex flex-col items-center gap-1.5 rounded-lg p-2${marketplaceUrlReady ? " hover:bg-muted hover:-translate-y-0.5" : " cursor-default opacity-50"}`}
              disabled={!marketplaceUrlReady}
              onClick={() => {
                if (!marketplaceUrlReady) return;
                setOpen(false);
                onOpenMarketplace();
              }}
              data-testid="plugin-cell-add"
            >
              <span className="plugin-icon flex h-11 w-11 items-center justify-center rounded-full border border-dashed border-muted-foreground/40 text-muted-foreground">
                {marketplaceUrlReady ? (
                  <Plus className="h-[18px] w-[18px]" />
                ) : (
                  <span className="text-[10px]">...</span>
                )}
              </span>
              <span className="text-[11px] text-muted-foreground truncate max-w-[64px]">
                {marketplaceUrlReady ? "추가" : "로딩 중"}
              </span>
            </button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
