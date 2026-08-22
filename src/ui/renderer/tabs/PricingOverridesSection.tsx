/**
 * Per-model price corrections — the control for `LVIS_PRICING_OVERRIDE`.
 *
 * The built-in table holds public list prices. An organisation on negotiated
 * rates therefore sees the wrong number everywhere the app reports spend, and
 * the only fix was a JSON blob in an environment variable — which the person
 * running a packaged build cannot set.
 *
 * A table rather than a JSON field: the blob's shape is nested, and a text
 * area accepting nested JSON would ask the user to be a parser. Rows are
 * validated as they are typed, because `normalizePricingOverrides` drops a
 * malformed row silently and a control that let you save one would be telling
 * you it saved something it discarded.
 *
 * Reach note: this corrects REPORTED spend — the Usage tab and its CSV export.
 * That is exactly the reach the environment variable has always had; the live
 * composer badge prices from the shared table directly and is untouched by
 * either path.
 */
import { useCallback, useEffect, useState } from "react";
import { Button } from "../../../components/ui/button.js";
import { Input } from "../../../components/ui/input.js";
import { Label } from "../../../components/ui/label.js";
import { NativeSelect, NativeSelectOption } from "../../../components/ui/native-select.js";
import { SettingsSection } from "../components/PageShell.js";
import { EnvForcedNotice, useEnvForcedSettings } from "../components/EnvForcedNotice.js";
import { useTranslation } from "../../../i18n/react.js";
import { getApi } from "../api-client.js";
import { PRICING_VENDORS } from "../../../shared/pricing-data.js";
import {
  isPricingOverrideRate,
  type PricingOverride,
} from "../../../shared/pricing-overrides.js";
import type { AppSettings } from "../types.js";

/**
 * A row mid-edit. Rates are strings because "" and "1." are states a number
 * input passes through on the way to a value, and holding them as numbers
 * would round-trip them into `NaN` or `0` under the user's cursor.
 */
interface DraftRow {
  vendor: string;
  model: string;
  inputPer1M: string;
  outputPer1M: string;
}

const BLANK_ROW: DraftRow = {
  vendor: PRICING_VENDORS[0],
  model: "",
  inputPer1M: "",
  outputPer1M: "",
};

function toDraft(overrides: readonly PricingOverride[]): DraftRow[] {
  return overrides.map((entry) => ({
    vendor: entry.vendor,
    model: entry.model,
    inputPer1M: String(entry.inputPer1M),
    outputPer1M: String(entry.outputPer1M),
  }));
}

function rowRate(raw: string): number {
  return raw.trim() === "" ? Number.NaN : Number(raw);
}

function isRowComplete(row: DraftRow): boolean {
  return (
    row.vendor.trim() !== ""
    && row.model.trim() !== ""
    && isPricingOverrideRate(rowRate(row.inputPer1M))
    && isPricingOverrideRate(rowRate(row.outputPer1M))
  );
}

function toOverrides(rows: readonly DraftRow[]): PricingOverride[] {
  return rows.filter(isRowComplete).map((row) => ({
    vendor: row.vendor.trim(),
    model: row.model.trim(),
    inputPer1M: rowRate(row.inputPer1M),
    outputPer1M: rowRate(row.outputPer1M),
  }));
}

function sameAsSaved(rows: readonly DraftRow[], saved: readonly PricingOverride[]): boolean {
  return JSON.stringify(toOverrides(rows)) === JSON.stringify(saved);
}

