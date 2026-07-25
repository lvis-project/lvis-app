import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import { flushSync } from "react-dom";
import { useTranslation } from "../../../i18n/react.js";
import { Textarea } from "../../../components/ui/textarea.js";
import {
  AttachmentChip,
  AttachmentChipCollapsed,
} from "./AttachmentChip.js";
import {
  ATTACH_MAX_COUNT,
  type Attachment,
  type ResourceAttachment,
} from "../types/attachments.js";
import { findMarkerAt, parseMarkers } from "../utils/attachment-markers.js";
import { handleClipboardPaste } from "../utils/clipboard-paste.js";
import { InlineSlashMenu } from "./InlineSlashMenu.js";
import { ResourceMentionMenu } from "./ResourceMentionMenu.js";
import { McpResourceTemplateDialog } from "../dialogs/McpResourceTemplateDialog.js";
import { useInlineSlashMenu } from "../hooks/use-inline-slash-menu.js";
import { useResourceMention } from "../hooks/use-resource-mention.js";
import { useSlashPickerRuntime } from "../hooks/use-slash-picker-runtime.js";
import type { QuickAction } from "./command-actions.js";
import type { PluginEntry } from "./PluginGridButton.js";
import type { UserKeyboardIntentSnapshot } from "../../../shared/chat-origin.js";
import { SuggestedRepliesGhost } from "./SuggestedRepliesGhost.js";
import { SuggestedRepliesChipRow } from "./SuggestedRepliesChipRow.js";
import {
  acceptSuggestedReply,
  clearDismissedReplies,
  dismissSuggestedReplies,
  type SuggestedRepliesSnapshot,
} from "../hooks/use-suggested-replies.js";


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
  onSend: (intent: UserKeyboardIntentSnapshot) => void;


  disabled?: boolean;
  placeholder?: string;
  onWarning?: (message: string) => void;
  /**
   * Suggested-replies snapshot from `useSuggestedReplies()`. Composer renders
   * (a) `best` as ghost text inside the textarea when value is empty + not
   * dismissed, and (b) `alternates` as a chip row above the textarea. Tab
   * fills the best suggestion; Escape dismisses the current snapshot.
   *
   * Spec: `docs/architecture/proposals/suggested-replies-ghost-text.md` §6.2.
   */
  suggestedReplies?: SuggestedRepliesSnapshot;



  commandActions?: QuickAction[];
  /** Installed plugins surfaced under the inline menu's `plugin` category. */
  inlinePlugins?: PluginEntry[];
  /** Open a plugin view when its inline-menu item is accepted. */
  onSelectPlugin?: (viewKey: string) => void;
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
/**
 * Stable fallback for the optional plugin-select prop.
 *
 * An inline `?? (() => {})` mints a new function every render, which propagates into
 * the inline menu's memoized item list and from there into the memoized keydown
 * handler — so the handler is rebuilt on every render and a missing dependency in it
 * cannot be observed. It stayed invisible in production only because the real caller
 * always passes a memoized handler; the component should not depend on that.
 */
