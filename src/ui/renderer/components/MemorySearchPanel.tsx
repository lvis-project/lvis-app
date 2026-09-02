import { useState } from "react";
import { Button } from "../../../components/ui/button.js";
import { Input } from "../../../components/ui/input.js";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "../../../components/ui/tabs.js";
import { ScrollArea } from "../../../components/ui/scroll-area.js";
import { memoryProjectOptions, useMemoryCandidates, useMemorySearch, type MemoryCandidateResult, type NoteResult, type SessionResult } from "../hooks/use-memory-search.js";
import type { LvisApi } from "../types.js";
import { t } from "../../../i18n/runtime.js";
import { useTranslation } from "../../../i18n/react.js";
import type { ProjectIdentity } from "../../../shared/project-identity.js";
import { formatRelativeTime, type RelativeTimeLabels } from "../../../shared/format-time.js";
import { shortSessionId } from "../../../shared/session-lookup.js";

const RELATIVE_TIME_LABELS: RelativeTimeLabels = {
  justNow: () => t("memorySearchPanel.justNow"),
  minutesAgo: (minutes) => t("memorySearchPanel.minutesAgo", { minutes }),
  hoursAgo: (hours) => t("memorySearchPanel.hoursAgo", { hours }),
  daysAgo: (days) => t("memorySearchPanel.daysAgo", { days }),
};

function NoteRow({ note }: { note: NoteResult }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <button
      type="button"
      className="group w-full rounded-lg border bg-background px-3 py-3 text-left shadow-sm transition-shadow hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      onClick={() => setExpanded((v) => !v)}
    >
      <div className="flex min-w-0 items-baseline justify-between gap-2">
        <span className="min-w-0 flex-1 line-clamp-1 text-sm font-semibold leading-snug text-foreground">{note.title}</span>
        {note.updatedAt ? (
          <span className="shrink-0 text-[10px] text-muted-foreground">{formatRelativeTime(note.updatedAt, RELATIVE_TIME_LABELS)}</span>
        ) : null}
      </div>
      <p className={`mt-1 text-xs text-muted-foreground ${expanded ? "whitespace-pre-wrap break-words" : "line-clamp-1"}`}>
        {note.excerpt}
      </p>
    </button>
  );
}

function SessionRow({
  session,
  onOpenSession,
}: {
  session: SessionResult;
  onOpenSession?: (sessionId: string) => void | boolean | Promise<void | boolean>;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);

  const handleClick = async () => {
    setFailed(false);
    if (!onOpenSession) {
      setExpanded((v) => !v);
      return;
    }
    setLoading(true);
    try {
      const loaded = await onOpenSession(session.sessionId);
      if (loaded === false) {
        setFailed(true);
        setExpanded(true);
      }
    } catch {
      setFailed(true);
      setExpanded(true);
    } finally {
      setLoading(false);
    }
  };

  return (
    <button
      type="button"
      className="group w-full rounded-lg border bg-background px-3 py-3 text-left shadow-sm transition-shadow hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      onClick={() => void handleClick()}
      aria-label={t("memorySearchPanel.openChatAriaLabel", { title: session.title ?? shortSessionId(session.sessionId) })}
    >
      <div className="flex min-w-0 items-baseline justify-between gap-2">
        <span className="min-w-0 flex-1 line-clamp-1 text-sm font-semibold leading-snug text-foreground">
          {session.title || t("memorySearchPanel.sessionFallbackTitle", { id: shortSessionId(session.sessionId) })}
        </span>
        <span className="shrink-0 text-[10px] text-muted-foreground">{formatRelativeTime(session.timestamp, RELATIVE_TIME_LABELS)}</span>
      </div>
      <div className="mt-1 flex min-w-0 items-center justify-between gap-2">
        <span className="min-w-0 line-clamp-1 font-mono text-[10px] text-muted-foreground">
          {shortSessionId(session.sessionId)}
        </span>
        <span className="shrink-0 text-[10px] text-muted-foreground">
          {loading ? t("memorySearchPanel.loading") : failed ? t("memorySearchPanel.loadFailed") : onOpenSession ? t("memorySearchPanel.clickToOpen") : t("memorySearchPanel.clickToExpand")}
        </span>
      </div>
      <p className={`mt-1 text-xs text-muted-foreground ${expanded ? "whitespace-pre-wrap break-words" : "line-clamp-1"}`}>
        {session.matchedMessage}
      </p>
    </button>
  );
}

type CandidateAction = "activate" | "delete";

type CandidateActionResult = {
  ok: boolean;
  error?: string;
};

