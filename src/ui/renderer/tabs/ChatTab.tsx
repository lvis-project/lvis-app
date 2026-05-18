import { useCallback, useEffect, useState } from "react";
import { PrivacyTab } from "./PrivacyTab.js";
import { Checkbox } from "../../../components/ui/checkbox.js";
import { Label } from "../../../components/ui/label.js";
import { RadioGroup, RadioGroupItem } from "../../../components/ui/radio-group.js";
import { SettingsPageHeader } from "../components/SettingsPageHeader.js";
import { SettingsSection } from "../components/SettingsSection.js";
import type { LoginVariant, LvisApi } from "../types.js";

export interface ChatTabProps {
  /**
   * Tutorial-A — passing `api` lets the tab read/write the persisted
   * login-screen variant through the existing IPC bridge (`loginPrefsGet`
   * / `loginPrefsSet`). The tab degrades gracefully when `api` is absent
   * (older test renderers) by hiding the toggle.
   */
  api?: LvisApi;
  autoCompact: boolean;
  setAutoCompact: (updater: boolean | ((prev: boolean) => boolean)) => void;
  streamSmoothing: "none" | "word" | "char";
  setStreamSmoothing: (v: "none" | "word" | "char") => void;
  idlePreferenceRefresh?: boolean;
  setIdlePreferenceRefresh?: (v: boolean) => void;
  piiRedactEnabled: boolean;
  onPiiRedactToggle: () => void;
  settingsLoaded: boolean;
  /** Debounced immediate-apply hook for chat settings saved through the chat payload. */
  onImmediateChange?: () => void;
}

