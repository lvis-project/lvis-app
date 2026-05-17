/**
 * AppearanceTab — theme bundle picker (v2 single-bundle redesign).
 *
 * Single section: a card grid where each card represents a ThemeBundle
 * (Tokyo Night / Midnight / Forest / Violet Light / Violet Dark / High Contrast
 * plus the community bundles — Catppuccin Mocha/Latte, Nord, Gruvbox Dark
 * Hard, Solarized Light, Rosé Pine, Cherry Blossom).
 *
 * Clicking a card calls `setBundle(bundle.id)` and applies the bundle to
 * `<html data-theme-bundle>` immediately via ThemeProvider.
 *
 * When the selected bundle is part of the violet pair (violet-light / violet-dark),
 * a `followSystem` toggle is shown. For all other bundles it is hidden.
 *
 * High-contrast is always shown (never auto-suggested).
 *
 * The external URL section (§B1 webView policy) is preserved verbatim.
 */
import { useEffect, useRef, useState } from "react";
import { useTheme } from "../theme/index.js";
import { BUNDLES, VIOLET_PAIR_IDS } from "../theme/index.js";
import type { ThemeBundle } from "../theme/index.js";
import type { CSSProperties } from "react";
import { getApi } from "../api-client.js";
import { useNotifySaved } from "../contexts/saved-toast.js";
import { SettingsPageHeader } from "../components/SettingsPageHeader.js";
import { SettingsSection } from "../components/SettingsSection.js";

type WebViewPreferredFlow = "in-app" | "system-browser";

/* ─── Bundle card mini-mock helpers ─────────────────────────────────────── */

/**
 * Derive the two dominant colors for a bundle mini-mock from its tokens.
 * `bg` is the card background; `accent` is the primary color pill.
 */
function bundleMockColors(bundle: ThemeBundle): { bg: string; accent: string; text: string } {
  const t = bundle.tokens;
  return {
    bg:     `hsl(${t.background})`,
    accent: `hsl(${t.primary})`,
    text:   `hsl(${t.foreground})`,
  };
}

/**
 * Mini chat-shell mock for a bundle card. Shows background, a user bubble
 * (accent color) and an assistant bubble (muted tone).
 */
function BundleMock({ bundle }: { bundle: ThemeBundle }) {
  const { bg, accent, text } = bundleMockColors(bundle);
  const userBubble = `hsl(${bundle.tokens["message-user-bg"]})`;
  const mutedBubble = `hsl(${bundle.tokens.muted})`;

  const style: CSSProperties = {
    background: bg,
    color: text,
    width: "100%",
    height: "100%",
    padding: "0.4rem 0.45rem",
    display: "flex",
    flexDirection: "column",
    gap: "0.28rem",
  };

  return (
    <div style={style}>
      {/* title bar mock */}
      <div style={{ height: "0.45rem", borderRadius: "0.2rem", background: accent, width: "100%", flexShrink: 0 }} />
      {/* assistant bubble row */}
      <div style={{ display: "flex", alignItems: "center", gap: "0.3rem" }}>
        <span style={{ width: "0.55rem", height: "0.55rem", borderRadius: "999px", background: accent, flexShrink: 0 }} />
        <span style={{ height: "0.55rem", borderRadius: "0.45rem", background: mutedBubble, flex: "1 1 auto" }} />
      </div>
      {/* user bubble row */}
      <div style={{ display: "flex" }}>
        <span style={{ height: "0.55rem", borderRadius: "0.45rem", background: userBubble, flex: "0 0 60%", marginLeft: "auto" }} />
      </div>
      {/* assistant bubble row */}
      <div style={{ display: "flex", alignItems: "center", gap: "0.3rem" }}>
        <span style={{ width: "0.55rem", height: "0.55rem", borderRadius: "999px", background: accent, flexShrink: 0 }} />
        <span style={{ height: "0.55rem", borderRadius: "0.45rem", background: mutedBubble, flex: "1 1 auto" }} />
      </div>
    </div>
  );
}

/* ─── Single swatch card (ARIA radio with bundle mini-mock) ──────────────── */
interface BundleCardProps {
  bundle: ThemeBundle;
  selected: boolean;
  onSelect: () => void;
}

