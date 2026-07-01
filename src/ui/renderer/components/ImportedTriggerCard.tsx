import ReactMarkdown from "react-markdown";
import type { ChatEntry } from "../../../lib/chat-stream-state.js";
import { parseImportedTriggerEnvelope } from "../../../shared/overlay-trigger-source.js";
import { MARKDOWN_REMARK_PLUGINS } from "../utils/markdown-plugins.js";

type ImportedTriggerEntry = Extract<ChatEntry, { kind: "imported_trigger" }>;

export function ImportedTriggerCard({ entry }: { entry: ImportedTriggerEntry }) {
  // Parse envelope source tag to confirm overlay trigger provenance.
  // title + summary fields are already clean (set at insert time).
  const envelopeSource = parseImportedTriggerEnvelope(entry.prompt);
  return (
    <div
      className="mx-3 my-1 rounded border border-action-view/(--opacity-light) bg-action-view/(--opacity-faint) px-3 py-2 text-xs"
    >
      <div className="flex min-w-0 items-center gap-1 text-action-view font-medium">
        <span className="shrink-0">●</span>
        <span className="min-w-0 break-words [overflow-wrap:anywhere]">{envelopeSource ?? entry.summary.slice(0, 60)}</span>
      </div>
      {entry.summary && (
        <div className="mt-1 text-muted-foreground prose prose-sm lvis-prose max-w-none break-words [overflow-wrap:anywhere]">
          <ReactMarkdown remarkPlugins={MARKDOWN_REMARK_PLUGINS}>
            {entry.summary}
          </ReactMarkdown>
        </div>
      )}
    </div>
  );
}
