import { useState } from "react";
import { Input } from "../../../components/ui/input.js";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "../../../components/ui/tabs.js";
import { ScrollArea } from "../../../components/ui/scroll-area.js";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../../components/ui/card.js";
import { Button } from "../../../components/ui/button.js";
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
    <Button
      type="button"
      variant="ghost"
      className="h-auto w-full flex-col items-stretch justify-start rounded-none border-b border-border/50 px-3 py-2 text-left last:border-0 hover:bg-muted/50"
      onClick={() => setExpanded((v) => !v)}
    >
      <div className="flex min-w-0 items-baseline justify-between gap-2">
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{note.title}</span>
        {note.updatedAt ? (
          <span className="text-[10px] text-muted-foreground shrink-0">{relativeTime(note.updatedAt)}</span>
        ) : null}
      </div>
      <p className={`text-xs text-muted-foreground mt-0.5 ${expanded ? "whitespace-pre-wrap break-words" : "truncate"}`}>
        {note.excerpt}
      </p>
    </Button>
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
    <Button
      type="button"
      variant="ghost"
      className="h-auto w-full flex-col items-stretch justify-start rounded-none border-b border-border/50 px-3 py-2 text-left last:border-0 hover:bg-muted/50"
      onClick={() => void handleClick()}
      aria-label={t("memorySearchPanel.openChatAriaLabel", { title: session.title ?? session.sessionId.slice(0, 8) })}
    >
      <div className="flex min-w-0 items-baseline justify-between gap-2">
        <span className="min-w-0 flex-1 truncate text-sm font-medium">
          {session.title || t("memorySearchPanel.sessionFallbackTitle", { id: session.sessionId.slice(0, 8) })}
        </span>
        <span className="text-[10px] text-muted-foreground shrink-0">{relativeTime(session.timestamp)}</span>
      </div>
      <div className="mt-0.5 flex min-w-0 items-center justify-between gap-2">
        <span className="min-w-0 truncate font-mono text-[10px] text-muted-foreground">
          {session.sessionId.slice(0, 8)}
        </span>
        <span className="shrink-0 text-[10px] text-muted-foreground">
          {loading ? t("memorySearchPanel.loading") : failed ? t("memorySearchPanel.loadFailed") : onOpenSession ? t("memorySearchPanel.clickToOpen") : t("memorySearchPanel.clickToExpand")}
        </span>
      </div>
      <p className={`text-xs text-muted-foreground mt-0.5 ${expanded ? "whitespace-pre-wrap break-words" : "truncate"}`}>
        {session.matchedMessage}
      </p>
    </Button>
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
            <TabsTrigger value="notes" className="flex-1">
              {t("memorySearchPanel.notesTab")}{noteResults.length > 0 ? ` (${noteResults.length})` : ""}
            </TabsTrigger>
            <TabsTrigger value="sessions" className="flex-1">
              {t("memorySearchPanel.sessionsTab")}{sessionResults.length > 0 ? ` (${sessionResults.length})` : ""}
            </TabsTrigger>
          </TabsList>
          <TabsContent value="notes" className="mt-2 flex-1 min-h-0 overflow-hidden">
            <ScrollArea className="h-full pr-2">
              {loading ? (
                <p className="px-3 py-4 text-xs text-muted-foreground">{t("memorySearchPanel.searching")}</p>
              ) : noteResults.length === 0 ? (
                <p className="px-3 py-4 text-xs text-muted-foreground">
                  {query === "" ? t("memorySearchPanel.noNotesEmpty") : t("memorySearchPanel.noResults")}
                </p>
              ) : (
                noteResults.map((n) => <NoteRow key={n.title + n.updatedAt} note={n} />)
              )}
            </ScrollArea>
          </TabsContent>
          <TabsContent value="sessions" className="mt-2 flex-1 min-h-0 overflow-hidden">
            <ScrollArea className="h-full pr-2">
              {loading ? (
                <p className="px-3 py-4 text-xs text-muted-foreground">{t("memorySearchPanel.searching")}</p>
              ) : sessionResults.length === 0 ? (
                <p className="px-3 py-4 text-xs text-muted-foreground">
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
            </ScrollArea>
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}
