import { X as XIcon } from "lucide-react";
import { Button } from "../../../components/ui/button.js";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../../components/ui/card.js";
import { Badge } from "../../../components/ui/badge.js";
import { ScrollArea } from "../../../components/ui/scroll-area.js";
import type { LvisApi } from "../types.js";

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
  return (
    <Card className="mx-auto flex min-h-0 min-w-0 flex-1 w-full max-w-6xl flex-col overflow-hidden">
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle>즐겨찾기</CardTitle>
          <Button size="sm" variant="outline" onClick={() => void refreshStarred()}>새로고침</Button>
        </div>
        <CardDescription>별표한 메시지는 전체 대화에서 모아볼 수 있습니다.</CardDescription>
      </CardHeader>
      <CardContent className="flex min-h-0 flex-1 flex-col gap-3">
        <ScrollArea className="flex-1">
          {starred.length === 0 ? (
            <div className="py-8 text-center text-sm text-muted-foreground">즐겨찾기한 메시지가 없습니다.</div>
          ) : (
            <div className="space-y-2 pr-2">
              {starred.map((s) => (
                <div key={s.id} className="rounded-md border p-3 text-sm">
                  <div className="mb-1 flex items-center gap-2 text-[11px] text-muted-foreground">
                    <Badge variant="outline" className="text-[10px]">{s.role}</Badge>
                    <span>{new Date(s.starredAt).toLocaleString("ko-KR")}</span>
                    <span className="font-mono opacity-60">#{s.sessionId.slice(0, 8)}</span>
                    <Button variant="ghost" size="icon-xs" className="ml-auto hover:bg-muted" title="해제" onClick={() => { void api.starredRemove({ id: s.id }).then(() => refreshStarred()); }}>
                      <XIcon className="h-3 w-3" />
                    </Button>
                  </div>
                  <button
                    className="w-full whitespace-pre-wrap break-words text-left text-sm hover:opacity-80"
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
      </CardContent>
    </Card>
  );
}
