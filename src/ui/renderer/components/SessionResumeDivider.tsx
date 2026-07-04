import { useTranslation } from "../../../i18n/react.js";




export function SessionResumeDivider({ preambleChars }: { preambleChars: number }) {
  const { t } = useTranslation();
  return (
    <div
      data-testid="session-resume-divider"
      className="flex items-center gap-2 py-2 my-2"
    >
      <span className="h-px flex-1 bg-success/(--opacity-muted)" />
      <span className="text-[10px] text-success/(--opacity-emphatic) font-medium">
        {t("sessionResumeDivider.resumeLabel", { preambleChars })}
      </span>
      <span className="h-px flex-1 bg-success/(--opacity-muted)" />
    </div>
  );
}
