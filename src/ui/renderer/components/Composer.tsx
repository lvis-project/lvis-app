import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  type Dispatch,
  type SetStateAction,
} from "react";
import { flushSync } from "react-dom";
import { Loader2, Square } from "lucide-react";
import { Button } from "../../../components/ui/button.js";
import { Textarea } from "../../../components/ui/textarea.js";
import {
  AttachmentChip,
  AttachmentChipCollapsed,
} from "./AttachmentChip.js";
import {
  ATTACH_MAX_COUNT,
  type Attachment,
} from "../types/attachments.js";
import { findMarkerAt, parseMarkers } from "../utils/attachment-markers.js";
import { handleClipboardPaste } from "../utils/clipboard-paste.js";

export interface ComposerHandle {
  focus(): void;
  /**
   * Insert text at the current caret position (or replace selection if any).
   * Used by the action-bar attach flow so file-picker markers land where the
   * user is typing rather than always appending to the end of the body.
   */
  insertAtCursor(insertion: string): void;
}

export interface ComposerProps {
  text: string;
  onTextChange: (next: string) => void;
  attachments: Attachment[];
  /**
   * State setter — accepts a value or a functional updater. The updater
   * form is the only race-safe way to enforce the 5-cap when concurrent
   * paste / picker work is in flight. ChatView wires this directly to
   * `useState`'s setter so both forms work.
   */
  onAttachmentsChange: Dispatch<SetStateAction<Attachment[]>>;
  /** Strictly increasing N counter (parent owns the seed). */
  allocateN: () => number;
  /** Saves clipboard image to OS tmp via main process. */
  saveClipboardImage: (
    base64: string,
  ) => Promise<{
    ok: boolean;
    path?: string;
    width?: number;
    height?: number;
    bytes?: number;
    mimeType?: string;
    dataUrl?: string;
    error?: string;
  }>;
  /** Open via OS default app — for the overlay's open button. */
  openExternal?: (path: string) => Promise<unknown>;
  onSend: () => void;
  onAbort?: () => void;
  streaming?: boolean;
  disabled?: boolean;
  placeholder?: string;
  onWarning?: (message: string) => void;
}

/**
 * Single composer cell — strip(left) + textarea(center) + send(right).
 *
 * Single source of truth: the textarea body holds marker tokens
 * ([Image #N], [File #N], [Pasted text #N +X lines]). The attachment
 * list is derived per-render from `parseMarkers(text)`. When the user
 * deletes a marker, the matching attachment disappears automatically;
 * there is no separate ⓧ button on chips.
 */
