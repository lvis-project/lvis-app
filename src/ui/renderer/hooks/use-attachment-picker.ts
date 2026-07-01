import { useCallback } from "react";
import type React from "react";
import type { RefObject } from "react";
import { flushSync } from "react-dom";
import {
  ATTACH_MAX_COUNT,
  DENY_EXTENSIONS,
  type Attachment,
} from "../types/attachments.js";
import { buildMarkerText } from "../utils/attachment-markers.js";
import type { ComposerHandle } from "../components/Composer.js";

export interface UseAttachmentPickerParams {
  attachmentNCounter: { current: number };
  setAttachments: React.Dispatch<React.SetStateAction<Attachment[]>>;
  setQuestion: React.Dispatch<React.SetStateAction<string>>;
  composerRef: RefObject<ComposerHandle | null>;
}

export interface UseAttachmentPickerResult {
  handleAttach: () => Promise<void>;
}

/**
 * Owns the native attachment picker (window.lvis.attach.openFile). The 5-cap
 * (ATTACH_MAX_COUNT) is enforced at *commit* time inside the setAttachments
 * updater, and the setAttachments + text-insert MUST land in a single flushSync
 * so Composer's marker-sync effect cannot run between them. Both invariants are
 * preserved verbatim here.
 */
export function useAttachmentPicker({
  attachmentNCounter,
  setAttachments,
  setQuestion,
  composerRef,
}: UseAttachmentPickerParams): UseAttachmentPickerResult {
  // Attach picker — opens the native file dialog via window.lvis.attach
  // (attach lives ONLY on window.lvis, not window.lvisApi; see preload.ts
  // contextBridge "lvis" → attach). The disable gate (attachments cap /
  // no-api-key) is applied by the InputActionBar attachDisabled prop, so this
  // handler only runs when attaching is allowed.
  const handleAttach = useCallback(async () => {
    const result = await window.lvis.attach.openFile();
    if (result.canceled) return;
    if (result.rejected.length > 0) {
      console.warn("attachment rejected (deny-list):", result.rejected, "deny:", DENY_EXTENSIONS);
    }
    // Build all candidate attachments first. The 5-cap is enforced at *commit*
    // time inside the setAttachments updater, so a concurrent clipboard paste
    // during the readImage await cannot push us past the limit (the updater
    // receives the latest committed state, not the closure-captured one).
    const candidates: Attachment[] = [];
    for (const f of result.files) {
      const n = ++attachmentNCounter.current;
      if (f.isImage) {
        const img = await window.lvis.attach.readImage(f.path);
        if (
          !img.ok ||
          !img.dataUrl ||
          !img.mimeType ||
          img.width === undefined ||
          img.height === undefined ||
          img.bytes === undefined
        ) {
          console.warn("readImage failed", f.path, img.error);
          continue;
        }
        candidates.push({
          id: `img-${Date.now()}-${n}`,
          n,
          kind: "image",
          path: f.path,
          mimeType: img.mimeType,
          width: img.width,
          height: img.height,
          bytes: img.bytes,
          dataUrl: img.dataUrl,
        });
      } else {
        candidates.push({
          id: `file-${Date.now()}-${n}`,
          n,
          kind: "file",
          path: f.path,
          name: f.name,
          ext: f.ext,
          bytes: f.bytes,
        });
      }
    }
    if (candidates.length === 0) {
      composerRef.current?.focus();
      return;
    }
    // Atomic commit: setAttachments AND text-insert MUST land in the same
    // render commit, otherwise Composer's marker-sync useEffect runs between
    // the two and clears `attachments`. Putting both inside one flushSync
    // batches them so the next render sees attachments + marker text consistent.
    let acceptedMarkers = "";
    flushSync(() => {
      setAttachments((prev) => {
        const remaining = Math.max(0, ATTACH_MAX_COUNT - prev.length);
        const accepted = candidates.slice(0, remaining);
        if (accepted.length < candidates.length) {
          console.warn(
            `${candidates.length - accepted.length} attachment(s) dropped — ${ATTACH_MAX_COUNT}-cap reached during async open/read`,
          );
        }
        acceptedMarkers = accepted.map((a) => `${buildMarkerText(a)} `).join("");
        return [...prev, ...accepted];
      });
      if (acceptedMarkers) {
        if (composerRef.current) {
          composerRef.current.insertAtCursor(acceptedMarkers);
        } else {
          setQuestion((prev) => prev + acceptedMarkers);
        }
      }
    });
    // Return focus to the composer textarea so the user can keep typing
    // immediately after the file dialog closes.
    composerRef.current?.focus();
  }, [attachmentNCounter, setAttachments, setQuestion]);

  return { handleAttach };
}
