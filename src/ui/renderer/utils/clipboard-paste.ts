import { t } from "../../../i18n/runtime.js";
import {
  PASTE_TEXT_MIN_CHARS,
  PASTE_TEXT_MIN_NEWLINES,
  type Attachment,
  type ImageAttachment,
  type PasteAttachment,
} from "../types/attachments.js";
import { buildMarkerText } from "./attachment-markers.js";

export interface PasteContext {
  /** Currently allocated attachment count (live from textarea). */
  count: number;
  /** Strictly increasing N counter — never reassigned, even after deletions. */
  allocateN: () => number;
  /** Save a clipboard image buffer to OS tmp; returns metadata + dataUrl. */
  saveClipboardImage: (base64: string) => Promise<{
    ok: boolean;
    path?: string;
    width?: number;
    height?: number;
    bytes?: number;
    mimeType?: string;
    dataUrl?: string;
    error?: string;
  }>;
  /** Maximum allowed total attachments (5). */
  max: number;
}

export interface PasteHandlerOutcome {
  /** When set, the renderer should insert this string at the caret. */
  insertText?: string;
  /** When set, append to the attachment store. */
  newAttachment?: Attachment;
  /** When true, the native paste was consumed — caller must `preventDefault()`. */
  handled: boolean;
  /** Optional non-fatal explanation for the user (toast). */
  warning?: string;
}

function fileToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== "string") {
        reject(new Error("clipboard image is not a string dataURL"));
        return;
      }
      const idx = result.indexOf(",");
      resolve(idx >= 0 ? result.slice(idx + 1) : result);
    };
    reader.readAsDataURL(blob);
  });
}

function findClipboardImage(items: DataTransferItemList): File | null {
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item.kind === "file" && item.type.startsWith("image/")) {
      const f = item.getAsFile();
      if (f) return f;
    }
  }
  return null;
}

function shouldChipText(text: string): boolean {
  if (text.length >= PASTE_TEXT_MIN_CHARS) return true;
  const newlines = (text.match(/\n/g) ?? []).length;
  return newlines >= PASTE_TEXT_MIN_NEWLINES;
}

/**
 * Inspect a paste event and decide whether to:
 *   • consume an image → save to OS tmp + create image attachment + marker
 *   • consume long text → create paste attachment + marker
 *   • let the browser paste short text natively (return handled=false)
 *
 * The renderer receives the outcome and is responsible for inserting marker
 * text and updating attachment state. This split keeps the function pure-ish
 * (only async on the IPC save) and easily testable.
 */
export async function handleClipboardPaste(
  event: ClipboardEvent,
  ctx: PasteContext,
): Promise<PasteHandlerOutcome> {
  const data = event.clipboardData;
  if (!data) return { handled: false };

  if (ctx.count >= ctx.max) {
    const file = findClipboardImage(data.items);
    const txt = data.getData("text/plain");
    if (file || (txt && shouldChipText(txt))) {
      return {
        handled: true,
        warning: t("clipboardPaste.attachmentLimitReached", { max: ctx.max }),
      };
    }
    return { handled: false };
  }

  const imageFile = findClipboardImage(data.items);
  if (imageFile) {
    const base64 = await fileToBase64(imageFile);
    const saved = await ctx.saveClipboardImage(base64);
    if (
      !saved.ok ||
      !saved.path ||
      !saved.dataUrl ||
      saved.width === undefined ||
      saved.height === undefined ||
      saved.bytes === undefined ||
      !saved.mimeType
    ) {
      return {
        handled: true,
        warning: saved.error
          ? t("clipboardPaste.imageSaveFailedWithError", { error: saved.error })
          : t("clipboardPaste.imageSaveFailed"),
      };
    }
    const n = ctx.allocateN();
    const att: ImageAttachment = {
      id: `clip-${Date.now()}-${n}`,
      n,
      kind: "image",
      path: saved.path,
      mimeType: saved.mimeType,
      width: saved.width,
      height: saved.height,
      bytes: saved.bytes,
      dataUrl: saved.dataUrl,
    };
    return {
      handled: true,
      newAttachment: att,
      insertText: `${buildMarkerText(att)} `,
    };
  }

  const txt = data.getData("text/plain");
  if (txt && shouldChipText(txt)) {
    const lines = txt.split("\n").length;
    const n = ctx.allocateN();
    const att: PasteAttachment = {
      id: `paste-${Date.now()}-${n}`,
      n,
      kind: "paste",
      text: txt,
      lines,
      chars: txt.length,
    };
    return {
      handled: true,
      newAttachment: att,
      insertText: `${buildMarkerText(att)} `,
    };
  }

  return { handled: false };
}