type CandidateActionApi = {
  memoryActivateCandidate?: (id: string, opts?: ReturnType<typeof memoryProjectOptions>) => Promise<CandidateActionResult>;
  memoryDeleteCandidate?: (id: string, opts?: ReturnType<typeof memoryProjectOptions>) => Promise<CandidateActionResult>;
};

function candidateScopeLabel(candidate: MemoryCandidateResult): string {
  return candidate.projectRoot
    ? t("memorySearchPanel.candidateProjectScope")
    : t("memorySearchPanel.candidateGlobalScope");
}

function CandidateRow({
  candidate,
  busy,
  onAction,
}: {
  candidate: MemoryCandidateResult;
  busy: boolean;
  onAction: (candidate: MemoryCandidateResult, action: CandidateAction) => void;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const timestamp = candidate.createdAt ?? candidate.updatedAt;

  return (
    <article className="rounded-lg border bg-background shadow-sm" data-testid={`memory-candidate-${candidate.id}`}>
      <button
        type="button"
        className="group w-full px-3 py-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
        aria-label={t("memorySearchPanel.candidateContentAriaLabel", { title: candidate.title })}
      >
        <div className="flex min-w-0 items-baseline justify-between gap-2">
          <span className="min-w-0 flex-1 line-clamp-1 text-sm font-semibold leading-snug text-foreground">{candidate.title}</span>
          {timestamp ? <span className="shrink-0 text-[10px] text-muted-foreground">{formatRelativeTime(timestamp, RELATIVE_TIME_LABELS)}</span> : null}
        </div>
        <p className={`mt-1 text-xs text-muted-foreground ${expanded ? "whitespace-pre-wrap break-words" : "line-clamp-1"}`}>
          {candidate.excerpt}
        </p>
      </button>
      <div className="flex flex-wrap items-center justify-between gap-2 border-t px-3 py-2">
        <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
          <span>{candidateScopeLabel(candidate)}</span>
          {candidate.source === "assistant" ? <span>· {t("memorySearchPanel.candidateAssistantSource")}</span> : null}
        </div>
        <div className="flex gap-2" role="group" aria-label={t("memorySearchPanel.candidateActionsAriaLabel", { title: candidate.title })}>
          <Button
            type="button"
            size="sm"
            disabled={busy}
            onClick={() => onAction(candidate, "activate")}
            aria-label={t("memorySearchPanel.approveCandidateAriaLabel", { title: candidate.title })}
          >
            {t("memorySearchPanel.approveCandidate")}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => onAction(candidate, "delete")}
            aria-label={t("memorySearchPanel.discardCandidateAriaLabel", { title: candidate.title })}
          >
            {t("memorySearchPanel.discardCandidate")}
          </Button>
        </div>
      </div>
    </article>
  );
}

export interface MemorySearchPanelProps {
  api: LvisApi;
  project?: ProjectIdentity;
  onOpenSession?: (sessionId: string) => void | boolean | Promise<void | boolean>;
}

