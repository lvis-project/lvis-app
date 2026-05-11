/**
 * AppearanceTab — theme bundle picker (v2 single-bundle redesign).
 *
 * Single section: a 6-card grid where each card represents a ThemeBundle
 * (도쿄나이트 / 미드나잇 / 포레스트 / LGE라이트 / LGE다크 / 고대비).
 *
 * Clicking a card calls `setBundle(bundle.id)` and applies the bundle to
 * `<html data-theme-bundle>` immediately via ThemeProvider.
 *
 * When the selected bundle is part of the LGE pair (lge-light / lge-dark),
 * a `followSystem` toggle is shown. For all other bundles it is hidden.
 *
 * High-contrast is always shown (never auto-suggested).
 *
 * The external URL section (§B1 webView policy) is preserved verbatim.
 */
import { useEffect, useState } from "react";
import { useTheme } from "../theme/index.js";
import { BUNDLES, LGE_PAIR_IDS } from "../theme/index.js";
import type { ThemeBundle } from "../theme/index.js";
import type { CSSProperties } from "react";
import { getApi } from "../api-client.js";

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
        .catch(() => { /* ignore — local state already reflects */ });
    } catch {
      /* ignore */
    }
  };

  return { flow, setFlow };
}

export function AppearanceTab() {
  const { bundleId, setBundle, followSystem, setFollowSystem } = useTheme();
  const { flow: webViewFlow, setFlow: setWebViewFlow } = useWebViewPreferredFlow();

  const isLgePair = LGE_PAIR_IDS.includes(bundleId);

  return (
    <div className="space-y-6 pt-4">
      {/* Header */}
      <div className="space-y-1">
        <p className="text-sm font-medium">테마</p>
        <p className="text-[11px] text-muted-foreground">
          테마를 선택하면 채팅 배경, 강조 색상, 코드 블록이 함께 변경됩니다. 변경은 즉시 적용되며 재시작이 필요 없습니다.
        </p>
      </div>

      {/* ── 6-bundle card grid ───────────────────────────────────────── */}
      <section className="space-y-3">
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
              onSelect={() => setBundle(bundle.id)}
            />
          ))}
        </div>
      </section>

      {/* ── followSystem toggle — LGE pair only ─────────────────────── */}
      {isLgePair && (
        <section className="space-y-2 border-t border-border pt-4">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-sm font-semibold">시스템 테마 따르기</h3>
              <p className="text-[11px] text-muted-foreground">
                OS 라이트/다크 모드에 맞춰 LGE 라이트/다크를 자동 전환합니다.
              </p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={followSystem}
              aria-label="OS 시스템 색상 따라가기"
              data-testid="follow-system-toggle"
              onClick={() => setFollowSystem(!followSystem)}
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
        </section>
      )}

      {/* ── 외부 URL 표시 정책 (B1) ─────────────────────────────────── */}
      <section className="space-y-2 border-t border-border pt-4">
        <div className="flex items-baseline justify-between">
          <h3 className="text-sm font-semibold">외부 URL 표시</h3>
          <span className="text-[11px] text-muted-foreground">
            현재: <span className="font-mono text-foreground">{webViewFlow}</span>
          </span>
        </div>
        <p className="text-[11px] text-muted-foreground">
          이 설정은 플러그인이 호스트에 위임한 외부 URL 표시에 적용됩니다.
        </p>
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
      </section>
    </div>
  );
}