export function ChatTab({
  api,
  autoCompact,
  setAutoCompact,
  streamSmoothing,
  setStreamSmoothing,
  idlePreferenceRefresh,
  setIdlePreferenceRefresh,
  piiRedactEnabled,
  onPiiRedactToggle,
  settingsLoaded,
  onImmediateChange,
}: ChatTabProps) {
  // Memoize the wrapped onToggle so PrivacyTab receives a stable identity
  // across re-renders — if PrivacyTab ever memoizes via React.memo / props
  // comparison, an inline arrow would defeat it.
  const handlePiiRedactToggle = useCallback(() => {
    onPiiRedactToggle();
    onImmediateChange?.();
  }, [onPiiRedactToggle, onImmediateChange]);

  // Tutorial-A — login screen variant state. Read on mount, kept in sync
  // via the same IPC change event the LoginModal wrapper subscribes to so
  // a flip from Settings stays consistent with what the user just chose.
  const [loginVariant, setLoginVariant] = useState<LoginVariant | null>(null);
  const [loginVariantSaving, setLoginVariantSaving] = useState(false);
  const [loginVariantError, setLoginVariantError] = useState<string | null>(null);

  useEffect(() => {
    if (!api) return;
    let cancelled = false;
    void (async () => {
      try {
        const result = await api.loginPrefsGet();
        if (cancelled) return;
        if (result.ok) setLoginVariant(result.prefs.loginVariant);
      } catch {
        // Read failure leaves the radio in indeterminate state until the
        // user picks one; the host returns defaults on next read.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api]);

  useEffect(() => {
    if (!api) return;
    return api.onLoginPrefsChanged((next) => {
      setLoginVariant(next.loginVariant);
    });
  }, [api]);

  const handleLoginVariantChange = useCallback(
    async (next: LoginVariant) => {
      if (!api) return;
      // Optimistic update so the radio reflects the click instantly even
      // before the IPC round-trip resolves; the `changed` broadcast will
      // confirm (or, on failure, the catch branch reverts).
      const previous = loginVariant;
      setLoginVariant(next);
      setLoginVariantSaving(true);
      setLoginVariantError(null);
      try {
        const result = await api.loginPrefsSet({ loginVariant: next });
        if (!result.ok) {
          setLoginVariant(previous);
          setLoginVariantError(
            result.error === "invalid-login-variant"
              ? "선택한 로그인 화면 스타일이 올바르지 않습니다."
              : "로그인 화면 스타일을 저장하지 못했습니다.",
          );
        }
      } catch {
        setLoginVariant(previous);
        setLoginVariantError("로그인 화면 스타일을 저장하지 못했습니다.");
      } finally {
        setLoginVariantSaving(false);
      }
    },
    [api, loginVariant],
  );

  return (
    <div className="space-y-6">
      <SettingsPageHeader
        title="채팅"
        description="자동 컴팩트, 스트리밍 표시, 실험적 기능을 설정합니다"
      />

      <SettingsSection
        title="대화 최적화"
        description="긴 대화에서 이전 히스토리를 자동으로 요약해 컨텍스트를 절약합니다."
      >
        <div className="flex items-center gap-3 rounded-md border px-3 py-3">
          <Checkbox
            checked={autoCompact}
            disabled={!settingsLoaded}
            className="size-5"
            onCheckedChange={(checked) => {
              setAutoCompact(checked === true);
              onImmediateChange?.();
            }}
          />
          <div className="space-y-0.5">
            <p className="text-sm font-medium">자동 컴팩트 활성화</p>
            <p className="text-[11px] text-muted-foreground">끄면 자동 요약은 중단되고, 수동 `/compact`만 사용할 수 있습니다.</p>
          </div>
        </div>
      </SettingsSection>

      <SettingsSection
        title="스트림 부드럽게 표시 (Stream Smoothing)"
        description="출력 스트림을 단어 또는 글자 단위로 부드럽게 표시합니다."
      >
        <RadioGroup
          className="flex gap-4 text-sm"
          value={streamSmoothing}
          disabled={!settingsLoaded}
          onValueChange={(value) => {
            setStreamSmoothing(value as "none" | "word" | "char");
            onImmediateChange?.();
          }}
          aria-label="Stream smoothing"
        >
          {(["none", "word", "char"] as const).map((opt) => (
            <Label key={opt} className="flex items-center gap-1">
              <RadioGroupItem value={opt} />
              {opt === "none" ? "없음" : opt === "word" ? "단어" : "글자"}
            </Label>
          ))}
        </RadioGroup>
      </SettingsSection>

      <SettingsSection
        title="실험적 기능"
        description="기본값 OFF — 설정 즉시 반영됩니다."
      >
        <div className="flex items-center gap-3 rounded-md border px-3 py-3">
          <Checkbox
            checked={idlePreferenceRefresh ?? false}
            disabled={!settingsLoaded}
            data-testid="idle-preference-refresh-toggle"
            className="size-5"
            onCheckedChange={(checked) => {
              setIdlePreferenceRefresh?.(checked === true);
            }}
          />
          <div className="space-y-0.5">
            <p className="text-sm font-medium">Experimental: idle 선호도 자동 갱신</p>
            <p className="text-[11px] text-muted-foreground">
              IDLE_SCAN 동안 AGENTS.md, MEMORY.md, memories/*.md를 LLM에 보내 user-preferences.md를 갱신합니다. 기본값은 OFF입니다.
            </p>
          </div>
        </div>
      </SettingsSection>

      {api && (
        <SettingsSection
          title="로그인 화면 스타일"
          description="처음 로그인 모달이 열릴 때 어떤 디자인으로 보일지 선택합니다. 즉시 반영됩니다."
        >
          <RadioGroup
            className="flex flex-col gap-2 text-sm"
            value={loginVariant ?? ""}
            disabled={!settingsLoaded || loginVariantSaving || loginVariant === null}
            onValueChange={(value) => {
              if (value === "conversational" || value === "cli-agent") {
                void handleLoginVariantChange(value);
              }
            }}
            aria-label="Login screen variant"
            data-testid="settings:login-variant"
          >
            <Label className="flex items-start gap-2">
              <RadioGroupItem value="conversational" data-testid="settings:login-variant:conversational" />
              <span className="space-y-0.5">
                <span className="block font-medium">대화형 (Conversational)</span>
                <span className="block text-[11px] text-muted-foreground">
                  채팅 형태의 환영 메시지와 칩 선택지로 로그인합니다. (L-X1)
                </span>
              </span>
            </Label>
            <Label className="flex items-start gap-2">
              <RadioGroupItem value="cli-agent" data-testid="settings:login-variant:cli-agent" />
              <span className="space-y-0.5">
                <span className="block font-medium">CLI Agent (터미널)</span>
                <span className="block text-[11px] text-muted-foreground">
                  터미널 트랜스크립트 스타일로 로그인합니다. (L-X2)
                </span>
              </span>
            </Label>
          </RadioGroup>
          {loginVariantError && (
            <p
              role="alert"
              data-testid="settings:login-variant:error"
              className="mt-2 text-[11px] text-destructive"
            >
              {loginVariantError}
            </p>
          )}
        </SettingsSection>
      )}

      <SettingsSection
        title="프라이버시"
        description="채팅 전송 전 개인정보 보호 동작을 설정합니다."
      >
        <PrivacyTab
          piiRedactEnabled={piiRedactEnabled}
          onToggle={handlePiiRedactToggle}
        />
      </SettingsSection>
    </div>
  );
}
