import { Search } from "lucide-react";
import { Input } from "../../../components/ui/input.js";
import { useTranslation } from "../../../i18n/react.js";
import type { LvisApi } from "../types.js";
import type { ChatPreviewTarget } from "../preview/preview-targets.js";
import { useVerticalSplit } from "../hooks/use-vertical-split.js";
import { VerticalSplitLayout } from "./VerticalSplitLayout.js";
import {
  DetailHeader,
  EmptyState,
  PreviewBody,
  statusTone,
  targetIcon,
} from "./chat-side-panel-preview.js";

export function SearchInput({
  query,
  setQuery,
  placeholder,
}: {
  query: string;
  setQuery: (query: string) => void;
  placeholder: string;
}) {
  return (
    <div className="shrink-0 border-b px-3 py-2">
      <div className="relative">
        <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          data-testid="chat-preview-search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={placeholder}
          className="h-8 w-full pl-7 text-xs"
        />
      </div>
    </div>
  );
}

export function TargetRows({
  targets,
  selectedId,
  rowTestId,
  onSelect,
}: {
  targets: ChatPreviewTarget[];
  selectedId?: string;
  rowTestId: string;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="space-y-1">
      {targets.map((target) => (
        <button
          key={target.id}
          type="button"
          data-testid={rowTestId}
          className={`flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-2 text-left text-xs hover:bg-muted/(--opacity-muted) ${
            selectedId === target.id ? "bg-accent text-accent-foreground" : ""
          }`}
          onClick={() => onSelect(target.id)}
        >
          <span className="shrink-0 text-muted-foreground">{targetIcon(target.kind)}</span>
          <span className="min-w-0 flex-1">
            <span className="block truncate font-medium">{target.title}</span>
            <span className="block truncate text-[10.5px] text-muted-foreground">{target.subtitle ?? target.sourceLabel}</span>
          </span>
          {target.status ? <span className={`shrink-0 text-[10px] ${statusTone(target.status)}`}>{target.status}</span> : null}
        </button>
      ))}
    </div>
  );
}

export function ListDetailWorkspace({
  api,
  sessionId,
  query,
  setQuery,
  placeholder,
  rows,
  selectedTarget,
  emptyText,
  rowTestId,
  onSelect,
}: {
  api: LvisApi;
  sessionId?: string;
  query: string;
  setQuery: (query: string) => void;
  placeholder: string;
  rows: ChatPreviewTarget[];
  selectedTarget: ChatPreviewTarget | null;
  emptyText: string;
  rowTestId: string;
  onSelect: (id: string) => void;
}) {
  const { topPercent, setTopPercent, commitTopPercent } = useVerticalSplit(api, "sidePanelSplitPreviewPercent");
  const { t } = useTranslation();
  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden">
      <SearchInput query={query} setQuery={setQuery} placeholder={placeholder} />
      <VerticalSplitLayout
        topPercent={topPercent}
        onDragChange={setTopPercent}
        onCommit={commitTopPercent}
        ariaLabel={t("chatPreviewRail.resizePreviewPanels")}
        testId="chat-side-panel-preview-split-layout"
        separatorTestId="chat-side-panel-preview-splitter"
        top={
          <div className="min-h-0 p-2">
            {rows.length > 0 ? (
              <TargetRows targets={rows} selectedId={selectedTarget?.id} rowTestId={rowTestId} onSelect={onSelect} />
            ) : (
              <EmptyState>{emptyText}</EmptyState>
            )}
          </div>
        }
        bottom={
          <div className="min-h-0 p-3">
            {selectedTarget ? (
              <div className="space-y-3">
                <DetailHeader target={selectedTarget} />
                <PreviewBody api={api} sessionId={sessionId} target={selectedTarget} />
              </div>
            ) : (
              <div className="text-xs text-muted-foreground">{emptyText}</div>
            )}
          </div>
        }
      />
    </div>
  );
}
