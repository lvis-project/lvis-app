/**
 * SummaryToast — checkpoint 직후에 표시되는 *이전 컨텍스트 요약* 카드.
 *
 * Layout: LLM 응답 카드와 같은 폭을 유지하되 기본은 접힌 상태다.
 * compact 결과는 checkpoint 근거로 남겨야 하지만 긴 요약이 대화 본문을
 * 밀어내면 안 되므로 사용자가 필요할 때만 펼친다.
 */
import ReactMarkdown from "react-markdown";
import { MARKDOWN_REMARK_PLUGINS } from "../utils/markdown-plugins.js";

export function SummaryToast({ summary }: { summary: string }) {
  return (
    <details
      data-testid="summary-toast"
      className="group w-full min-w-0 max-w-full border-l-2 border-action-compact/40 bg-action-compact/5 px-4 py-2.5 mb-3 rounded-r"
    >
      <summary className="cursor-pointer list-none text-[10px] uppercase tracking-wider text-action-compact/80 font-medium marker:hidden">
        <span className="mr-1 inline-block transition-transform group-open:rotate-90">▸</span>
        이전 요약
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