const NOOP_SELECT_PLUGIN = () => {};

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
    disabled = false,
    placeholder,
    onWarning,
    suggestedReplies,
    commandActions = [],
    inlinePlugins = [],
    onSelectPlugin,
  },
  ref,
) {
  const { t } = useTranslation();
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  // Mirror of the controlled value for callbacks that outlive the render they were
  // created in — the asynchronous resource attach is the one that needs it.
  const textRef = useRef(text);
  textRef.current = text;


  // because `e.nativeEvent.isComposing` is only available inside keydown — the
  // ghost render path needs the value at render time, not just on key events.
  const [isComposing, setIsComposing] = useState(false);
  const isComposingRef = useRef(false);
  // PR-D ↑/↓ chip cycle: index of the currently-focused alternate chip, or
  // `null` when focus is in the textarea. Composer owns this state so the
  // textarea's keydown handler can advance it (ChipRow is otherwise a leaf
  // and would have no way to know about the textarea's key events).
  const [chipFocusIdx, setChipFocusIdx] = useState<number | null>(null);
  // Caret mirror — the inline "/" menu needs the cursor index, but the value is
  // controlled so selectionStart lives only on the DOM node. Synced on every
  // event that can move the caret (change / keyup / click / select).
  const [caret, setCaret] = useState(0);
  const syncCaret = useCallback(() => {
    const ta = taRef.current;
    if (ta) setCaret(ta.selectionStart ?? 0);
  }, []);

  // Live MCP-server tools + registered skills back the inline menu's mcp /
  // skills categories (real host IPC). Fetched only while the composer is
  // enabled so it stays parallel with the SlashPicker popover's data.
  const { mcpTools, skills } = useSlashPickerRuntime(!disabled);

  // Inline "/" autocomplete — derives an open/filtered menu from the controlled
  // text + caret and owns accept/replace. Keyboard nav is wired into
  // handleKeyDown below; rendering is the InlineSlashMenu at the end.
  const inlineSlash = useInlineSlashMenu({
    text,
    caret,
    enabled: !disabled,
    isComposing,
    commandActions,
    plugins: inlinePlugins,
    mcpTools,
    skills,
    onSelectPlugin: onSelectPlugin ?? NOOP_SELECT_PLUGIN,
    taRef,
    onTextChange,
  });
  const {
    open: inlineOpen,
    move: inlineMove,
    accept: inlineAccept,
    close: inlineClose,
  } = inlineSlash;


  const captureUserKeyboardIntent = useCallback((): UserKeyboardIntentSnapshot => {
    const api = (globalThis as typeof globalThis & {
      window?: { lvisApi?: { captureUserKeyboardIntent?: () => UserKeyboardIntentSnapshot } };
    }).window?.lvisApi;
    return api?.captureUserKeyboardIntent?.() ?? { inputOrigin: "user-keyboard", token: "" };
  }, []);

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

  // Resources are counted in their OWN lane, and the partition is derived here so both
  // caps read one answer instead of each site re-filtering the array.
  //
  // The two caps measure different things, which is the whole reason they are separate
  // lanes. `ATTACH_MAX_COUNT` bounds what the PICKER paths may add — an image, a file, a
  // paste each cost a round trip and a thumbnail; a resource is bounded instead by how
  // much server text one TURN may carry, which main enforces independently.
  //
  // Note what this is NOT: it is not that resources stay out of the chip strip. They
  // render there like anything else, so a turn can show thirteen chips. An earlier
  // version of this comment claimed the strip's legibility was the reason, which is not
  // the true one — the true one is that the numbers bound different resources.
  //
  // Folding them would mean five attached documents stops the user adding a screenshot,
  // and would make the per-turn bound unreachable from the only surface that produces
  // resource attachments: a documented number nothing can reach.
  const resourceCount = useMemo(
    () => liveAttachments.filter((a) => a.kind === "resource").length,
    [liveAttachments],
  );
  const chipStripCount = liveAttachments.length - resourceCount;

  // Inline "@" resource mention. Its accept path is asynchronous (it reads the resource
  // through the host) and it commits the marker and the attachment TOGETHER here, in one
  // flushSync, for the same reason the clipboard path does: the marker-sync effect above
  // treats an attachment whose marker is missing from the body as deleted, and would
  // clean this one up before the text caught up.
  const resourceMention = useResourceMention({
    text,
    caret,
    enabled: !disabled,
    isComposing,
    // Read the same way the slash-picker runtime reads its tools. Absent in a detached
    // preview window, where the menu then simply never opens — the honest outcome, not
    // a synthesized catalogue.
    mcp: typeof window === "undefined" ? undefined : window.lvis?.mcp,
    resourceCount,
    allocateN,
    onAttach: useCallback((
      attachment: ResourceAttachment,
      marker: string,
      range: { start: number; end: number },
      mentionToken: string,
    ) => {
      // Read the LIVE text, not the value this callback closed over. The read is
      // asynchronous, so the user can keep typing while it is in flight; splicing into
      // the text as it was when they pressed Enter would silently discard everything
      // they typed since. The range can also have gone stale for the same reason, so it
      // is verified before use and the marker is appended when it no longer holds the
      // mention token. Either way the marker and the attachment land together, which is
      // the invariant the marker-sync effect above depends on.
      const current = textRef.current;
      // The range must still hold THE SAME token, not merely something starting with a
      // sigil. `startsWith("@")` let a retyped mention pass: select-all, type
      // `@abcdefgh`, and the splice would eat `abc` — the same class of bug the range
      // check was added to fix, one condition weaker.
      const stillTheMention = current.slice(range.start, range.end) === mentionToken;
      const insertAt = stillTheMention ? range.start : current.length;
      const removeTo = stillTheMention ? range.end : current.length;
      const needsSpace = !stillTheMention && current.length > 0 && !current.endsWith(" ");
      const insertion = needsSpace ? ` ${marker}` : marker;
      flushSync(() => {
        onAttachmentsChange((prev) => [...prev, attachment]);
        const ta = taRef.current;
        onTextChange(current.slice(0, insertAt) + insertion + current.slice(removeTo));
        const pos = insertAt + insertion.length;
        requestAnimationFrame(() => {
          if (ta) {
            ta.setSelectionRange(pos, pos);
            ta.focus();
          }
        });
      });
    }, [onAttachmentsChange, onTextChange]),
    onError: useCallback((message: string) => onWarning?.(message), [onWarning]),
  });
  const {
    open: mentionOpen,
    move: mentionMove,
    accept: mentionAccept,
    close: mentionClose,
  } = resourceMention;

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
        count: chipStripCount,
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
        // slots in the meantime).
        //
        // Atomic commit: text-insert MUST be inside the same flushSync
        // as onAttachmentsChange so the marker-sync useEffect never sees
        // a transient mismatch (attachments=[chip] + text="" without
        // marker → would destructively cleanup the chip before the text
        // catches up).
        let inserted = false;
        flushSync(() => {
          onAttachmentsChange((prev) => {
            if (prev.length >= ATTACH_MAX_COUNT) return prev;
            inserted = true;
            return [...prev, candidate];
          });
          if (inserted && outcome.insertText) {
            insertAtCursor(outcome.insertText);
          }
        });
        if (!inserted) {
          onWarning?.(
            t("composer.attachLimitPasteBlocked", { max: ATTACH_MAX_COUNT }),
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
      if (e.nativeEvent.isComposing || isComposingRef.current) return;

      // Inline "/" autocomplete owns navigation while open. This MUST run
      // before the suggested-reply Tab/Arrow branches and the Enter→onSend
      // branch, so Enter accepts the highlighted item instead of sending and
      // arrows drive the menu instead of the chip cycle.
      if (inlineOpen) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          inlineMove(1);
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          inlineMove(-1);
          return;
        }
        if (
          (e.key === "Enter" || e.key === "Tab") &&
          !e.shiftKey &&
          !e.altKey &&
          !e.ctrlKey &&
          !e.metaKey
        ) {
          e.preventDefault();
          inlineAccept();
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          inlineClose();
          return;
        }
      }

      // The "@" mention menu owns navigation on the same terms, and for the same
      // reason: Enter must attach the highlighted resource rather than send the turn.
      // The two triggers are mutually exclusive by construction — each sigil has to
      // start the token, so one token cannot be both — but this branch is second so
      // that a "/" menu already open keeps its keys either way.
      if (mentionOpen) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          mentionMove(1);
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          mentionMove(-1);
          return;
        }
        if (
          (e.key === "Enter" || e.key === "Tab") &&
          !e.shiftKey &&
          !e.altKey &&
          !e.ctrlKey &&
          !e.metaKey
        ) {
          e.preventDefault();
          mentionAccept();
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          mentionClose();
          return;
        }
      }

      // Suggested Replies (spec §6.2):
      //   Tab (no modifier) + value empty + best != null + not dismissed
      //     → fill textarea with `best`, dismiss current snapshot.
      //   Escape + any active suggestion → dismiss only (LLM-abort path is
      //     ChatView's ESC handler which runs at document level + is gated
      //     by `streaming`; dismissing here does not interfere because ESC
      //     in idle state has no other Composer-side semantics).
      const best = suggestedReplies?.best ?? null;
      const alternates = suggestedReplies?.alternates ?? [];
      const dismissed = suggestedReplies?.isDismissed ?? false;
      const hasGhost = best !== null && !dismissed && text.length === 0;
      const hasAnySuggestion = (best !== null || alternates.length > 0) && !dismissed;

      if (
        e.key === "Tab" &&
        !e.shiftKey &&
        !e.altKey &&
        !e.ctrlKey &&
        !e.metaKey &&
        hasGhost &&
        best !== null
      ) {
        e.preventDefault();
        if (disabled) return;
        onTextChange(best);
        acceptSuggestedReply(best, "best");
        setChipFocusIdx(null);
        requestAnimationFrame(() => {
          if (taRef.current) {
            const pos = best.length;
            taRef.current.setSelectionRange(pos, pos);
            taRef.current.focus();
          }
        });
        return;
      }

      // PR-D ↑/↓ chip cycle: ArrowDown moves focus into the row (or to the
      // next chip); ArrowUp moves it back. We only intercept when chips are
      // actually visible — otherwise the keys keep their native textarea
      // caret-movement semantics. `preventDefault` is gated on a real
      // navigation actually firing so single-line composers don't lose the
      // caret-jump shortcut when nothing is rendered anyway.
      if (
        e.key === "ArrowDown" &&
        !e.shiftKey &&
        !e.altKey &&
        !e.ctrlKey &&
        !e.metaKey &&
        alternates.length > 0 &&
        !dismissed &&
        text.length === 0
      ) {
        e.preventDefault();
        setChipFocusIdx((i) => {
          if (i === null) return 0;
          return Math.min(i + 1, alternates.length - 1);
        });
        return;
      }

      if (
        e.key === "ArrowUp" &&
        !e.shiftKey &&
        !e.altKey &&
        !e.ctrlKey &&
        !e.metaKey &&
        alternates.length > 0 &&
        !dismissed &&
        text.length === 0 &&
        chipFocusIdx !== null
      ) {
        e.preventDefault();
        setChipFocusIdx((i) => {
          if (i === null || i === 0) {
            // Cycle back to textarea — Composer's ChipRow useEffect won't
            // re-focus when idx is null, but we still need to pull DOM focus
            // away from the chip so the textarea is editable.
            requestAnimationFrame(() => taRef.current?.focus());
            return null;
          }
          return i - 1;
        });
        return;
      }

      if (e.key === "Escape" && hasAnySuggestion) {
        // Don't preventDefault — let the document-level ESC handler (ChatView)
        // still run when streaming. Dismissing the snapshot is additive.
        dismissSuggestedReplies();
        setChipFocusIdx(null);
        // Fall through so other ESC consumers still see the event.
      }

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


        if (e.metaKey || e.ctrlKey) {
          e.preventDefault();
          return;
        }

        e.preventDefault();
        if (disabled) return;
        // PR-D dismiss memory: a new user message means we're transitioning
        // to the next turn — release the dismiss latch so the next suggestion
        // push renders fresh regardless of any prior Escape during this turn.
        clearDismissedReplies();
        onSend(captureUserKeyboardIntent());
      }
    },
    [
      captureUserKeyboardIntent,
      disabled,
      onSend,
      text,
      onTextChange,
      suggestedReplies,
      chipFocusIdx,
      inlineOpen,
      inlineMove,
      inlineAccept,
      inlineClose,
      // The mention values are as load-bearing here as the inline ones, and omitting
      // them was not a stylistic slip: `mentionOpen` flips when the CATALOGUE lands,
      // in a commit where nothing else in this array moves. The handler kept a stale
      // `false`, so the FIRST `@` of a composer's lifetime rendered a visible menu
      // whose Enter fell through to the send branch — the turn went out containing a
      // bare `@` and nothing was attached. Clicking a row worked, because JSX reads
      // fresh values, which is what made it look like a working feature.
      mentionOpen,
      mentionMove,
      mentionAccept,
      mentionClose,
    ],
  );

  const isFull = chipStripCount >= ATTACH_MAX_COUNT;
  const ghostBest = suggestedReplies?.best ?? null;
  // Spec §3 line 42 + §8: ghost hidden when (a) user has typed any char, (b)
  // IME composition active (preedit), (c) no `best`, or (d) dismissed.
  const ghostVisible =
    text.length === 0 &&
    !isComposing &&
    ghostBest !== null &&
    !(suggestedReplies?.isDismissed ?? false);

  // Chip row hides as soon as the textarea has any text, mirroring the ghost.
  const chipAlternates =
    text.length === 0 && suggestedReplies && !suggestedReplies.isDismissed
      ? suggestedReplies.alternates
      : [];
  const suggestionSurfaceVisible = ghostVisible || chipAlternates.length > 0;
  const fallbackPlaceholder = suggestionSurfaceVisible ? "" : t("composer.defaultPlaceholder");

  const acceptChip = useCallback(
    (chipText: string) => {
      if (disabled) return;
      onTextChange(chipText);
      acceptSuggestedReply(chipText, "chip");
      setChipFocusIdx(null);
      requestAnimationFrame(() => {
        if (taRef.current) {
          const pos = chipText.length;
          taRef.current.setSelectionRange(pos, pos);
          taRef.current.focus();
        }
      });
    },
    [disabled, onTextChange],
  );

  // PR-D: when the chip row disappears (alternates empty, dismissed, or
  // user typed something), drop the focused index so the next render of the
  // row starts fresh from `null`. Without this, a stale index could survive
  // across snapshots and try to focus a non-existent chip.
  useEffect(() => {
    if (chipAlternates.length === 0 && chipFocusIdx !== null) {
      setChipFocusIdx(null);
    }
  }, [chipAlternates.length, chipFocusIdx]);

  return (
    <div data-testid="composer" className="min-w-0">
      <SuggestedRepliesChipRow
        alternates={chipAlternates}
        focusedIdx={chipFocusIdx}
        onAccept={acceptChip}
        onFocusChange={setChipFocusIdx}
      />
      <div
        data-testid="composer-input-bar"
        className="relative flex min-w-0 w-full items-stretch gap-0 overflow-hidden"
      >
        {/* Strip is rendered ONLY when there is at least one attachment so
            the empty state does not reserve horizontal space. Single chip
            inline; 2+ collapse into a stacked card with an overlay. */}
        {liveAttachments.length === 1 ? (
          <div
            data-testid="composer-strip"
            className="flex min-w-0 shrink-0 items-center pl-3 pr-0"
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
            className="flex min-w-0 shrink-0 items-center pl-3 pr-0"
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
          // Tutorial-C SpotlightTour anchor (PR #983 follow-up). The
          // first-boot tour pins step 1 + step 4 to this textarea, so the
          // attribute MUST remain stable. If it moves, update
          // `default-tour-scenarios.ts` in the same commit.
          data-tour-anchor="composer-input"
          value={text}
          onChange={(e) => {
            onTextChange(e.target.value);
            syncCaret();
          }}
          onPaste={handlePaste}
          onKeyDown={handleKeyDown}
          onKeyUp={syncCaret}
          onClick={syncCaret}
          onSelect={syncCaret}
          onCompositionStart={() => {
            isComposingRef.current = true;
            setIsComposing(true);
          }}
          onCompositionEnd={() => {
            isComposingRef.current = false;
            setIsComposing(false);
            syncCaret();
          }}
          placeholder={placeholder ?? fallbackPlaceholder}



          className="min-w-0 flex-1 resize-none min-h-[40px] max-h-[144px] overflow-y-auto border-0 bg-transparent focus-visible:ring-0 focus-visible:ring-offset-0 shadow-none rounded-none px-4 py-2 text-body-sm text-input-bar-foreground caret-input-bar-action placeholder:text-body-sm placeholder:text-input-bar-placeholder"
        />








        <SuggestedRepliesGhost text={ghostBest} visible={ghostVisible} />
      </div>
      {isFull ? (
        <div
          data-testid="composer-limit-warning"
          className="mt-1 text-caption text-destructive"
        >
          {t("composer.attachLimitWarning", { max: ATTACH_MAX_COUNT })}
        </div>
      ) : null}
      <InlineSlashMenu
        open={inlineOpen}
        items={inlineSlash.items}
        activeIndex={inlineSlash.activeIndex}
        anchorRef={taRef}
        onHover={inlineSlash.setActiveIndex}
        onSelect={inlineSlash.accept}
      />
      <ResourceMentionMenu
        open={mentionOpen}
        items={resourceMention.items}
        activeIndex={resourceMention.activeIndex}
        anchorRef={taRef}
        onHover={resourceMention.setActiveIndex}
        onSelect={resourceMention.accept}
      />
      {/*
        A template row needs values before anything is read, and the host chrome asks for
        them — never a composer draft, which would put the user's own submission between
        the offer and the read. The dialog hands back values only; the URI is main's.
      */}
      <McpResourceTemplateDialog
        pending={resourceMention.pendingTemplate}
        onCancel={resourceMention.cancelTemplate}
        onSubmit={resourceMention.submitTemplate}
      />
    </div>
  );
});