export function PricingOverridesSection() {
  const { t } = useTranslation();
  const api = getApi();
  const envForcedPaths = useEnvForcedSettings(api);
  const envForced = envForcedPaths.includes("llm.pricingOverrides");

  const [loaded, setLoaded] = useState(false);
  const [saved, setSaved] = useState<readonly PricingOverride[]>([]);
  const [rows, setRows] = useState<DraftRow[]>([]);

  const applySnapshot = useCallback((s: AppSettings) => {
    const next = s.llm?.pricingOverrides ?? [];
    setSaved(next);
    // Reseed the table only when the stored list actually moved — this runs on
    // every settings broadcast, including ones caused by unrelated tabs, and
    // must not wipe rows the user is halfway through entering.
    setRows((current) => (
      JSON.stringify(toOverrides(current)) === JSON.stringify(next) ? current : toDraft(next)
    ));
    setLoaded(true);
  }, []);

  useEffect(() => {
    let alive = true;
    void api.getSettings().then((s) => { if (alive) applySnapshot(s); });
    const unsub = api.onSettingsUpdated((s) => applySnapshot(s));
    return () => { alive = false; unsub(); };
  }, [api, applySnapshot]);

  const editRow = useCallback((index: number, patch: Partial<DraftRow>) => {
    setRows((current) => current.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  }, []);

  const removeRow = useCallback((index: number) => {
    setRows((current) => current.filter((_, i) => i !== index));
  }, []);

  const addRow = useCallback(() => {
    setRows((current) => [...current, { ...BLANK_ROW }]);
  }, []);

  const save = useCallback(() => {
    const next = toOverrides(rows);
    setSaved(next);
    setRows(toDraft(next));
    void api.updateSettings({ llm: { pricingOverrides: next } });
  }, [api, rows]);

  const incomplete = rows.some((row) => !isRowComplete(row));
  const disabled = !loaded || envForced;

  return (
    <SettingsSection
      title={t("llmTab.pricingOverridesTitle")}
      description={t("llmTab.pricingOverridesDesc")}
    >
      <p className="text-xs text-muted-foreground" data-testid="llm-pricing-overrides-help">
        {t("llmTab.pricingOverridesHelp")}
      </p>
      <EnvForcedNotice
        settingsPath="llm.pricingOverrides"
        forcedPaths={envForcedPaths}
        messageKey="llmTab.pricingOverridesEnvForced"
        testId="llm-pricing-overrides-forced"
        className="mt-2"
      />

      {rows.length === 0 ? (
        <p className="mt-3 text-xs text-muted-foreground" data-testid="llm-pricing-overrides-empty">
          {t("llmTab.pricingOverridesEmpty")}
        </p>
      ) : (
        <div className="mt-3 space-y-2" data-testid="llm-pricing-overrides-rows">
          <div className="grid grid-cols-[minmax(0,9rem)_minmax(0,1fr)_minmax(0,6rem)_minmax(0,6rem)_auto] gap-2 text-[11px] text-muted-foreground">
            <span>{t("llmTab.pricingOverridesColVendor")}</span>
            <span>{t("llmTab.pricingOverridesColModel")}</span>
            <span>{t("llmTab.pricingOverridesColInput")}</span>
            <span>{t("llmTab.pricingOverridesColOutput")}</span>
            <span className="sr-only">{t("common.delete")}</span>
          </div>
          {rows.map((row, index) => (
            <div
              key={index}
              className="grid grid-cols-[minmax(0,9rem)_minmax(0,1fr)_minmax(0,6rem)_minmax(0,6rem)_auto] items-center gap-2"
            >
              <NativeSelect
                size="sm"
                value={row.vendor}
                disabled={disabled}
                onChange={(e) => editRow(index, { vendor: e.target.value })}
                aria-label={t("llmTab.pricingOverridesColVendor")}
                data-testid={`llm-pricing-override-vendor-${index}`}
              >
                {PRICING_VENDORS.map((vendor) => (
                  <NativeSelectOption key={vendor} value={vendor}>{vendor}</NativeSelectOption>
                ))}
              </NativeSelect>
              <Input
                value={row.model}
                disabled={disabled}
                placeholder={t("llmTab.pricingOverridesModelPlaceholder")}
                onChange={(e) => editRow(index, { model: e.target.value })}
                aria-label={t("llmTab.pricingOverridesColModel")}
                data-testid={`llm-pricing-override-model-${index}`}
              />
              <Input
                value={row.inputPer1M}
                disabled={disabled}
                inputMode="decimal"
                onChange={(e) => editRow(index, { inputPer1M: e.target.value })}
                aria-label={t("llmTab.pricingOverridesColInput")}
                data-testid={`llm-pricing-override-input-${index}`}
              />
              <Input
                value={row.outputPer1M}
                disabled={disabled}
                inputMode="decimal"
                onChange={(e) => editRow(index, { outputPer1M: e.target.value })}
                aria-label={t("llmTab.pricingOverridesColOutput")}
                data-testid={`llm-pricing-override-output-${index}`}
              />
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={disabled}
                onClick={() => removeRow(index)}
                data-testid={`llm-pricing-override-remove-${index}`}
              >
                {t("common.delete")}
              </Button>
            </div>
          ))}
        </div>
      )}

      <div className="mt-3 flex items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={disabled}
          onClick={addRow}
          data-testid="llm-pricing-override-add"
        >
          {t("llmTab.pricingOverridesAdd")}
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={disabled || incomplete || sameAsSaved(rows, saved)}
          onClick={save}
          data-testid="llm-pricing-override-save"
        >
          {t("common.save")}
        </Button>
        {incomplete && (
          <Label className="text-[11px] text-warning" data-testid="llm-pricing-override-incomplete">
            {t("llmTab.pricingOverridesIncomplete")}
          </Label>
        )}
      </div>
    </SettingsSection>
  );
}
