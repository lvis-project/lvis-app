/**
 * AppearanceTab — UX Track 3 theme picker.
 *
 * The radio-group selection writes through ThemeProvider.setPreference(),
 * which both updates `<html data-theme>` live and persists to
 * `~/.lvis/settings.json` (`appearance.theme`). No app reload required.
 *
 * Adding a new theme variant:
 *  1. Extend `ThemePreference` in `src/data/settings-store.ts`.
 *  2. Add the `[data-theme="<id>"]` block to `src/styles.css`.
 *  3. Append an entry to the `OPTIONS` array below.
 *  4. Document it in `docs/development/theme-system.md`.
 */
import { useTheme } from "../theme/index.js";
import type { ThemePreference } from "../theme/index.js";

const OPTIONS: ReadonlyArray<{ value: ThemePreference; label: string; hint: string }> = [
  { value: "system", label: "시스템 설정 따르기", hint: "OS의 라이트/다크 모드 변경에 자동으로 동기화됩니다." },
  { value: "light", label: "라이트", hint: "밝은 배경 — 외부 회의/데모 환경에 권장." },
  { value: "dark", label: "다크", hint: "어두운 배경 — 장시간 작업에 권장 (기본값)." },
  { value: "high-contrast", label: "고대비", hint: "접근성 — 흰 글자 / 검정 배경 + 노란 강조." },
];

export function AppearanceTab() {
  const { preference, resolved, setPreference } = useTheme();

  return (
    <div className="space-y-4 pt-4">
      <div className="space-y-1">
        <p className="text-sm font-medium">테마</p>
        <p className="text-[11px] text-muted-foreground">
          앱 전체의 색상 팔레트를 결정합니다. 변경은 즉시 적용되며 재시작이 필요 없습니다.
        </p>
      </div>

      <div
        role="radiogroup"
        aria-label="테마 선택"
        className="space-y-2"
      >
        {OPTIONS.map((opt) => {
          const checked = preference === opt.value;
          return (
            <label
              key={opt.value}
              className={`flex cursor-pointer items-start gap-3 rounded-md border px-3 py-3 transition-colors ${
                checked ? "border-primary bg-accent/40" : "border-border hover:bg-muted/40"
              }`}
            >
              <input
                type="radio"
                name="lvis-theme"
                value={opt.value}
                checked={checked}
                onChange={() => setPreference(opt.value)}
                className="mt-1 h-4 w-4 cursor-pointer accent-primary"
                aria-describedby={`theme-${opt.value}-hint`}
              />
              <div className="space-y-0.5">
                <p className="text-sm font-medium">{opt.label}</p>
                <p id={`theme-${opt.value}-hint`} className="text-[11px] text-muted-foreground">
                  {opt.hint}
                </p>
              </div>
            </label>
          );
        })}
      </div>

      <div className="rounded-md border border-dashed px-3 py-2 text-[11px] text-muted-foreground">
        현재 적용된 테마: <span className="font-mono text-foreground">{resolved}</span>
        {preference === "system" && (
          <span className="ml-2 opacity-70">(시스템 설정 기반)</span>
        )}
      </div>
    </div>
  );
}