function BundleCard({ bundle, selected, onSelect }: BundleCardProps) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      aria-label={`테마: ${bundle.name}`}
      data-selected={selected ? "true" : "false"}
      data-bundle-id={bundle.id}
      className="lvis-theme-card"
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === " " || e.key === "Enter") {
          e.preventDefault();
          onSelect();
        }
      }}
    >
      <div className="lvis-theme-card-mock" aria-hidden="true">
        <BundleMock bundle={bundle} />
      </div>
      <div className="lvis-theme-card-label">
        <span>{bundle.name}</span>
        <span className="lvis-theme-card-checkmark" aria-hidden="true">✓</span>
      </div>
    </button>
  );
}

/* ─── Font family + size presets ─────────────────────────────────────────── */

type FontSizeOption = { value: 0.875 | 1 | 1.125 | 1.25; label: string };
const FONT_SIZE_OPTIONS: ReadonlyArray<FontSizeOption> = [
  { value: 0.875, label: "작게" },
  { value: 1, label: "보통" },
  { value: 1.125, label: "크게" },
  { value: 1.25, label: "매우 크게" },
];

type FontFamilyPreset = { value: string; label: string; stack: string };
const FONT_FAMILY_PRESETS: ReadonlyArray<FontFamilyPreset> = [
  { value: "system", label: "시스템 기본", stack: "" /* unset → HOST_FONT_STACK */ },
  {
    value: "pretendard",
    label: "Pretendard",
    stack: "Pretendard, system-ui, -apple-system, \"Segoe UI\", \"Apple SD Gothic Neo\", \"Noto Sans KR\", \"Malgun Gothic\", sans-serif",
  },
  {
    value: "noto-sans-kr",
    label: "Noto Sans KR",
    stack: "\"Noto Sans KR\", \"Apple SD Gothic Neo\", \"Malgun Gothic\", system-ui, sans-serif",
  },
  {
    value: "spoqa-han-sans",
    label: "Spoqa Han Sans Neo",
    stack: "\"Spoqa Han Sans Neo\", \"Apple SD Gothic Neo\", \"Noto Sans KR\", \"Malgun Gothic\", system-ui, sans-serif",
  },
  {
    value: "apple-sd-gothic",
    label: "Apple SD Gothic Neo",
    stack: "\"Apple SD Gothic Neo\", \"Noto Sans KR\", \"Malgun Gothic\", system-ui, sans-serif",
  },
  {
    value: "ibm-plex",
    label: "IBM Plex Sans",
    stack: "\"IBM Plex Sans KR\", \"IBM Plex Sans\", system-ui, -apple-system, sans-serif",
  },
  {
    value: "jetbrains-mono",
    label: "JetBrains Mono",
    stack: "\"JetBrains Mono\", \"Fira Code\", \"Cascadia Code\", ui-monospace, SFMono-Regular, \"SF Mono\", Menlo, Consolas, monospace",
  },
  {
    value: "fira-code",
    label: "Fira Code",
    stack: "\"Fira Code\", \"JetBrains Mono\", \"Cascadia Code\", ui-monospace, SFMono-Regular, \"SF Mono\", Menlo, Consolas, monospace",
  },
];

function presetForStack(stack: string | undefined): string {
  if (!stack || stack === "system") return "system";
  const hit = FONT_FAMILY_PRESETS.find((p) => p.stack === stack);
  return hit ? hit.value : "custom";
}

const FONT_SIZE_VALUES: ReadonlyArray<0.875 | 1 | 1.125 | 1.25> = FONT_SIZE_OPTIONS.map((o) => o.value);

