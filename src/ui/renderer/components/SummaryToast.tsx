/**
 * SummaryToast — checkpoint 직후에 표시되는 *이전 컨텍스트 요약* 카드.
 *
 * Layout (2026-05-07): LLM 응답 카드와 동일한 full-width + markdown 본문.
 * 이전엔 max-w-[70%] + 120자 truncate 의 toast 였으나, *내용을 정독하지
 * 않으면 checkpoint 이후 어디까지 정리됐는지 사용자가 알 수 없는* 결함이 있어
 * 정식 카드로 격상. 좌측 border + label 만 남겨 LLM 응답과 시각적
 * 구분.
 */
import ReactMarkdown from "react-markdown";
import { MARKDOWN_REMARK_PLUGINS } from "../utils/markdown-plugins.js";

export function SummaryToast({ summary }: { summary: string }) {
  return (
    <div
      data-testid="summary-toast"
      className="w-full min-w-0 max-w-full border-l-2 border-action-compact/40 bg-action-compact/5 px-4 py-2.5 mb-3 rounded-r"
    >
      <div className="text-[10px] uppercase tracking-wider text-action-compact/80 mb-1.5 font-medium">
        📝 이전 요약
      </div>
      <div
        className="prose prose-sm lvis-prose max-w-none break-words text-sm text-muted-foreground [overflow-wrap:anywhere]"
        data-testid="summary-toast-body"
      >
        <ReactMarkdown remarkPlugins={MARKDOWN_REMARK_PLUGINS}>
          {summary}
        </ReactMarkdown>
      </div>
    </div>
  );
}
