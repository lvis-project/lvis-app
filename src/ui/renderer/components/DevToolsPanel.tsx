/**
 * DevToolsPanel — floating panel for runtime dev controls.
 *
 * Visible only in non-production NODE_ENV. Triggered by the dev indicator
 * in MainToolbar (next to Home button) or by keyboard shortcut Cmd/Ctrl+Shift+D.
 *
 * Current controls:
 *   - Preflight threshold slider — adjusts the compact trigger
 *     so dev/test can reproduce compact scenarios without filling 200K context.
 *     Range 500 — 100,000 tokens. Live IPC push to engine.
 */
import { useCallback, useEffect, useState } from "react";
import { X } from "lucide-react";
import { Button } from "../../../components/ui/button.js";
import { Slider } from "../../../components/ui/slider.js";
import type { LvisApi } from "../types.js";
import { useTranslation } from "../../../i18n/react.js";

interface PreflightStatus {
  runtimeOverride: number | null;
  envOverride: number | null;
  effective: number;
  provider: string;
  model: string;
}

interface DevToolsPanelProps {
  api: LvisApi;
  open: boolean;
  onClose: () => void;
}

export function DevToolsPanel({ api, open, onClose }: DevToolsPanelProps) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<PreflightStatus | null>(null);
  const [sliderValue, setSliderValue] = useState<number>(5_000);
  const [error, setError] = useState<string | null>(null);

  const refreshStatus = useCallback(async () => {
    if (api.dev === undefined) {
      setError(t("devToolsPanel.devApiUnavailable"));
      return;
    }
    const res = await api.dev.getPreflightStatus();
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setStatus({
      runtimeOverride: res.runtimeOverride,
      envOverride: res.envOverride,
      effective: res.effective,
      provider: res.provider,
      model: res.model,
    });
    setSliderValue(res.runtimeOverride ?? res.envOverride ?? Math.min(res.effective, 100_000));
    setError(null);
  }, [api, t]);

  useEffect(() => {
    if (open) void refreshStatus();
  }, [open, refreshStatus]);

  const applyOverride = useCallback(
    async (n: number | null) => {
      if (api.dev === undefined) return;
      const res = await api.dev.setPreflightOverride(n);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      await refreshStatus();
    },
    [api, refreshStatus],
  );

  // Drag updates only the local display value — IPC fires on commit
  // (pointer-up / keyboard release) so dragging the slider does not flood
  // main with hundreds of round-trips. Radix Slider's `onValueCommit`
  // delivers exactly one event per gesture.
  const handleSliderChange = useCallback(
    (next: number[]) => {
      const v = next[0];
      if (typeof v !== "number") return;
      setSliderValue(v);
    },
    [],
  );

  const handleSliderCommit = useCallback(
    (next: number[]) => {
      const v = next[0];
      if (typeof v !== "number") return;
      void applyOverride(v);
    },
    [applyOverride],
  );

  const handleClear = useCallback(() => {
    void applyOverride(null);
  }, [applyOverride]);

  if (!open) return null;

  return (
    <div
      data-testid="dev-tools-panel"
      className="fixed right-4 top-14 z-50 w-[360px] rounded-lg border bg-card p-4 shadow-xl"
    >
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">{t("devToolsPanel.title")}</h3>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          onClick={onClose}
          aria-label={t("devToolsPanel.closeAriaLabel")}
        >
          <X className="h-3 w-3" />
        </Button>
      </div>
      <p className="mt-1 text-[10px] text-muted-foreground">
        {t("devToolsPanel.shortcutHint")}
      </p>

      <div className="mt-4 space-y-2">
        <div className="flex items-center justify-between gap-2">
          <label className="text-xs font-medium">{t("devToolsPanel.preflightThresholdLabel")}</label>
          <span className="text-xs font-mono tabular-nums">
            {t("devToolsPanel.tokensValue", { count: sliderValue.toLocaleString() })}
          </span>
        </div>
        <Slider
          min={500}
          max={100_000}
          step={500}
          value={[sliderValue]}
          onValueChange={handleSliderChange}
          onValueCommit={handleSliderCommit}
          aria-label={t("devToolsPanel.preflightThresholdLabel")}
        />
        <div className="flex items-center justify-between text-[10px] text-muted-foreground">
          <span>500</span>
          <span>100,000</span>
        </div>
      </div>

      <div className="mt-3 space-y-1 rounded-md border bg-muted/(--opacity-muted) p-2 text-[10.5px]">
        <Row label={t("devToolsPanel.providerModelLabel")} value={status ? `${status.provider}/${status.model}` : "—"} />
        <Row
          label={t("devToolsPanel.effectiveTriggerLabel")}
          value={status ? t("devToolsPanel.tokensValue", { count: status.effective.toLocaleString() }) : "—"}
        />
        <Row
          label={t("devToolsPanel.runtimeOverrideLabel")}
          value={status?.runtimeOverride !== null && status?.runtimeOverride !== undefined ? `${status.runtimeOverride.toLocaleString()}` : t("devToolsPanel.noneValue")}
        />
        <Row
          label={t("devToolsPanel.envOverrideLabel")}
          value={status?.envOverride !== null && status?.envOverride !== undefined ? `${status.envOverride.toLocaleString()}` : t("devToolsPanel.unsetValue")}
        />
      </div>

      <div className="mt-3 flex gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 flex-1 text-xs"
          onClick={handleClear}
          aria-label={t("devToolsPanel.clearOverrideAriaLabel")}
        >
          {t("devToolsPanel.clearOverrideButton")}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 flex-1 text-xs"
          onClick={() => void refreshStatus()}
          aria-label={t("devToolsPanel.refreshAriaLabel")}
        >
          {t("devToolsPanel.refreshButton")}
        </Button>
      </div>

      {error !== null && (
        <p className="mt-2 text-[10.5px] text-destructive" role="alert">
          {error}
        </p>
      )}

      <p className="mt-3 border-t pt-2 text-[10px] text-muted-foreground">
        {t("devToolsPanel.sliderDescription")}
      </p>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-mono tabular-nums">{value}</span>
    </div>
  );
}
