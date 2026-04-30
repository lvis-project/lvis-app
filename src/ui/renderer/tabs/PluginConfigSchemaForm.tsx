/**
 * §9.2 Track B — auto-rendered settings form for plugins that declare a
 * `configSchema` in their manifest.
 *
 * Mapping rule:
 *   string                       → <Input type="text" />
 *   string + format:"secret"     → masked <Input type="password" /> stored
 *                                  via lvis.pluginConfig.setSecret (NEVER
 *                                  in cleartext pluginConfigs)
 *   string + enum:[...]          → <select>
 *   number / integer             → <Input type="number" />
 *   boolean                      → checkbox toggle
 *   array of string              → tag-style multi input (comma split)
 *
 * The form falls back gracefully when a property type is unknown — the
 * field is rendered as a read-only display so the user is not silently
 * locked out of declared settings.
 */
import { useCallback, useMemo, useState } from "react";
import { Button } from "../../../components/ui/button.js";
import { Input } from "../../../components/ui/input.js";
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
  const [secretDrafts, setSecretDrafts] = useState<Record<string, string>>({});
  const [secretSaving, setSecretSaving] = useState<Record<string, boolean>>({});
  const required = new Set(schema.required ?? []);

  const handleSave = useCallback(async () => {
    // Strip secret fields — they have a dedicated path. Anything else is
    // saved together so plugins always see a single coherent commit.
    const out: PluginConfigFormValues = {};
    for (const key of propertyKeys) {
      const prop = properties[key];
      if (prop.type === "string" && prop.format === "secret") continue;
      const v = draft[key];
      if (v === undefined || v === "") {
        if (required.has(key)) {
          // surface as a top-level alert by leaving the value out — the
          // host's AJV validator will reject and return a structured
          // message.
        }
        continue;
      }
      out[key] = v;
    }
    await onSave(out);
  }, [draft, properties, propertyKeys, required, onSave]);

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
            <label htmlFor={fieldId} className="text-xs font-medium">
              {label}
              {required.has(key) && <span className="ml-1 text-red-500">*</span>}
              <span className="ml-2 font-mono text-[10px] text-muted-foreground">{key}</span>
            </label>
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
              <select
                id={fieldId}
                className="h-7 rounded-md border bg-background px-2 text-xs"
                value={(value ?? prop.default ?? "") as string | number}
                onChange={(e) => {
                  const raw = e.target.value;
                  const next: unknown =
                    prop.type === "number" || prop.type === "integer"
                      ? coerceNumber(raw, prop)
                      : prop.type === "boolean"
                        ? raw === "true"
                        : raw;
                  setDraft((prev) => ({ ...prev, [key]: next }));
                }}
              >
                <option value="" disabled>
                  선택…
                </option>
                {prop.enum.map((option) => (
                  <option key={String(option)} value={String(option)}>
                    {String(option)}
                  </option>
                ))}
              </select>
            ) : prop.type === "boolean" ? (
              <label className="flex items-center gap-2 text-xs">
                <input
                  id={fieldId}
                  type="checkbox"
                  checked={Boolean(value ?? prop.default ?? false)}
                  onChange={(e) => setDraft((prev) => ({ ...prev, [key]: e.target.checked }))}
                />
                <span className="text-muted-foreground">{label} 활성화</span>
              </label>
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
                  setDraft((prev) => ({ ...prev, [key]: tokens }));
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
                  setDraft((prev) => ({ ...prev, [key]: next }));
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
                onChange={(e) => setDraft((prev) => ({ ...prev, [key]: e.target.value }))}
                maxLength={prop.maxLength}
              />
            )}
            {error && <p className="text-[11px] text-red-600">{error}</p>}
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
      <div className="flex justify-end">
        <Button size="sm" onClick={() => void handleSave()} disabled={Boolean(saving)}>
          {saving ? "저장 중…" : "저장"}
        </Button>
      </div>
    </div>
  );
}