export function MemorySearchPanel({ api, project, onOpenSession }: MemorySearchPanelProps) {
  const { t } = useTranslation();
  const { query, setQuery, noteResults, sessionResults, loading, refresh: refreshMemory } = useMemorySearch(api, project);
  const { candidates, loading: candidatesLoading, refresh: refreshCandidates } = useMemoryCandidates(api, project);
  const [candidateActionBusy, setCandidateActionBusy] = useState<string | null>(null);
  const [candidateActionError, setCandidateActionError] = useState<string | null>(null);

  const handleCandidateAction = async (candidate: MemoryCandidateResult, action: CandidateAction) => {
    const candidateApi = api as LvisApi & CandidateActionApi;
    const operation = action === "activate"
      ? candidateApi.memoryActivateCandidate
      : candidateApi.memoryDeleteCandidate;
    if (!operation) {
      setCandidateActionError(t("memorySearchPanel.candidateActionFailed"));
      return;
    }

    setCandidateActionBusy(candidate.id);
    setCandidateActionError(null);
    try {
      const opts = memoryProjectOptions(project);
      const result = opts
        ? await operation(candidate.id, opts)
        : await operation(candidate.id);
      if (!result?.ok) {
        setCandidateActionError(t("memorySearchPanel.candidateActionFailed"));
        return;
      }
      await Promise.all([refreshCandidates(), refreshMemory()]);
    } catch {
      setCandidateActionError(t("memorySearchPanel.candidateActionFailed"));
    } finally {
      setCandidateActionBusy(null);
    }
  };

  return (
    <div
      className="mx-auto flex min-h-0 min-w-0 flex-1 w-full max-w-6xl flex-col overflow-hidden"
      data-testid="memory-search-panel"
    >
      <p className="pb-4 text-sm text-muted-foreground">{t("memorySearchPanel.panelDescription")}</p>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3">
        <Input
          placeholder={t("memorySearchPanel.searchPlaceholder")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="text-sm"
          aria-label={t("memorySearchPanel.searchAriaLabel")}
        />
        <Tabs defaultValue="notes" className="flex min-h-0 min-w-0 flex-1 flex-col">
          <TabsList className="w-full">
            <TabsTrigger value="notes" className="flex-1 gap-1.5">
              {t("memorySearchPanel.notesTab")}
              {noteResults.length > 0 && (
                <span className="inline-flex items-center rounded-full bg-primary px-1.5 py-0.5 text-[10px] font-semibold leading-none text-primary-foreground">
                  {noteResults.length}
                </span>
              )}
            </TabsTrigger>
            <TabsTrigger value="sessions" className="flex-1 gap-1.5">
              {t("memorySearchPanel.sessionsTab")}
              {sessionResults.length > 0 && (
                <span className="inline-flex items-center rounded-full bg-primary px-1.5 py-0.5 text-[10px] font-semibold leading-none text-primary-foreground">
                  {sessionResults.length}
                </span>
              )}
            </TabsTrigger>
            <TabsTrigger value="review" className="flex-1 gap-1.5">
              {t("memorySearchPanel.reviewTab")}
              {candidates.length > 0 && (
                <span className="inline-flex items-center rounded-full bg-primary px-1.5 py-0.5 text-[10px] font-semibold leading-none text-primary-foreground">
                  {candidates.length}
                </span>
              )}
            </TabsTrigger>
          </TabsList>
          <TabsContent value="notes" className="mt-2 flex-1 min-h-0 overflow-hidden rounded-lg border">
            {noteResults.length > 0 && !loading && (
              <div className="flex items-center rounded-t-lg border-b bg-muted/(--opacity-medium) px-3 py-2">
                <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  {t("memorySearchPanel.notesTab")}
                </span>
              </div>
            )}
            <ScrollArea className="h-full pr-2">
              <div className="flex flex-col gap-2 p-3">
                {loading ? (
                  <p className="py-4 text-xs text-muted-foreground">{t("memorySearchPanel.searching")}</p>
                ) : noteResults.length === 0 ? (
                  <p className="py-4 text-xs text-muted-foreground">
                    {query === "" ? t("memorySearchPanel.noNotesEmpty") : t("memorySearchPanel.noResults")}
                  </p>
                ) : (
                  noteResults.map((n) => <NoteRow key={n.title + n.updatedAt} note={n} />)
                )}
              </div>
            </ScrollArea>
          </TabsContent>
          <TabsContent value="sessions" className="mt-2 flex-1 min-h-0 overflow-hidden rounded-lg border">
            {sessionResults.length > 0 && !loading && (
              <div className="flex items-center rounded-t-lg border-b bg-muted/(--opacity-medium) px-3 py-2">
                <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  {t("memorySearchPanel.sessionsTab")}
                </span>
              </div>
            )}
            <ScrollArea className="h-full pr-2">
              <div className="flex flex-col gap-2 p-3">
                {loading ? (
                  <p className="py-4 text-xs text-muted-foreground">{t("memorySearchPanel.searching")}</p>
                ) : sessionResults.length === 0 ? (
                  <p className="py-4 text-xs text-muted-foreground">
                    {query === "" ? t("memorySearchPanel.noSessionsEmpty") : t("memorySearchPanel.noResults")}
                  </p>
                ) : (
                  sessionResults.map((s) => (
                    <SessionRow
                      key={s.sessionId + s.timestamp}
                      session={s}
                      onOpenSession={onOpenSession}
                    />
                  ))
                )}
              </div>
            </ScrollArea>
          </TabsContent>
          <TabsContent value="review" className="mt-2 flex-1 min-h-0 overflow-hidden rounded-lg border">
            {candidateActionError ? (
              <p className="border-b px-3 py-2 text-xs text-destructive" role="alert">
                {candidateActionError}
              </p>
            ) : null}
            <ScrollArea className="h-full pr-2">
              <div className="flex flex-col gap-2 p-3">
                {candidatesLoading ? (
                  <p className="py-4 text-xs text-muted-foreground">{t("memorySearchPanel.searching")}</p>
                ) : candidates.length === 0 ? (
                  <p className="py-4 text-xs text-muted-foreground">{t("memorySearchPanel.noCandidatesEmpty")}</p>
                ) : (
                  candidates.map((candidate) => (
                    <CandidateRow
                      key={candidate.id}
                      candidate={candidate}
                      busy={candidateActionBusy === candidate.id}
                      onAction={(entry, action) => void handleCandidateAction(entry, action)}
                    />
                  ))
                )}
              </div>
            </ScrollArea>
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
