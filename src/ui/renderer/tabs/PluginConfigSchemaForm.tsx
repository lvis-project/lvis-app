/**
 * §9.2 Track B — auto-rendered settings form for plugins that declare a
 * `configSchema` in their manifest.
 *
 * Mapping rule:
 *   string                       → <Input type="text" />
 *   string + format:"secret"     → masked <Input type="password" /> stored
 *                                  via lvis.pluginConfig.setSecret (NEVER
 *                                  in cleartext pluginConfigs)
 *   string + enum:[...]          → <NativeSelect>
 *   number / integer             → <Input type="number" />
 *   boolean                      → <Checkbox> toggle
 *   array of string              → tag-style multi input (comma split)
 *
 * Save semantics (post-2026-05-16 UX overhaul):
 *   - Checkbox (boolean) + NativeSelect (enum) — apply on change with a
 *     200ms trailing debounce. Rapid toggles collapse into a single
 *     `pluginConfig.set` (which triggers a plugin restart), so user gets
 *     immediate feel without restart spam.
 *   - Text / number / array inputs — edit a local draft and only persist
 *     when the section "변경사항 저장" button is clicked.
 *   - Secret fields — per-field 저장 button on a separate IPC path
 *     (`pluginConfig.setSecret`). Never enters the cleartext draft.
 *
 * The form falls back gracefully when a property type is unknown — the
 * field is rendered as a read-only display so the user is not silently
 * locked out of declared settings.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "../../../components/ui/button.js";
import { Checkbox } from "../../../components/ui/checkbox.js";
import { Input } from "../../../components/ui/input.js";
import { Label } from "../../../components/ui/label.js";
import { NativeSelect, NativeSelectOption } from "../../../components/ui/native-select.js";
import type { PluginConfigSchemaPropertySummary, PluginConfigSchemaSummary } from "../types.js";

export type PluginConfigFormValues = Record<string, unknown>;

export interface PluginConfigSchemaFormProps {
  pluginId: string;
  schema: PluginConfigSchemaSummary;
  /** Saved + default-merged config values (cleartext only — secrets handled separately). */
  values: PluginConfigFormValues;
  /** Per-secret-key indicator: true when the keychain holds a value for this key. */
  secretsPresent: Record<string, boolean>;
  saving?: boolean;
  onSave: (values: PluginConfigFormValues) => Promise<void> | void;
  onSetSecret: (key: string, value: string) => Promise<void> | void;
}

