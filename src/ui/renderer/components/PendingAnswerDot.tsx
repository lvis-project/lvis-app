import { useTranslation } from "../../../i18n/react.js";

/**
 * The one attention token for "open this and there is a card you must answer".
 *
 * It sits on a sidebar row, a pane header control, a work-panel tab — every
 * surface that stands between the user and a parked approval, question or
 * deferred ask they cannot see from where they are. One meaning, one drawing:
 * a dot in the warning tone, ringed in the surface it sits on so it reads over
 * an icon as well as over text. Which surfaces carry it is decided once, by
 * `pendingAnswers`; this component only draws the verdict.
 *
 * `absolute` by default so it can ride the corner of an icon button; `inline`
 * puts it in the flow of a row's text.
 */
export function PendingAnswerDot({ testId, inline = false }: { testId: string; inline?: boolean }) {
  const { t } = useTranslation();
  return (
    <span
      role="img"
      aria-label={t("pendingAnswerDot.label")}
      title={t("pendingAnswerDot.label")}
      data-testid={testId}
      className={[
        "block h-[9px] w-[9px] shrink-0 rounded-full bg-warning ring-2 ring-card",
        inline ? "" : "pointer-events-none absolute right-0.5 top-0.5",
      ].join(" ")}
    />
  );
}
