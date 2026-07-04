



import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "../../../components/ui/button.js";
import { Checkbox } from "../../../components/ui/checkbox.js";
import { Input } from "../../../components/ui/input.js";
import { Label } from "../../../components/ui/label.js";
import { NativeSelect, NativeSelectOption } from "../../../components/ui/native-select.js";
import type { PluginConfigSchemaPropertySummary, PluginConfigSchemaSummary } from "../types.js";
import { useTranslation } from "../../../i18n/react.js";
import { t } from "../../../i18n/runtime.js";
export type PluginConfigFormValues = Record<string, unknown>;

export interface PluginConfigSchemaFormProps {
  pluginId: string;
  schema: PluginConfigSchemaSummary;
  /** Saved + default-merged config values (cleartext only — secrets handled separately). */
  values: PluginConfigFormValues;
  /** Per-secret-key indicator: true when the keychain holds a value for this key. */
  secretsPresent: Record<string, boolean>;
  onSave: (values: PluginConfigFormValues) => Promise<void> | void;
  onSetSecret: (key: string, value: string) => Promise<void> | void;
}

function deriveLabel(key: string, prop: PluginConfigSchemaPropertySummary): string {
  return prop.title?.trim() || key;
}

function coerceNumber(raw: string, prop: PluginConfigSchemaPropertySummary): number | undefined {
  if (raw === "") return undefined;
  const parsed = prop.type === "integer" ? Number.parseInt(raw, 10) : Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function fieldError(prop: PluginConfigSchemaPropertySummary, value: unknown): string | null {
  if (value === undefined || value === "") return null;
  if (prop.type === "string" && typeof value === "string") {
    if (prop.minLength !== undefined && value.length < prop.minLength) {
      return t("pluginConfigSchemaForm.errorMinLength", { minLength: prop.minLength });
    }
    if (prop.maxLength !== undefined && value.length > prop.maxLength) {
      return t("pluginConfigSchemaForm.errorMaxLength", { maxLength: prop.maxLength });
    }
    if (prop.pattern) {
      try {
        const re = new RegExp(prop.pattern);
        if (!re.test(value)) return t("pluginConfigSchemaForm.errorPatternMismatch", { pattern: prop.pattern });
      } catch {
        // bad pattern — schema author error; surface gracefully
        return t("pluginConfigSchemaForm.errorPatternInvalid", { pattern: prop.pattern });
      }
    }
  }
  if ((prop.type === "number" || prop.type === "integer") && typeof value === "number") {
    if (prop.minimum !== undefined && value < prop.minimum) {
      return t("pluginConfigSchemaForm.errorMinValue", { minimum: prop.minimum });
    }
    if (prop.maximum !== undefined && value > prop.maximum) {
      return t("pluginConfigSchemaForm.errorMaxValue", { maximum: prop.maximum });
    }
  }
  return null;
}

function isSameConfigValue(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  return a === b;
}

/**
 * Render a typed form for the plugin's declared `configSchema`. The form
 * keeps secret fields and cleartext fields strictly separate: cleartext
 * values flow through `onSave`, secret writes go through `onSetSecret`
 * one key at a time so the value never sits in the cleartext settings
 * payload.
 */
export function PluginConfigSchemaForm({
  pluginId,
  schema,
  values,
  secretsPresent,
  onSave,
  onSetSecret,
}: PluginConfigSchemaFormProps) {
  const { t } = useTranslation();
  const properties = schema.properties ?? {};
  const propertyKeys = useMemo(() => Object.keys(properties), [properties]);
  const [draft, setDraft] = useState<PluginConfigFormValues>(() => ({ ...values }));
  const dirtyKeysRef = useRef<Set<string>>(new Set());
  // Resync rule:
  //  - On plugin SWITCH (pluginId changed): hard reset draft to the new
  //    plugin's saved values + clear secret drafts. Drafts from a previous
  //    plugin must not bleed into the next one.
  //  - On values CHANGE (same plugin — e.g. after a per-field save commits
  //    or a cross-window broadcast arrives): merge in the new saved values
  //    BUT preserve any field the user has typed-but-not-yet-saved. Without
  //    this preservation, saving field A would re-fire this effect with the
  //    parent's updated `values` and clobber the unsaved drafts of B / C /…
  //    causing silent data loss (per-field save's whole point is per-field).
  const prevPluginIdRef = useRef(pluginId);
  useEffect(() => {
    if (prevPluginIdRef.current !== pluginId) {
      dirtyKeysRef.current = new Set();
      setDraft({ ...values });
      setSecretDrafts({});
      prevPluginIdRef.current = pluginId;
      return;
    }
    setDraft((prev) => {
      const next = { ...values };
      const nextDirtyKeys = new Set<string>();
      for (const key of dirtyKeysRef.current) {
        const prop = properties[key];
        if (!prop) continue;
        if (prop.type === "string" && prop.format === "secret") continue;
        if (prev[key] === undefined) continue;
        const draftV = prev[key];
        const savedV = values[key];
        if (!isSameConfigValue(draftV, savedV)) {
          next[key] = draftV;
          nextDirtyKeys.add(key);
        }
      }
      dirtyKeysRef.current = nextDirtyKeys;
      return next;
    });
  }, [pluginId, values, properties]);
  const [secretDrafts, setSecretDrafts] = useState<Record<string, string>>({});
  /** Per-key saving indicator — drives the inline Save button's loading state
   *  on text / number / array / secret fields. Toggle / enum auto-save uses
   *  the parent's `saving` prop. */
  const [fieldSaving, setFieldSaving] = useState<Record<string, boolean>>({});
  const required = new Set(schema.required ?? []);

  // Build a single-key cleartext payload — uses `values` (the saved baseline)
  // for every key EXCEPT `nextKey`, which takes `nextValue`. This is critical:
  // building from `draft` would side-effect-persist other dirty text fields
  // when the user clicks Save on just one — silently committing values the
  // user never confirmed. Secrets are stripped (separate IPC), empty/undefined
  // dropped so `default` falls back at read time.
  const buildSingleKeyPayload = useCallback(
    (nextKey: string, nextValue: unknown): PluginConfigFormValues => {
      const out: PluginConfigFormValues = {};
      for (const key of propertyKeys) {
        const prop = properties[key];
        if (prop.type === "string" && prop.format === "secret") continue;
        const v = key === nextKey ? nextValue : values[key];
        if (v === undefined || v === "") continue;
        out[key] = v;
      }
      return out;
    },
    [properties, propertyKeys, values],
  );

  // Toggle/enum auto-save — fires onSave immediately for the changed key
  // only. The previous debounced full-draft save was retired because it
  // also caused cross-field bleed (same root cause as buildSingleKeyPayload).
  // Toggle/enum interactions are typically one click at a time, so the
  // 200ms debounce is unnecessary; remove it to keep semantics clean.
  const updateImmediate = useCallback(
    (key: string, value: unknown) => {
      dirtyKeysRef.current.add(key);
      setDraft((prev) => ({ ...prev, [key]: value }));
      void onSave(buildSingleKeyPayload(key, value));
    },
    [buildSingleKeyPayload, onSave],
  );

  /** Text/number/array — set draft only; explicit per-field Save button persists. */
  const updateDraft = useCallback((key: string, value: unknown) => {
    dirtyKeysRef.current.add(key);
    setDraft((prev) => ({ ...prev, [key]: value }));
  }, []);

  /** Per-field cleartext save — text/number/array. Only this field's value
   *  is committed; other dirty drafts stay in local state (not persisted).
   *  Errors are owned by the parent's onSave (which already surfaces a
   *  toast); we only ensure the saving indicator clears on either path. */
  const saveField = useCallback(
    async (key: string) => {
      setFieldSaving((p) => ({ ...p, [key]: true }));
      try {
        await onSave(buildSingleKeyPayload(key, draft[key]));
      } catch {
        // Parent shows a banner; nothing more to do here.
      } finally {
        setFieldSaving((p) => ({ ...p, [key]: false }));
      }
    },
    [buildSingleKeyPayload, draft, onSave],
  );

  /** Per-field secret save — text/password input, routes to keychain. */
  const saveSecretField = useCallback(
    async (key: string) => {
      const value = secretDrafts[key] ?? "";
      setFieldSaving((p) => ({ ...p, [key]: true }));
      try {
        await onSetSecret(key, value);
        setSecretDrafts((p) => ({ ...p, [key]: "" }));
      } catch {
        // Parent shows a banner; preserve the draft so the user can retry.
      } finally {
        setFieldSaving((p) => ({ ...p, [key]: false }));
      }
    },
    [secretDrafts, onSetSecret],
  );

  /** Dirty check for cleartext fields — draft differs from saved `values`. */
  const isCleartextDirty = useCallback(
    (key: string): boolean => {
      const draftVal = draft[key];
      const savedVal = values[key];
      return !isSameConfigValue(draftVal, savedVal);
    },
    [draft, values],
  );

  return (
    <div data-testid={`plugin-config-form:${pluginId}`} className="flex flex-col gap-3">
      {propertyKeys.length === 0 && (
        <p className="text-xs text-muted-foreground">{t("pluginConfigSchemaForm.noFields")}</p>
      )}
      {propertyKeys.map((key) => {
        const prop = properties[key];
        const label = deriveLabel(key, prop);
        const isSecret = prop.type === "string" && prop.format === "secret";
        const fieldId = `pcfg:${pluginId}:${key}`;
        const value = draft[key];
        const error = !isSecret ? fieldError(prop, value) : null;
        return (
          <div key={key} className="flex flex-col gap-1">
            <Label htmlFor={fieldId} className="text-xs font-medium">
              {label}
              {required.has(key) && <span className="ml-1 text-destructive">*</span>}
              <span className="ml-2 font-mono text-[10px] text-muted-foreground">{key}</span>
            </Label>
            {prop.description && (
              <p className="text-[11px] text-muted-foreground">{prop.description}</p>
            )}
            {isSecret ? (
              <>
                <div className="flex items-center gap-2">
                  <Input
                    id={fieldId}
                    type="password"
                    className="h-7 text-xs flex-1"
                    placeholder={secretsPresent[key] ? t("pluginConfigSchemaForm.secretSavedPlaceholder") : t("pluginConfigSchemaForm.secretInputPlaceholder")}
                    value={secretDrafts[key] ?? ""}
                    onChange={(e) =>
                      setSecretDrafts((prev) => ({ ...prev, [key]: e.target.value }))
                    }
                    data-testid={`${fieldId}:input`}
                  />
                  <Button
                    size="sm"
                    className="h-7 text-xs px-2 shrink-0"
                    onClick={() => void saveSecretField(key)}
                    disabled={!(secretDrafts[key]?.length ?? 0) || Boolean(fieldSaving[key])}
                    data-testid={`${fieldId}:save`}
                  >
                    {fieldSaving[key] ? t("pluginConfigSchemaForm.saving") : t("pluginConfigSchemaForm.save")}
                  </Button>
                </div>
                <p className="text-[10px] text-muted-foreground">
                  {t("pluginConfigSchemaForm.secretKeychainNote")}
                </p>
              </>
            ) : prop.enum ? (
              <NativeSelect
                id={fieldId}
                size="sm"
                className="w-full"
                value={(value ?? prop.default ?? "") as string | number}
                onChange={(e) => {
                  const raw = e.target.value;
                  const next: unknown =
                    prop.type === "number" || prop.type === "integer"
                      ? coerceNumber(raw, prop)
                      : prop.type === "boolean"
                        ? raw === "true"
                        : raw;
                  updateImmediate(key, next);
                }}
              >
                <NativeSelectOption value="" disabled>
                  {t("pluginConfigSchemaForm.selectPlaceholder")}
                </NativeSelectOption>
                {prop.enum.map((option) => (
                  <NativeSelectOption key={String(option)} value={String(option)}>
                    {String(option)}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            ) : prop.type === "boolean" ? (
              <Label className="flex items-center gap-2 text-xs">
                <Checkbox
                  id={fieldId}
                  checked={Boolean(value ?? prop.default ?? false)}
                  onCheckedChange={(checked) => updateImmediate(key, checked === true)}
                />
                <span className="text-muted-foreground">{t("pluginConfigSchemaForm.enableLabel", { label })}</span>
              </Label>
            ) : prop.type === "array" && prop.items?.type === "string" ? (
              <div className="flex items-center gap-2">
                <Input
                  id={fieldId}
                  className="h-7 text-xs flex-1"
                  placeholder={t("pluginConfigSchemaForm.arrayPlaceholder")}
                  value={
                    Array.isArray(value)
                      ? value.join(", ")
                      : Array.isArray(prop.default)
                        ? (prop.default as unknown[]).join(", ")
                        : ""
                  }
                  onChange={(e) => {
                    const tokens = e.target.value
                      .split(",")
                      .map((s) => s.trim())
                      .filter((s) => s.length > 0);
                    updateDraft(key, tokens);
                  }}
                  onKeyDown={(e) => { if (e.key === "Enter" && isCleartextDirty(key)) void saveField(key); }}
                />
                <Button
                  size="sm"
                  className="h-7 text-xs px-2 shrink-0"
                  onClick={() => void saveField(key)}
                  disabled={!isCleartextDirty(key) || Boolean(fieldSaving[key])}
                  data-testid={`${fieldId}:save`}
                >
                  {fieldSaving[key] ? t("pluginConfigSchemaForm.saving") : t("pluginConfigSchemaForm.save")}
                </Button>
              </div>
            ) : prop.type === "number" || prop.type === "integer" ? (
              <div className="flex items-center gap-2">
                <Input
                  id={fieldId}
                  type="number"
                  className="h-7 text-xs flex-1"
                  value={
                    typeof value === "number"
                      ? String(value)
                      : typeof prop.default === "number"
                        ? String(prop.default)
                        : ""
                  }
                  onChange={(e) => {
                    const next = coerceNumber(e.target.value, prop);
                    updateDraft(key, next);
                  }}
                  onKeyDown={(e) => { if (e.key === "Enter" && isCleartextDirty(key)) void saveField(key); }}
                  step={prop.type === "integer" ? 1 : "any"}
                  min={prop.minimum}
                  max={prop.maximum}
                />
                <Button
                  size="sm"
                  className="h-7 text-xs px-2 shrink-0"
                  onClick={() => void saveField(key)}
                  disabled={!isCleartextDirty(key) || Boolean(fieldSaving[key])}
                  data-testid={`${fieldId}:save`}
                >
                  {fieldSaving[key] ? t("pluginConfigSchemaForm.saving") : t("pluginConfigSchemaForm.save")}
                </Button>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <Input
                  id={fieldId}
                  className="h-7 text-xs flex-1"
                  value={typeof value === "string" ? value : (prop.default as string | undefined) ?? ""}
                  onChange={(e) => updateDraft(key, e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter" && isCleartextDirty(key)) void saveField(key); }}
                  maxLength={prop.maxLength}
                />
                <Button
                  size="sm"
                  className="h-7 text-xs px-2 shrink-0"
                  onClick={() => void saveField(key)}
                  disabled={!isCleartextDirty(key) || Boolean(fieldSaving[key])}
                  data-testid={`${fieldId}:save`}
                >
                  {fieldSaving[key] ? t("pluginConfigSchemaForm.saving") : t("pluginConfigSchemaForm.save")}
                </Button>
              </div>
            )}
            {error && <p className="text-[11px] text-destructive">{error}</p>}
          </div>
        );
      })}
      {schema.customPanel && (
        <div
          className="rounded-md border border-dashed p-2 text-[11px] text-muted-foreground"
          data-testid={`${pluginId}:custom-panel-placeholder`}
        >
          {t("pluginConfigSchemaForm.customPanelNote", { exportName: schema.customPanel.exportName })}
        </div>
      )}
      {/* No bottom batch button — text/number/array/secret fields each have
          their own inline Save button; toggle/enum still auto-save. */}
    </div>
  );
}
