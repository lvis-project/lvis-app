/**
 * AppearanceTab — UX Track 3 visual theme picker (two-axis redesign).
 *
 * Two stacked sections, each rendered as a `role="radiogroup"` of visual
 * swatch cards (not native radios — the cards themselves are the controls):
 *
 *   1. 채팅 테마  → ChatThemePreference  (default | purple | orange | blue)
 *   2. 코드 테마  → CodeThemePreference  (auto/light/dark)
 *
 * The shell preference (light/dark/high-contrast/system) lives below in a
 * compact secondary picker so power users can still reach it; the primary
 * focus of the tab is the card-based chat-theme + code-theme experience
 * matching the user-provided reference image.
 *
 * Cards are mini live previews built from CSS-only primitives (see
 * `src/styles.css` `.lvis-theme-card-*` rules). Selection state is signaled
 * via `aria-checked="true"` and a 2-px ring drawn in the active accent.
 *
 * Adding a new chat-theme variant: see ThemeProvider.tsx header comment.
 */
import { useTheme } from "../theme/index.js";
import type {
  ChatThemePreference,
  ThemePreference,
} from "../theme/index.js";
import type { CSSProperties } from "react";

/* ─── chat-theme card data ───────────────────────────────────────────── */
interface ChatOption {
  value: ChatThemePreference;
  label: string;
  /** CSS color expression injected as `--mock-accent` on the inner mock. */
  accentVar: string;
  /**
   * Optional surface override for cards whose theme repaints background /
   * text / assistant-bubble (e.g. LG). When omitted the mock keeps the
   * generic slate defaults from styles.css. Each entry is a CSS color
   * expression — the keys map 1:1 to mock CSS variables.
   */
  surface?: {
    bg?: string;
    text?: string;
    bubbleOther?: string;
  };
}

const CHAT_OPTIONS: ReadonlyArray<ChatOption> = [
  // "default" inherits from the active shell theme — show the slate/blue mix
  // we use in the dark default. We render this with the literal blue accent
  // so the card stays visually distinct from the explicit "blue" card below.
  { value: "default", label: "기본", accentVar: "hsl(215 16% 47%)" },
  // "lg" is an accent overlay: vivid SEND, lilac user bubble, LG red STOP.
  // It intentionally keeps shell/card/plugin surfaces from the active theme.
  {
    value: "lg",
    label: "LG",
    accentVar: "hsl(271 76% 76%)",
  },
  { value: "purple", label: "퍼플", accentVar: "hsl(262 83% 58%)" },
  { value: "orange", label: "오렌지", accentVar: "hsl(25 95% 53%)" },
  { value: "blue", label: "블루", accentVar: "hsl(217.2 91.2% 59.8%)" },
];

/* ─── code-theme card data ───────────────────────────────────────────── */
//
// Only the explicit "light" / "dark" variants are surfaced as cards. The
// "auto" preference is implicit — when the user hasn't explicitly chosen,
// the card whose value matches `resolvedCodeTheme` is shown as selected.
interface CodeOption {
  value: "light" | "dark";
  label: string;
}
const CODE_OPTIONS: ReadonlyArray<CodeOption> = [
  { value: "light", label: "라이트" },
  { value: "dark", label: "다크" },
];

/* ─── shell preference (kept as a compact text-radio row) ─────────────── */
const SHELL_OPTIONS: ReadonlyArray<{ value: ThemePreference; label: string }> = [
  { value: "system", label: "시스템" },
  { value: "light", label: "라이트" },
  { value: "dark", label: "다크" },
  { value: "high-contrast", label: "고대비" },
];

/* ─── inline mock CSS-var helper ───────────────────────────────────────
 * Builds the inline style object that exposes per-card variables to the
 * mock CSS. Only `accent` is mandatory; surface fields are wired only
 * when the theme has its own surface palette (avoids overriding the
 * mock's generic light defaults for accent-only themes). */
function mockStyle(accent: string, surface?: ChatOption["surface"]): CSSProperties {
  const style: Record<string, string> = { "--mock-accent": accent };
  if (surface?.bg) style["--mock-bg"] = surface.bg;
  if (surface?.text) style["--mock-text"] = surface.text;
  if (surface?.bubbleOther) style["--mock-bubble-other"] = surface.bubbleOther;
  return style as CSSProperties;
}

/* ─── chat-theme card mock — generic chat shell ──────────────────────── */
function ChatThemeMock({ accent, surface }: { accent: string; surface?: ChatOption["surface"] }) {
  return (
    <div className="lvis-theme-card-mock-inner" style={mockStyle(accent, surface)}>
      <div className="lvis-theme-card-mock-bar" />
      <div className="lvis-theme-card-mock-row">
        <span className="lvis-theme-card-mock-dot" />
        <span className="lvis-theme-card-mock-bubble" />
      </div>
      <div className="lvis-theme-card-mock-row">
        <span className="lvis-theme-card-mock-bubble is-self" />
      </div>
      <div className="lvis-theme-card-mock-row">
        <span className="lvis-theme-card-mock-bubble" />
      </div>
    </div>
  );
}