function useFontPreferences() {
  const [family, setFamilyState] = useState<string>("system");
  const [sizeScale, setSizeScaleState] = useState<0.875 | 1 | 1.125 | 1.25>(1);

  // Initial load + cross-window broadcast subscription. Without the subscription
  // the radio buttons drift from the canonical state when the user changes the
  // font in another window (native settings BrowserWindow or sibling).
  useEffect(() => {
    let cancelled = false;
    let unsub: (() => void) | undefined;
    void (async () => {
      try {
        const api = getApi();
        const settings = await api.getSettings();
        if (cancelled) return;
        applyFromSettings(settings);
        unsub = api.onSettingsUpdated((next) => {
          if (cancelled) return;
          applyFromSettings(next);
        });
      } catch {
        /* ignore — defaults remain */
      }
    })();
    function applyFromSettings(s: { appearance?: { font?: { family?: string; sizeScale?: number } } }) {
      const font = s.appearance?.font;
      if (font?.family && font.family !== "system") setFamilyState(font.family);
      else setFamilyState("system");
      if (font?.sizeScale && (FONT_SIZE_VALUES as readonly number[]).includes(font.sizeScale)) {
        setSizeScaleState(font.sizeScale as 0.875 | 1 | 1.125 | 1.25);
      } else {
        setSizeScaleState(1);
      }
    }
    return () => { cancelled = true; unsub?.(); };
  }, []);

  const notifySaved = useNotifySaved();
  const setFamily = (next: string) => {
    setFamilyState(next || "system");
    try {
      const api = getApi();
      void api
        .updateSettings({ appearance: { font: { family: next || "system" } } })
        .then(() => notifySaved())
        .catch(() => { /* ignore — local state already reflects */ });
    } catch {
      /* ignore */
    }
  };
  const setSizeScale = (next: 0.875 | 1 | 1.125 | 1.25) => {
    setSizeScaleState(next);
    try {
      const api = getApi();
      void api
        .updateSettings({ appearance: { font: { sizeScale: next } } })
        .then(() => notifySaved())
        .catch(() => { /* ignore */ });
    } catch {
      /* ignore */
    }
  };

  return { family, sizeScale, setFamily, setSizeScale };
}

/* ─── webView preferredFlow options ──────────────────────────────────────── */
const WEBVIEW_OPTIONS: ReadonlyArray<{ value: WebViewPreferredFlow; label: string; hint: string }> = [
  { value: "in-app", label: "인앱 표시", hint: "외부 URL 을 LVIS 창 안에 표시합니다." },
  { value: "system-browser", label: "시스템 브라우저", hint: "외부 URL 을 OS 기본 브라우저에서 엽니다." },
];

function useWebViewPreferredFlow(): {
  flow: WebViewPreferredFlow;
  setFlow: (next: WebViewPreferredFlow) => void;
} {
  const [flow, setFlowState] = useState<WebViewPreferredFlow>("in-app");

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const api = getApi();
        const settings = await api.getSettings();
        if (cancelled) return;
        const next = settings.webView?.preferredFlow;
        if (next === "in-app" || next === "system-browser") {
          setFlowState(next);
        }
      } catch {
        /* ignore — toggle stays at default until user interacts */
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const notifySaved = useNotifySaved();
  const setFlow = (next: WebViewPreferredFlow) => {
    const prev = flow;
    setFlowState(next);
    if (typeof process !== "undefined" && process.env?.LVIS_DEV === "1") {
      // dev-mode toggle log — formal telemetry deferred (see plan §7).
      // eslint-disable-next-line no-console
      console.log(`[settings] webView.preferredFlow changed: ${prev} -> ${next}`);
    }
    try {
      const api = getApi();
      void api
        .updateSettings({ webView: { preferredFlow: next } })
        .then(() => notifySaved())
        .catch(() => { /* ignore — local state already reflects */ });
    } catch {
      /* ignore */
    }
  };

  return { flow, setFlow };
}

/**
 * Free-form CSS font-family input with commit-on-blur semantics.
 *
 * `initial` syncs the React state when the upstream value changes (other window,
 * preset click). Local state is the raw typed text (no per-keystroke trim — that
 * would strip trailing whitespace as the user types, sabotaging cursor stability
 * and turning `"Arial, Helvetica"` into `"Arial,Helvetica"`). Commit happens on
 * blur or Enter — trim once, send the validated string to settings, broadcast
 * once. Empty input commits as `"system"` (revert to default).
 */
