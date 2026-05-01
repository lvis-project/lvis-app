import type { RolePreset } from "../../../data/role-presets.js";
import { buildPresetPrefix } from "../../../data/role-presets.js";
import type { UserContentPart } from "../../../engine/llm/types.js";
import type { Attachment } from "../types/attachments.js";
import { buildMarkerText } from "./attachment-markers.js";

export interface ComposedOutgoing {
  /** Plain-text portion that becomes the textual body of the user turn. */
  text: string;
  /**
   * Multimodal user content parts (vision images today; reserved for inline
   * file payloads later). Empty array when no images were attached. The
   * caller passes this as the second argument to `api.chatSend(text, parts)`
   * — the IPC layer forwards it to `runTurn(input, { attachments })`.
   */
  attachments: UserContentPart[];
}

/**
 * Compose outgoing message + multimodal attachments.
 *
 * The renderer keeps marker text (e.g. "[Image #1]", "[File #2]",
 * "[Pasted text #3 +12 lines]") in the textarea body. At send time:
 *   • Image markers stay in the body verbatim (so the assistant can refer
 *     to them by `#N`) and the corresponding payload becomes a vision part.
 *   • File markers are augmented inline so the model sees the absolute path
 *     and knows it can call the read tool. Body text stays human-readable.
 *   • Paste markers are replaced in-place with the actual pasted text wrapped
 *     in a fenced block so the model sees the full content (no extra round-trip).
 */
export function composeOutgoing(params: {
  raw: string;
  activePreset: RolePreset | null;
  attachments: Attachment[];
}): ComposedOutgoing {
  const { raw, activePreset, attachments } = params;

  let body = raw;

  // 1. Inline-replace paste markers with the actual pasted text.
  for (const att of attachments) {
    if (att.kind !== "paste") continue;
    const marker = buildMarkerText(att);
    const replacement = `\n\n----- Pasted text #${att.n} (${att.lines} lines) -----\n${att.text}\n----- end Pasted text #${att.n} -----\n\n`;
    body = body.split(marker).join(replacement);
  }

  // 2. Augment file markers with absolute path so the model can read via tool.
  for (const att of attachments) {
    if (att.kind !== "file") continue;
    const marker = buildMarkerText(att);
    const augmented = `[File #${att.n} — path: ${att.path}]`;
    body = body.split(marker).join(augmented);
  }

  // 3. Compose final text with optional role preset prefix.
  const parts: string[] = [];
  const presetPrefix = buildPresetPrefix(activePreset);
  if (presetPrefix) parts.push(presetPrefix.trimEnd());
  parts.push(body);

  // 4. Image attachments become vision parts.
  const imageParts: UserContentPart[] = attachments
    .filter((a): a is Extract<Attachment, { kind: "image" }> => a.kind === "image")
    .map((img) => ({
      type: "image",
      image: img.dataUrl,
      mimeType: img.mimeType,
    }));

  return {
    text: parts.join("\n\n"),
    attachments: imageParts,
  };
}
