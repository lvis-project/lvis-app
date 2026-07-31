import { useCallback, useRef } from "react";
import type React from "react";
import type { RefObject } from "react";
import { flushSync } from "react-dom";
import {
  ATTACH_MAX_COUNT,
  DENY_EXTENSIONS,
  type Attachment,
} from "../types/attachments.js";
import { buildMarkerText } from "../utils/attachment-markers.js";
import { subscriptionImageAttachmentLimitViolation } from "../utils/subscription-runtime-ui-policy.js";
import type { ComposerHandle } from "../components/Composer.js";
import type { SubscriptionImageAttachmentLimits } from "../../../shared/subscription-runtime.js";

export interface UseAttachmentPickerParams {
  attachmentNCounter: { current: number };
  setAttachments: React.Dispatch<React.SetStateAction<Attachment[]>>;
  setQuestion: React.Dispatch<React.SetStateAction<string>>;
  composerRef: RefObject<ComposerHandle | null>;
  /** Native image input is allowed only after the selected runtime verifies it. */
  imagesEnabled?: boolean;
  /** File-marker attachment flow is allowed only after the selected runtime verifies it. */
  filesEnabled?: boolean;
  /** Exact main-verified native-image budget for the selected subscription runtime. */
  imageAttachmentLimits?: SubscriptionImageAttachmentLimits | null;
  /** Notify the user when a selected attachment type is not supported by the live runtime. */
  onAttachmentUnavailable?: () => void;
  /** Notify the user when a supported image exceeds its current runtime budget. */
  onImageAttachmentLimitExceeded?: () => void;
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
  onAttachmentUnavailable,
  onImageAttachmentLimitExceeded,
  composerRef,
  imagesEnabled = true,
  filesEnabled = true,
  imageAttachmentLimits,
}: UseAttachmentPickerParams): UseAttachmentPickerResult {
  const capabilityRef = useRef({ imagesEnabled, filesEnabled, imageAttachmentLimits });
  capabilityRef.current.imagesEnabled = imagesEnabled;
  capabilityRef.current.filesEnabled = filesEnabled;
  capabilityRef.current.imageAttachmentLimits = imageAttachmentLimits;

  // Attach picker — opens the native file dialog via window.lvis.attach
  // (attach lives ONLY on window.lvis, not window.lvisApi; see preload.ts
  // contextBridge "lvis" → attach). The disable gate (attachments cap /
  // no-api-key) is applied by the InputActionBar attachDisabled prop, so this
  // handler only runs when attaching is allowed.
  const handleAttach = useCallback(async () => {
    const result = await window.lvis.attach.openFile();
    let unavailableAttachmentSkipped = false;
    let imageAttachmentLimitExceeded = false;
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
      if ((f.isImage && !capabilityRef.current.imagesEnabled) || (!f.isImage && !capabilityRef.current.filesEnabled)) {
        // The picker can return mixed selections. Do not allocate a marker
        // number or read an image before its verified runtime capability gate.
        console.warn("attachment type is not available for the active runtime", f.path);
        unavailableAttachmentSkipped = true;
        continue;
      }
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
        const candidateBudgetViolation = subscriptionImageAttachmentLimitViolation(
          capabilityRef.current.imageAttachmentLimits,
          [
            ...candidates
              .filter((attachment) => attachment.kind === "image")
              .map((attachment) => ({ bytes: attachment.bytes })),
            { bytes: img.bytes },
          ],
        );
        if (candidateBudgetViolation) {
          console.warn("image attachment exceeds current runtime budget", candidateBudgetViolation, f.path);
          imageAttachmentLimitExceeded = true;
          continue;
        }
        // The file dialog and image read are both asynchronous. Do not add an
        // image selected under a previous runtime after capability changes.
        if (!capabilityRef.current.imagesEnabled) {
          console.warn("image attachment capability changed before commit", f.path);
          unavailableAttachmentSkipped = true;
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
      if (imageAttachmentLimitExceeded) {
        if (onImageAttachmentLimitExceeded) onImageAttachmentLimitExceeded();
        else onAttachmentUnavailable?.();
      }
      if (unavailableAttachmentSkipped) onAttachmentUnavailable?.();
      return;
    }
    // Atomic commit: setAttachments AND text-insert MUST land in the same
    // render commit, otherwise Composer's marker-sync useEffect runs between
    // the two and clears `attachments`. Putting both inside one flushSync
    // batches them so the next render sees attachments + marker text consistent.
    let acceptedMarkers = "";
    let capabilityChangedBeforeCommit = false;
    flushSync(() => {
      setAttachments((prev) => {
        const currentCandidates = candidates.filter((attachment) =>
          attachment.kind === "image"
            ? capabilityRef.current.imagesEnabled
            : attachment.kind === "file"
              ? capabilityRef.current.filesEnabled
              : true,
        );
        capabilityChangedBeforeCommit = currentCandidates.length !== candidates.length;
        const remaining = Math.max(0, ATTACH_MAX_COUNT - prev.length);
        const accepted: Attachment[] = [];
        for (const candidate of currentCandidates) {
          if (accepted.length >= remaining) continue;
          if (candidate.kind === "image") {
            const images = [...prev, ...accepted]
              .filter((attachment) => attachment.kind === "image")
              .map((attachment) => ({ bytes: attachment.bytes }));
            if (
              subscriptionImageAttachmentLimitViolation(
                capabilityRef.current.imageAttachmentLimits,
                [...images, { bytes: candidate.bytes }],
              )
            ) {
              imageAttachmentLimitExceeded = true;
              continue;
            }
          }
          accepted.push(candidate);
        }
        if (accepted.length < currentCandidates.length) {
          console.warn(
            `${currentCandidates.length - accepted.length} attachment(s) dropped — ${ATTACH_MAX_COUNT}-cap reached during async open/read`,
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
    if (imageAttachmentLimitExceeded) {
      if (onImageAttachmentLimitExceeded) onImageAttachmentLimitExceeded();
      else onAttachmentUnavailable?.();
    }
    if (unavailableAttachmentSkipped || capabilityChangedBeforeCommit) onAttachmentUnavailable?.();
    // Return focus to the composer textarea so the user can keep typing
    // immediately after the file dialog closes.
    composerRef.current?.focus();
  }, [attachmentNCounter, composerRef, onAttachmentUnavailable, onImageAttachmentLimitExceeded, setAttachments, setQuestion]);

  return { handleAttach };
}
