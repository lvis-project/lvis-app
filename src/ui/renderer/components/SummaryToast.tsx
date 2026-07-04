



import ReactMarkdown from "react-markdown";
import { useTranslation } from "../../../i18n/react.js";
import { MARKDOWN_REMARK_PLUGINS } from "../utils/markdown-plugins.js";

export function SummaryToast({ summary }: { summary: string }) {
  const { t } = useTranslation();
  return (
    <details
      data-testid="summary-toast"
      className="group w-full min-w-0 max-w-full border-l-2 border-action-compact/(--opacity-medium) bg-action-compact/(--opacity-faint) px-4 py-2.5 mb-3 rounded-r"
    >
      <summary className="cursor-pointer list-none text-[10px] uppercase tracking-wider text-action-compact/(--opacity-intense) font-medium marker:hidden">
        <span className="mr-1 inline-block transition-transform group-open:rotate-90">▸</span>
        {t("summaryToast.previousSummary")}
      </summary>
      <div
        className="prose prose-sm lvis-prose mt-2 max-w-none break-words text-sm text-muted-foreground [overflow-wrap:anywhere]"
        data-testid="summary-toast-body"
      >
        <ReactMarkdown remarkPlugins={MARKDOWN_REMARK_PLUGINS}>
          {summary}
        </ReactMarkdown>
      </div>
    </details>
  );
}