/** Debounce window for immediate-apply controls (toggle / enum select). */
const IMMEDIATE_SAVE_DEBOUNCE_MS = 200;

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
      return `최소 ${prop.minLength}자 이상이어야 합니다.`;
    }
    if (prop.maxLength !== undefined && value.length > prop.maxLength) {
      return `최대 ${prop.maxLength}자까지 입력할 수 있습니다.`;
    }
    if (prop.pattern) {
      try {
        const re = new RegExp(prop.pattern);
        if (!re.test(value)) return `패턴 (${prop.pattern}) 에 맞지 않습니다.`;
      } catch {
        // bad pattern — schema author error; surface gracefully
        return `패턴 표현식이 잘못되었습니다: ${prop.pattern}`;
      }
    }
  }
  if ((prop.type === "number" || prop.type === "integer") && typeof value === "number") {
    if (prop.minimum !== undefined && value < prop.minimum) {
      return `최소값 ${prop.minimum} 이상이어야 합니다.`;
    }
    if (prop.maximum !== undefined && value > prop.maximum) {
      return `최대값 ${prop.maximum} 이하이어야 합니다.`;
    }
  }
  return null;
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
  saving,
  onSave,
  onSetSecret,
}: PluginConfigSchemaFormProps) {
  const properties = schema.properties ?? {};
  const propertyKeys = useMemo(() => Object.keys(properties), [properties]);
  const [draft, setDraft] = useState<PluginConfigFormValues>(() => ({ ...values }));
  // Re-sync draft when `values` reference changes — the parent's saved-config
  // fetch is async and resolves AFTER this form first mounts, so the lazy
  // `useState` initializer runs against an empty `values` and locks the form
  // into a blank state. PluginConfigTab memoizes `values` on
  // [selectedPlugin, savedConfig], so this only fires on plugin switch or
  // post-save refresh — not on every keystroke.
  useEffect(() => {
    setDraft({ ...values });
  }, [values]);
  const [secretDrafts, setSecretDrafts] = useState<Record<string, string>>({});
  const [secretSaving, setSecretSaving] = useState<Record<string, boolean>>({});
  const required = new Set(schema.required ?? []);

  // Trailing-edge debounce for immediate-apply controls. Rapid toggles
  // are collapsed into a single onSave so we don't fire one plugin
  // restart per click.
  const autoSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current);
    },
    [],
  );

  const buildOut = useCallback(
    (source: PluginConfigFormValues): PluginConfigFormValues => {
      const out: PluginConfigFormValues = {};
      for (const key of propertyKeys) {
        const prop = properties[key];
        if (prop.type === "string" && prop.format === "secret") continue;
        const v = source[key];
        if (v === undefined || v === "") continue;
        out[key] = v;
      }
      return out;
    },
    [properties, propertyKeys],
  );

  const saveDraft = useCallback(
    async (source: PluginConfigFormValues) => {
      await onSave(buildOut(source));
    },
    [buildOut, onSave],
  );

  const handleManualSave = useCallback(() => {
    if (autoSaveTimer.current) {
      clearTimeout(autoSaveTimer.current);
      autoSaveTimer.current = null;
    }
    void saveDraft(draft);
  }, [draft, saveDraft]);

  /** Update + schedule auto-save (200ms debounce). For toggle/enum. */
  const updateImmediate = useCallback(
    (key: string, value: unknown) => {
      setDraft((prev) => {
        const next = { ...prev, [key]: value };
        if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current);
        autoSaveTimer.current = setTimeout(() => {
          autoSaveTimer.current = null;
          void saveDraft(next);
        }, IMMEDIATE_SAVE_DEBOUNCE_MS);
        return next;
      });
    },
    [saveDraft],
  );

  /** Update local draft only. For text/number/array — explicit save. */
  const updateDraft = useCallback((key: string, value: unknown) => {
    setDraft((prev) => ({ ...prev, [key]: value }));
  }, []);

  const handleSetSecret = useCallback(
    async (key: string) => {
      const value = secretDrafts[key] ?? "";
      setSecretSaving((prev) => ({ ...prev, [key]: true }));
      try {
        await onSetSecret(key, value);
        setSecretDrafts((prev) => ({ ...prev, [key]: "" }));
      } finally {
        setSecretSaving((prev) => ({ ...prev, [key]: false }));
      }
    },
    [secretDrafts, onSetSecret],
  );

  // Only show the section-level "변경사항 저장" button when there is at
  // least one explicit-save field (text/number/array). Pure toggle/enum
  // forms auto-save and the button would just be visual noise.
  const hasExplicitSaveFields = propertyKeys.some((key) => {
    const prop = properties[key];
    if (prop.type === "string" && prop.format === "secret") return false;
    if (prop.type === "boolean") return false;
    if (prop.enum) return false;
    return true;
  });

  return (
    <div data-testid={`plugin-config-form:${pluginId}`} className="flex flex-col gap-3">
      {propertyKeys.length === 0 && (
        <p className="text-xs text-muted-foreground">선언된 설정 필드가 없습니다.</p>
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
              <div className="flex items-center gap-2">
                <Input
                  id={fieldId}
                  type="password"
                  className="h-7 text-xs flex-1"
                  placeholder={secretsPresent[key] ? "**** (저장됨)" : "값을 입력하세요"}
                  value={secretDrafts[key] ?? ""}
                  onChange={(e) =>
                    setSecretDrafts((prev) => ({ ...prev, [key]: e.target.value }))
                  }
                />
                <Button
                  size="sm"
                  className="h-7 text-xs px-2"
                  onClick={() => void handleSetSecret(key)}
                  disabled={Boolean(secretSaving[key])}
                  data-testid={`${fieldId}:save`}
                >
                  {secretSaving[key] ? "저장 중…" : "저장"}
                </Button>
              </div>
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
                  선택…
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
                <span className="text-muted-foreground">{label} 활성화</span>
              </Label>
            ) : prop.type === "array" && prop.items?.type === "string" ? (
              <Input
                id={fieldId}
                className="h-7 text-xs"
                placeholder="쉼표로 구분"
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
              />
            ) : prop.type === "number" || prop.type === "integer" ? (
              <Input
                id={fieldId}
                type="number"
                className="h-7 text-xs"
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
                step={prop.type === "integer" ? 1 : "any"}
                min={prop.minimum}
                max={prop.maximum}
              />
            ) : (
              <Input
                id={fieldId}
                className="h-7 text-xs"
                value={typeof value === "string" ? value : (prop.default as string | undefined) ?? ""}
                onChange={(e) => updateDraft(key, e.target.value)}
                maxLength={prop.maxLength}
              />
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
          이 플러그인은 추가 설정 패널 ({schema.customPanel.exportName}) 을 제공합니다.
          향후 UI Slot System(§9.3) 을 통해 자동 마운트될 예정입니다.
        </div>
      )}
      {hasExplicitSaveFields && (
        <div className="flex items-center justify-between gap-3 border-t border-border/40 pt-2">
          <p className="text-[10px] text-muted-foreground">
            토글 · 드롭다운은 자동 저장됩니다. 입력 필드는 변경 후 우측 버튼으로 저장하세요.
          </p>
          <Button
            size="sm"
            onClick={handleManualSave}
            disabled={Boolean(saving)}
            data-testid={`plugin-config-form:${pluginId}:save`}
          >
            {saving ? "저장 중…" : "변경사항 저장"}
          </Button>
        </div>
      )}
    </div>
  );
}