function FontFamilyCustomInput({
  initial,
  onCommit,
}: {
  initial: string;
  onCommit: (value: string) => void;
}) {
  const [raw, setRaw] = useState(initial);
  const inputRef = useRef<HTMLInputElement | null>(null);
  // `escapingRef` blocks the `onBlur=commit()` call that fires synchronously
  // when an Escape handler calls `inputElement.blur()`. Without this flag,
  // React 18+ batches `setRaw(initial)`, then `blur()` runs `onBlur` with
  // the still-typed `raw` closure → commit("user typed text") → the very
  // bug Escape was meant to cancel (PR #672 3차 critic MAJOR M1).
  const escapingRef = useRef(false);
  // Re-sync when upstream changes (preset click, cross-window broadcast, …).
  // Guard against overwriting in-progress typing — if the input is currently
  // focused, the user is editing and we must not stomp their text with a
  // sibling-window broadcast (PR #672 2차 critic minor N2).
  useEffect(() => {
    if (document.activeElement === inputRef.current) return;
    setRaw(initial);
  }, [initial]);

  // Dedupe against `initial.trim()` so a self-echo from cross-window broadcast
  // (the user committed "Foo" here, the broadcast arrived, parent re-rendered
  // with `initial = "Foo"`, an unfocused blur is a no-op anyway) stays silent.
  const commit = () => {
    const value = raw.trim();
    if (value === initial.trim()) return;
    onCommit(value);
  };

  return (
    <details className="text-[11px] text-muted-foreground">
      <summary className="cursor-pointer select-none">직접 입력 (CSS font-family stack)</summary>
      <input
        ref={inputRef}
        type="text"
        value={raw}
        placeholder='예: "Spoqa Han Sans Neo", system-ui, sans-serif'
        maxLength={200}
        onChange={(e) => setRaw(e.target.value)}
        onBlur={() => {
          // Escape sets this flag and then calls blur(); skip the cascaded
          // commit so the typed-but-cancelled value never reaches onCommit.
          if (escapingRef.current) { escapingRef.current = false; return; }
          commit();
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            escapingRef.current = true;
            setRaw(initial);
            (e.target as HTMLInputElement).blur();
          }
        }}
        className="mt-2 w-full rounded border border-input bg-background px-2 py-1 font-mono text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
        aria-label="사용자 정의 폰트 stack"
      />
      <p className="mt-1 text-[10px]">
        한글/영문/숫자 폰트 이름, 콤마, 따옴표, 하이픈만 허용 (최대 200자). 입력 후 Enter 또는 포커스를 벗어나면 저장됩니다.
        Escape 로 취소합니다. 잘못된 입력은 자동으로 시스템 기본으로 되돌아갑니다.
      </p>
    </details>
  );
}