/* ─── code-theme card mock — split-pane editor ───────────────────────── */
function CodeThemeMock({ which }: { which: "light" | "dark" }) {
  // We always show the SAME split (left=light, right=dark) so the card is
  // immediately recognizable as "code editor". The selected card's ring
  // signals the user choice; we additionally tint the dominant pane with
  // the active card's identity by floating a `<>` glyph over it.
  const dominantSide = which === "light" ? "left" : "right";
  return (
    <div className="lvis-theme-card-mock-split">
      <div className="lvis-theme-card-mock-split-pane is-light">
        <span className="lvis-theme-card-mock-codeline is-mid" />
        <span className="lvis-theme-card-mock-codeline is-long" />
        <span className="lvis-theme-card-mock-codeline is-short" />
        {dominantSide === "left" ? (
          <span className="lvis-theme-card-mock-glyph" aria-hidden="true">{"</>"}</span>
        ) : null}
      </div>
      <div className="lvis-theme-card-mock-split-pane is-dark">
        <span className="lvis-theme-card-mock-codeline is-long" />
        <span className="lvis-theme-card-mock-codeline is-mid" />
        <span className="lvis-theme-card-mock-codeline is-short" />
        {dominantSide === "right" ? (
          <span className="lvis-theme-card-mock-glyph" aria-hidden="true">{"</>"}</span>
        ) : null}
      </div>
    </div>
  );
}

/* ─── single swatch card (ARIA radio with visual mock) ───────────────── */
interface SwatchCardProps {
  selected: boolean;
  label: string;
  accessibleName: string;
  onSelect: () => void;
  children: React.ReactNode;
}

function SwatchCard({ selected, label, accessibleName, onSelect, children }: SwatchCardProps) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      aria-label={accessibleName}
      data-selected={selected ? "true" : "false"}
      className="lvis-theme-card"
      onClick={onSelect}
      onKeyDown={(e) => {
        // Standard radio activation — Space and Enter should both select.
        if (e.key === " " || e.key === "Enter") {
          e.preventDefault();
          onSelect();
        }
      }}
    >
      <div className="lvis-theme-card-mock" aria-hidden="true">
        {children}
      </div>
      <div className="lvis-theme-card-label">
        <span>{label}</span>
        <span className="lvis-theme-card-checkmark" aria-hidden="true">✓</span>
      </div>
    </button>
  );
}

export function AppearanceTab() {
  const {
    preference,
    resolved,
    chatTheme,
    codeTheme,
    resolvedCodeTheme,
    setPreference,
    setChatTheme,
    setCodeTheme,
  } = useTheme();

  return (
    <div className="space-y-6 pt-4">
      {/* Header */}
      <div className="space-y-1">
        <p className="text-sm font-medium">테마</p>
        <p className="text-[11px] text-muted-foreground">
          채팅의 강조 색상과 코드 블록 표시 방식을 각각 선택할 수 있습니다. 변경은 즉시 적용되며 재시작이 필요 없습니다.
        </p>
      </div>

      {/* ── 채팅 테마 ───────────────────────────────────────────────── */}
      <section className="space-y-3">
        <div className="flex items-baseline justify-between">
          <h3 className="text-sm font-semibold">채팅 테마</h3>
          <span className="text-[11px] text-muted-foreground">강조색만 변경됩니다</span>
        </div>

        <div
          role="radiogroup"
          aria-label="채팅 테마 선택"
          className="grid grid-cols-2 gap-3 sm:grid-cols-4"
        >
          {CHAT_OPTIONS.map((opt) => (
            <SwatchCard
              key={opt.value}
              selected={chatTheme === opt.value}
              label={opt.label}
              accessibleName={`채팅 테마: ${opt.label}`}
              onSelect={() => setChatTheme(opt.value)}
            >
              <ChatThemeMock accent={opt.accentVar} surface={opt.surface} />
            </SwatchCard>
          ))}
        </div>
      </section>

      {/* ── 코드 테마 ───────────────────────────────────────────────── */}
      <section className="space-y-3">
        <div className="flex items-baseline justify-between">
          <h3 className="text-sm font-semibold">코드 테마</h3>
          <span className="text-[11px] text-muted-foreground">
            현재 적용: <span className="font-mono text-foreground">{resolvedCodeTheme}</span>
            {codeTheme === "auto" && (
              <span className="ml-1 opacity-70">(자동)</span>
            )}
          </span>
        </div>

        <div
          role="radiogroup"
          aria-label="코드 테마 선택"
          className="grid grid-cols-2 gap-3 sm:max-w-md"
        >
          {CODE_OPTIONS.map((opt) => (
            <SwatchCard
              key={opt.value}
              selected={codeTheme === opt.value || (codeTheme === "auto" && resolvedCodeTheme === opt.value)}
              label={opt.label}
              accessibleName={`코드 테마: ${opt.label}`}
              onSelect={() => setCodeTheme(opt.value)}
            >
              <CodeThemeMock which={opt.value} />
            </SwatchCard>
          ))}
        </div>
        <p className="text-[11px] text-muted-foreground">
          명시적으로 선택하지 않으면(자동) 앱 라이트/다크 모드를 따라갑니다.
        </p>
      </section>

      {/* ── 앱 라이트/다크 (compact secondary picker) ──────────────── */}
      <section className="space-y-2 border-t border-border pt-4">
        <div className="flex items-baseline justify-between">
          <h3 className="text-sm font-semibold">앱 라이트/다크</h3>
          <span className="text-[11px] text-muted-foreground">
            현재: <span className="font-mono text-foreground">{resolved}</span>
            {preference === "system" && (
              <span className="ml-1 opacity-70">(시스템 설정 기반)</span>
            )}
          </span>
        </div>
        <div
          role="radiogroup"
          aria-label="앱 모드 선택"
          className="flex flex-wrap gap-2"
        >
          {SHELL_OPTIONS.map((opt) => {
            const checked = preference === opt.value;
            return (
              <button
                key={opt.value}
                type="button"
                role="radio"
                aria-checked={checked}
                onClick={() => setPreference(opt.value)}
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
