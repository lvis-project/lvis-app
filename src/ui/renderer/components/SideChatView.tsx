/**
 * SideChatView — the lightweight side-chat transcript + composer rendered in the
 * workspace-rail `side-chat` tab.
 *
 * Deliberately bespoke and lightweight (spec R5): it reuses the AssistantCard
 * PRIMITIVE for assistant bubbles but does NOT pull in the heavy main-chat
 * ChatContext / ChatTranscript / ChatComposerDock (checkpoint, fork, star,
 * compact, token-cost, persona machinery). User messages render as a plain
 * bubble. All streaming is driven by `useSideChat`, which subscribes to the
 * DEDICATED side-chat IPC channel so main-chat frames never appear here.
 */
import { useLayoutEffect, useRef, useState } from "react";
import { Send, Square, Plus } from "lucide-react";
import { useTranslation } from "../../../i18n/react.js";
import { Button } from "../../../components/ui/button.js";
import { Textarea } from "../../../components/ui/textarea.js";
import { AssistantCard } from "./AssistantCard.js";
import { useSideChat, toAssistantChatEntry } from "../hooks/use-side-chat.js";
import type { LvisApi } from "../types.js";

export function SideChatView({ api }: { api: LvisApi }) {
  const { t } = useTranslation();
  const { messages, isStreaming, send, newSession, abort } = useSideChat(api);
  const [draft, setDraft] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to the latest message as the transcript grows / streams.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  // If side chat is unavailable (preload without the surface), surface a stable
  // disabled state rather than a broken composer.
  const available = !!api.sideChat;

  const submit = () => {
    const text = draft.trim();
    if (!text || isStreaming) return;
    setDraft("");
    void send(text);
  };

  if (!available) {
    return (
      <div
        className="p-4 text-xs text-muted-foreground"
        data-testid="chat-side-panel-side-chat-unavailable"
      >
        {t("chatPreviewRail.sideChat.unavailable")}
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="side-chat-view">
      <div className="flex shrink-0 items-center justify-between border-b px-3 py-1.5">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          {t("chatPreviewRail.sideChat.title")}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-6 gap-1 px-1.5 text-[11px]"
          onClick={() => void newSession()}
          data-testid="side-chat-new"
          aria-label={t("chatPreviewRail.sideChat.newSession")}
        >
          <Plus className="h-3 w-3" />
          {t("chatPreviewRail.sideChat.newSession")}
        </Button>
      </div>

      <div
        ref={scrollRef}
        className="min-h-0 flex-1 space-y-1 overflow-y-auto px-3 py-2"
        data-testid="side-chat-transcript"
      >
        {messages.length === 0 ? (
          <div className="pt-6 text-center text-xs text-muted-foreground">
            {t("chatPreviewRail.sideChat.empty")}
          </div>
        ) : (
          messages.map((entry, i) =>
            entry.kind === "user" ? (
              <div
                key={i}
                className="ml-auto max-w-[85%] rounded-lg bg-muted/(--opacity-medium) px-3 py-1.5 text-sm"
                data-testid="side-chat-user-message"
              >
                {entry.text}
              </div>
            ) : (
              <AssistantCard key={i} entry={toAssistantChatEntry(entry)} />
            ),
          )
        )}
      </div>

      <div className="shrink-0 border-t p-2">
        <div className="flex items-end gap-1.5">
          <Textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            placeholder={t("chatPreviewRail.sideChat.placeholder")}
            rows={2}
            className="min-h-0 resize-none text-sm"
            data-testid="side-chat-composer"
          />
          {isStreaming ? (
            <Button
              type="button"
              size="icon"
              variant="outline"
              className="h-8 w-8 shrink-0"
              onClick={() => void abort()}
              data-testid="side-chat-abort"
              aria-label={t("chatPreviewRail.sideChat.stop")}
            >
              <Square className="h-3.5 w-3.5" />
            </Button>
          ) : (
            <Button
              type="button"
              size="icon"
              className="h-8 w-8 shrink-0"
              onClick={submit}
              disabled={draft.trim().length === 0}
              data-testid="side-chat-send"
              aria-label={t("chatPreviewRail.sideChat.send")}
            >
              <Send className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