export function AppearanceTab() {
  const { bundleId, setBundle, followSystem, setFollowSystem } = useTheme();
  const { flow: webViewFlow, setFlow: setWebViewFlow } = useWebViewPreferredFlow();
  const { family, sizeScale, setFamily, setSizeScale } = useFontPreferences();
  const notifySaved = useNotifySaved();
  // useTheme persists bundle + followSystem through its own ThemeProvider
  // (api.updateSettings inside ThemeProvider.tsx). The provider is a
  // generic surface that can be mounted outside settings, so it does not
  // notify the dialog itself. We wrap the setters at this consumer to
  // surface the dialog-wide "저장되었습니다" toast on selection.
  const selectBundle = (id: typeof bundleId) => { setBundle(id); notifySaved(); };
  const selectFollowSystem = (next: boolean) => { setFollowSystem(next); notifySaved(); };

  const isVioletPair = VIOLET_PAIR_IDS.includes(bundleId);
  const activePreset = presetForStack(family);
  const customStack = activePreset === "custom" ? family : "";

  return (
    <div className="space-y-5">
      <SettingsPageHeader
        title="테마"
        description="화면 색상, 글꼴, 외부 URL 표시 방식을 설정합니다"
      />

      {/* ── 테마 선택 ─────────────────────────────────── */}
      <SettingsSection
        title="색상 테마"
        description="테마를 선택하면 채팅 배경, 강조 색상, 코드 블록이 함께 변경됩니다. 변경은 즉시 적용되며 재시작이 필요 없습니다."
      >
        <div
          role="radiogroup"
          aria-label="테마 선택"
          className="grid grid-cols-2 gap-3 sm:grid-cols-3"
        >
          {BUNDLES.map((bundle) => (
            <BundleCard
              key={bundle.id}
              bundle={bundle}
              selected={bundleId === bundle.id}
              onSelect={() => selectBundle(bundle.id)}
            />
          ))}
        </div>

        {/* followSystem toggle — violet pair only */}
        {isVioletPair && (
          <div className="flex items-center justify-between pt-2 border-t border-border">
            <div>
              <p className="text-sm font-medium">시스템 테마 따르기</p>
              <p className="text-[11px] text-muted-foreground">
                OS 라이트/다크 모드에 맞춰 Violet Light / Violet Dark 를 자동 전환합니다.
              </p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={followSystem}
              aria-label="OS 시스템 색상 따라가기"
              data-testid="follow-system-toggle"
              onClick={() => selectFollowSystem(!followSystem)}
              className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
                followSystem ? "bg-primary" : "bg-muted"
              }`}
            >
              <span
                className={`inline-block h-4 w-4 transform rounded-full bg-primary-foreground transition-transform ${
                  followSystem ? "translate-x-4" : "translate-x-1"
                }`}
              />
            </button>
          </div>
        )}
      </SettingsSection>

      {/* ── 폰트 ────────────────────────────────────── */}
      <SettingsSection
        title="폰트"
        description="호스트 본체 / 채팅 / 설정 창 전체에 적용됩니다. 시스템 기본은 OS 의 sans-serif 와 한글 폰트 fallback 체인을 사용합니다. 플러그인 자체 창은 호스트 설정과 별도로 자체 폰트를 사용합니다."
        actions={
          <span className="text-[11px] text-muted-foreground">
            크기 미리보기:{" "}
            <span className="font-mono text-foreground">{Math.round(sizeScale * 16)}px</span>
          </span>
        }
      >
        {/* 폰트 패밀리 */}
        <div className="space-y-2">
          <label className="text-[11px] text-muted-foreground">패밀리</label>
          <div
            role="radiogroup"
            aria-label="폰트 패밀리 선택"
            data-testid="font-family-presets"
            className="flex flex-wrap gap-2"
          >
            {FONT_FAMILY_PRESETS.map((opt) => {
              const checked = activePreset === opt.value;
              return (
                <button
                  key={opt.value}
                  type="button"
                  role="radio"
                  aria-checked={checked}
                  data-value={opt.value}
                  onClick={() => setFamily(opt.stack)}
                  className={`rounded-full border px-3 py-1 text-xs transition-colors ${
                    checked
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-border text-muted-foreground hover:bg-muted/50 hover:text-foreground"
                  }`}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>

          {/* 사용자 stack 직접 입력 — commit on blur / Enter only. */}
          <FontFamilyCustomInput
            initial={customStack}
            onCommit={(value) => setFamily(value)}
          />
        </div>

        {/* 폰트 크기 */}
        <div className="space-y-2">
          <label className="text-[11px] text-muted-foreground">크기</label>
          <div
            role="radiogroup"
            aria-label="폰트 크기 선택"
            data-testid="font-size-scale"
            className="flex flex-wrap gap-2"
          >
            {FONT_SIZE_OPTIONS.map((opt) => {
              const checked = sizeScale === opt.value;
              return (
                <button
                  key={opt.value}
                  type="button"
                  role="radio"
                  aria-checked={checked}
                  data-value={String(opt.value)}
                  onClick={() => setSizeScale(opt.value)}
                  className={`rounded-full border px-3 py-1 transition-colors ${
                    checked
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-border text-muted-foreground hover:bg-muted/50 hover:text-foreground"
                  }`}
                  style={{ fontSize: `${opt.value * 0.75}rem` }}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>
        </div>
      </SettingsSection>

      {/* ── 외부 URL 표시 정책 (B1) ─────────────────────────────────── */}
      <SettingsSection
        title="외부 URL 표시"
        description="이 설정은 플러그인이 호스트에 위임한 외부 URL 표시에 적용됩니다."
        actions={
          <span className="text-[11px] text-muted-foreground">
            현재: <span className="font-mono text-foreground">{webViewFlow}</span>
          </span>
        }
      >
        <div
          role="radiogroup"
          aria-label="외부 URL 표시 정책 선택"
          data-testid="webview-preferred-flow"
          className="flex flex-wrap gap-2"
        >
          {WEBVIEW_OPTIONS.map((opt) => {
            const checked = webViewFlow === opt.value;
            return (
              <button
                key={opt.value}
                type="button"
                role="radio"
                aria-checked={checked}
                data-value={opt.value}
                title={opt.hint}
                onClick={() => setWebViewFlow(opt.value)}
                className={`rounded-full border px-3 py-1 text-xs transition-colors ${
                  checked
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border text-muted-foreground hover:bg-muted/50 hover:text-foreground"
                }`}
              >
                {opt.label}
              </button>
            );
          })}
        </div>
      </SettingsSection>
    </div>
  );
}