export const Composer = forwardRef<ComposerHandle, ComposerProps>(function Composer(
  {
    text,
    onTextChange,
    attachments,
    onAttachmentsChange,
    allocateN,
    saveClipboardImage,
    openExternal,
    onSend,
    onAbort,
    streaming = false,
    disabled = false,
    placeholder,
    onWarning,
  },
  ref,
) {
  const taRef = useRef<HTMLTextAreaElement | null>(null);

  // Live-derive attachments from textarea body (single source of truth).
  // Drop any whose N is no longer present in the body.
  const liveAttachments = useMemo(() => {
    const present = new Set(parseMarkers(text));
    return attachments.filter((a) => present.has(a.n));
  }, [text, attachments]);

  useEffect(() => {
    if (liveAttachments.length !== attachments.length) {
      onAttachmentsChange(liveAttachments);
    }
  }, [liveAttachments, attachments, onAttachmentsChange]);

  const insertAtCursor = useCallback(
    (insertion: string) => {
      const ta = taRef.current;
      if (!ta) {
        onTextChange(text + insertion);
        return;
      }
      const start = ta.selectionStart ?? text.length;
      const end = ta.selectionEnd ?? text.length;
      const next = text.slice(0, start) + insertion + text.slice(end);
      onTextChange(next);
      requestAnimationFrame(() => {
        if (taRef.current) {
          const pos = start + insertion.length;
          taRef.current.setSelectionRange(pos, pos);
          taRef.current.focus();
        }
      });
    },
    [text, onTextChange],
  );

  // Expose imperative API to parents (focus + caret-aware insertion).
  // Deps include `insertAtCursor` (which itself depends on `text` /
  // `onTextChange`), so the handle is recreated whenever the closure's
  // values change — callers via the ref always see the fresh function.
  useImperativeHandle(
    ref,
    () => ({
      focus() { taRef.current?.focus(); },
      insertAtCursor(insertion: string) { insertAtCursor(insertion); },
    }),
    [insertAtCursor],
  );

  const handlePaste = useCallback(
    async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      // When the composer is disabled (no API key, context overflow, etc.)
      // the action-bar attach button is also disabled. Without this
      // short-circuit, clipboard paste would silently bypass that gate
      // and grow attachment state while the user cannot send.
      if (disabled) return;
      const outcome = await handleClipboardPaste(e.nativeEvent, {
        count: liveAttachments.length,
        allocateN,
        saveClipboardImage,
        max: ATTACH_MAX_COUNT,
      });
      if (!outcome.handled) return;
      e.preventDefault();
      if (outcome.warning) onWarning?.(outcome.warning);
      if (outcome.newAttachment) {
        const candidate = outcome.newAttachment;
        // Functional updater + flushSync: re-check the cap against the
        // latest committed state (a concurrent file picker / second paste
        // during the IPC saveClipboardImage await may have filled the 5
        // slots in the meantime). flushSync forces the updater to run
        // synchronously so we know whether the chip was actually inserted
        // before deciding whether to also insert the marker text.
        let inserted = false;
        flushSync(() => {
          onAttachmentsChange((prev) => {
            if (prev.length >= ATTACH_MAX_COUNT) return prev;
            inserted = true;
            return [...prev, candidate];
          });
        });
        if (inserted && outcome.insertText) {
          insertAtCursor(outcome.insertText);
        } else if (!inserted) {
          onWarning?.(
            `첨부 ${ATTACH_MAX_COUNT}개 한도 — 클립보드 paste 가 중간에 차단됨`,
          );
        }
      } else if (outcome.insertText) {
        // Pure-text insert (no chip) — never blocked by the cap.
        insertAtCursor(outcome.insertText);
      }
    },
    [
      disabled,
      liveAttachments,
      allocateN,
      saveClipboardImage,
      onWarning,
      onAttachmentsChange,
      insertAtCursor,
    ],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.nativeEvent.isComposing) return;

      // Backspace inside or at the trailing edge of a `[Image #N]` style
      // marker → delete the whole block in one keystroke (Slack chip UX).
      // Skip when a modifier is held so word-delete (alt+backspace) and
      // line-delete (cmd+backspace) keep their native semantics.
      if (
        e.key === "Backspace" &&
        !e.shiftKey &&
        !e.altKey &&
        !e.ctrlKey &&
        !e.metaKey
      ) {
        const ta = e.currentTarget;
        if (ta.selectionStart === ta.selectionEnd) {
          const range = findMarkerAt(text, ta.selectionStart);
          if (range) {
            e.preventDefault();
            const next = text.slice(0, range.start) + text.slice(range.end);
            onTextChange(next);
            requestAnimationFrame(() => {
              if (taRef.current) {
                taRef.current.setSelectionRange(range.start, range.start);
                taRef.current.focus();
              }
            });
            return;
          }
        }
      }

      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        if (disabled || streaming) return;
        onSend();
      }
    },
    [disabled, streaming, onSend, text, onTextChange],
  );

  const isFull = liveAttachments.length >= ATTACH_MAX_COUNT;

  return (
    <div data-testid="composer" className="px-3">
      <div className="flex items-stretch gap-2 rounded-xl bg-input-bar overflow-hidden shadow-md">
        {/* Strip is rendered ONLY when there is at least one attachment so
            the empty state does not reserve horizontal space. Single chip
            inline; 2+ collapse into a stacked card with an overlay. */}
        {liveAttachments.length === 1 ? (
          <div
            data-testid="composer-strip"
            className="flex items-center pl-3 pr-1"
          >
            <AttachmentChip
              attachment={liveAttachments[0]}
              total={liveAttachments.length}
              onOpenExternal={openExternal}
            />
          </div>
        ) : liveAttachments.length >= 2 ? (
          <div
            data-testid="composer-strip"
            className="flex items-center pl-3 pr-1"
          >
            <AttachmentChipCollapsed
              attachments={liveAttachments}
              onOpenExternal={openExternal}
            />
          </div>
        ) : null}

        <Textarea
          ref={taRef}
          data-testid="composer-textarea"
          value={text}
          onChange={(e) => onTextChange(e.target.value)}
          onPaste={handlePaste}
          onKeyDown={handleKeyDown}
          placeholder={placeholder ?? "질문을 입력하세요... (Cmd/Ctrl+V 로 클립보드 붙여넣기)"}
          className="flex-1 min-h-[64px] border-0 bg-transparent focus-visible:ring-0 focus-visible:ring-offset-0 shadow-none rounded-none text-xs placeholder:text-xs px-4 py-2.5"
        />

        {streaming ? (
          <Button
            variant="destructive"
            onClick={() => onAbort?.()}
            data-testid="composer-abort-button"
            className="rounded-none self-stretch !h-auto w-[72px] px-0 text-xs font-bold"
            title="스트리밍 중단 (Ctrl/Cmd+C)"
          >
            <Square className="h-4 w-4 mr-1" />STOP
          </Button>
        ) : (
          <Button
            onClick={onSend}
            disabled={disabled || (text.trim().length === 0 && liveAttachments.length === 0)}
            data-testid="composer-send-button"
            className="rounded-none self-stretch !h-auto w-[72px] px-0 text-xs font-bold"
          >
            <Loader2 className="h-4 w-4 mr-1 hidden" />SEND
          </Button>
        )}
      </div>
      {isFull ? (
        <div
          data-testid="composer-limit-warning"
          className="mt-1 text-[11px] text-destructive"
        >
          ⚠ 첨부 {ATTACH_MAX_COUNT}개 한도 — 더 추가하려면 textarea 의 [...#N] 마커를 지워주세요
        </div>
      ) : null}
    </div>
  );
});
