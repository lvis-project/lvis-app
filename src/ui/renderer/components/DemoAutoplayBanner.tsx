/**
 * Live Auto-play — chat header banner + take-over surface.
 *
 * Mockup SOT: `/tmp/login-lvis/index.html` O-X1.
 * Proposal: `docs/architecture/proposals/live-autoplay.md` §4 + §5.
 *
 * Renders:
 *   - ⏺ REC dot (blinking) — proves to the user that what they see is a
 *     scripted demo, not a real chat.
 *   - 데모 시연 중 · {titleKo}
 *   - "키 잡기 →" violet button — clicking triggers a take-over abort.
 *
 * Token discipline: uses `--action-view` (violet) for the take-over
 * button and a hard-coded REC red dot (single-purpose UI affordance,
 * not part of the theme palette). The REC red mirrors the mockup
 * `hsl(0 78% 58%)` so the visual is identical across themes.
 */
import { Button } from "../../../components/ui/button.js";
import { useTranslation } from "../../../i18n/react.js";

export interface DemoAutoplayBannerProps {
  /** Localized title from the active script. */
  titleKo: string;
  /** Fires when the user clicks "키 잡기 →". */
  onTakeOver: () => void;
}

const REC_DOT_RED = "hsl(0 78% 58%)";
const REC_DOT_BG = "hsl(0 78% 58% / 0.15)";
const REC_DOT_FG = "hsl(0 78% 70%)";

export function DemoAutoplayBanner({ titleKo, onTakeOver }: DemoAutoplayBannerProps) {
  const { t } = useTranslation();
  return (
    <div
      data-testid="demo-autoplay-banner"
      className="flex items-center gap-2 border-b border-border px-3 py-2"
      role="status"
      aria-label={t("demoAutoplayBanner.ariaLabel", { titleKo })}
    >
      <span
        aria-hidden="true"
        className="grid h-6 w-6 place-items-center rounded-md text-[11px] text-primary-foreground"
        style={{
          background:
            "linear-gradient(135deg, hsl(var(--action-view)), hsl(217 91% 60%))",
        }}
      >
        ✦
      </span>
      <div className="flex flex-col">
        <span className="text-xs font-medium text-foreground">{t("demoAutoplayBanner.demoLabel")}</span>
        <span className="text-[10px] text-muted-foreground">{titleKo}</span>
      </div>
      <span
        data-testid="demo-autoplay-banner:rec"
        className="ml-auto inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px]"
        style={{ background: REC_DOT_BG, color: REC_DOT_FG }}
      >
        <span
          aria-hidden="true"
          className="h-1.5 w-1.5 rounded-full demo-autoplay-rec-dot"
          style={{ background: REC_DOT_RED }}
        />
        REC
      </span>
      <Button
        type="button"
        size="sm"
        data-testid="demo-autoplay-banner:take-over"
        onClick={onTakeOver}
        className="ml-2 text-[11px]"
        style={{
          background: "hsl(var(--action-view))",
          color: "white",
        }}
      >
        {t("demoAutoplayBanner.takeOverButton")}
      </Button>
    </div>
  );
}
