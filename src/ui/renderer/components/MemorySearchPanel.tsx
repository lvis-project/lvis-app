import { useState } from "react";
import { Input } from "../../../components/ui/input.js";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "../../../components/ui/tabs.js";
import { ScrollArea } from "../../../components/ui/scroll-area.js";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../../components/ui/card.js";
import { useMemorySearch, type NoteResult, type SessionResult } from "../hooks/use-memory-search.js";
import type { LvisApi } from "../types.js";
import { t } from "../../../i18n/runtime.js";
import { useTranslation } from "../../../i18n/react.js";

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return t("memorySearchPanel.justNow");
  if (minutes < 60) return t("memorySearchPanel.minutesAgo", { minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t("memorySearchPanel.hoursAgo", { hours });
  const days = Math.floor(hours / 24);
  return t("memorySearchPanel.daysAgo", { days });
}

function NoteRow({ note }: { note: NoteResult }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <button
      type="button"
      className="group w-full rounded-lg border bg-background px-3 py-3 text-left shadow-sm transition-shadow hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      onClick={() => setExpanded((v) => !v)}
    >
      <div className="flex min-w-0 items-baseline justify-between gap-2">
        <span className="min-w-0 flex-1 truncate text-sm font-semibold leading-snug text-foreground">{note.title}</span>
        {note.updatedAt ? (
          <span className="shrink-0 text-[10px] text-muted-foreground">{relativeTime(note.updatedAt)}</span>
        ) : null}
      </div>
      <p className={`mt-1 text-xs text-muted-foreground ${expanded ? "whitespace-pre-wrap break-words" : "truncate"}`}>
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
      aria-label={t("memorySearchPanel.openChatAriaLabel", { title: session.title ?? session.sessionId.slice(0, 8) })}
    >
      <div className="flex min-w-0 items-baseline justify-between gap-2">
        <span className="min-w-0 flex-1 truncate text-sm font-semibold leading-snug text-foreground">
          {session.title || t("memorySearchPanel.sessionFallbackTitle", { id: session.sessionId.slice(0, 8) })}
        </span>
        <span className="shrink-0 text-[10px] text-muted-foreground">{relativeTime(session.timestamp)}</span>
      </div>
      <div className="mt-1 flex min-w-0 items-center justify-between gap-2">
        <span className="min-w-0 truncate font-mono text-[10px] text-muted-foreground">
          {session.sessionId.slice(0, 8)}
        </span>
        <span className="shrink-0 text-[10px] text-muted-foreground">
          {loading ? t("memorySearchPanel.loading") : failed ? t("memorySearchPanel.loadFailed") : onOpenSession ? t("memorySearchPanel.clickToOpen") : t("memorySearchPanel.clickToExpand")}
        </span>
      </div>
      <p className={`mt-1 text-xs text-muted-foreground ${expanded ? "whitespace-pre-wrap break-words" : "truncate"}`}>
        {session.matchedMessage}
      </p>
    </button>
  );
}

export interface MemorySearchPanelProps {
  api: LvisApi;
  onOpenSession?: (sessionId: string) => void | boolean | Promise<void | boolean>;
}

export function MemorySearchPanel({ api, onOpenSession }: MemorySearchPanelProps) {
  const { t } = useTranslation();
  const { query, setQuery, noteResults, sessionResults, loading } = useMemorySearch(api);

  return (
    <Card className="mx-auto flex min-h-0 min-w-0 flex-1 w-full max-w-6xl flex-col overflow-hidden">
      <CardHeader className="pb-4">
        <CardTitle>{t("memorySearchPanel.panelTitle")}</CardTitle>
        <CardDescription>{t("memorySearchPanel.panelDescription")}</CardDescription>
      </CardHeader>
      <CardContent className="flex min-h-0 min-w-0 flex-1 flex-col gap-3">
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
          </TabsList>
          <TabsContent value="notes" className="mt-2 flex-1 min-h-0 overflow-hidden rounded-lg border">
            {noteResults.length > 0 && !loading && (
              <div className="flex items-center rounded-t-lg border-b bg-muted/40 px-3 py-2">
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
              <div className="flex items-center rounded-t-lg border-b bg-muted/40 px-3 py-2">
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
        </Tabs>
      </CardContent>
    </Card>
  );
}
