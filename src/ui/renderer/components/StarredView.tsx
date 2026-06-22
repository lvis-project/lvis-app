import { X as XIcon } from "lucide-react";
import { Button } from "../../../components/ui/button.js";
import { CardContent, CardDescription, CardHeader, CardTitle } from "../../../components/ui/card.js";
import { Badge } from "../../../components/ui/badge.js";
import { ScrollArea } from "../../../components/ui/scroll-area.js";
import type { LvisApi } from "../types.js";
import { useTranslation } from "../../../i18n/react.js";

export interface StarredItem {
  id: string;
  sessionId: string;
  messageIndex: number;
  role: string;
  text: string;
  starredAt: string;
}

export interface StarredViewProps {
  api: LvisApi;
  starred: StarredItem[];
  currentSessionId: string;
  refreshStarred: () => void | Promise<void>;
  onJumpToSession: (sessionId: string) => boolean | void | Promise<boolean | void>;
  onActivateHome: () => void;
}

export function StarredView({
  api,
  starred,
  currentSessionId,
  refreshStarred,
  onJumpToSession,
  onActivateHome,
}: StarredViewProps) {
  const { t } = useTranslation();
  return (
    <div className="mx-auto flex min-h-0 min-w-0 flex-1 w-full max-w-6xl flex-col overflow-hidden">
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle>{t("starredView.title")}</CardTitle>
          <Button size="sm" variant="outline" onClick={() => void refreshStarred()}>{t("starredView.refresh")}</Button>
        </div>
        <CardDescription>{t("starredView.description")}</CardDescription>
      </CardHeader>
      <CardContent className="flex min-h-0 flex-1 flex-col gap-4">
        <section className="flex min-h-0 flex-col rounded-lg border bg-muted/(--opacity-light) shadow-sm">
          <div className="flex items-center justify-between rounded-t-lg border-b bg-muted/(--opacity-medium) px-3 py-2">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{t("starredView.title")}</h3>
            <span className="flex h-5 min-w-[20px] items-center justify-center rounded-full bg-muted px-1.5 text-[10px] font-semibold text-muted-foreground">
              {starred.length}
            </span>
          </div>
          <ScrollArea className="flex-1">
            {starred.length === 0 ? (
              <div className="py-8 text-center text-sm text-muted-foreground">{t("starredView.emptyState")}</div>
            ) : (
              <div className="space-y-2 p-2">
                {starred.map((s) => (
                  <div key={s.id} className="rounded-lg border bg-background shadow-sm transition-all hover:border-border hover:shadow-md">
                    <div className="flex items-center gap-2 border-b px-3 py-1.5 text-[11px] text-muted-foreground">
                      <Badge variant="outline" className="text-[10px]">{s.role}</Badge>
                      <span>{new Date(s.starredAt).toLocaleString("ko-KR")}</span>
                      <span className="font-mono opacity-60">#{s.sessionId.slice(0, 8)}</span>
                      <Button variant="ghost" size="icon-xs" className="ml-auto hover:bg-muted" title={t("starredView.unstar")} onClick={() => { void api.starredRemove({ id: s.id }).then(() => refreshStarred()); }}>
                        <XIcon className="h-3 w-3" />
                      </Button>
                    </div>
                    <button
                      className="w-full whitespace-pre-wrap break-words p-3 text-left text-sm font-semibold leading-snug text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring hover:opacity-80"
                      onClick={async () => {
                        if (s.sessionId !== currentSessionId) {
                          const jumped = await onJumpToSession(s.sessionId);
                          if (jumped === false) return;
                        }
                        onActivateHome();
                      }}
                    >{s.text.slice(0, 300)}{s.text.length > 300 ? "…" : ""}</button>
                  </div>
                ))}
              </div>
            )}
          </ScrollArea>
        </section>
      </CardContent>
    </div>
  );
}
