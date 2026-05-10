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
   * caller passes this through the appropriate chat IPC surface
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
 *     in `----- Pasted text #N (M lines) -----` delimiters so the model sees
 *     the full content (no extra round-trip). Plain delimiter rather than a
 *     fenced code block so the inner content cannot accidentally close it.
 */
export function composeOutgoing(params: {
  raw: string;
  activePreset: RolePreset | null;
  attachments: Attachment[];
}): ComposedOutgoing {
  const { raw, activePreset, attachments } = params;

  let body = raw;

  // 1. Augment file markers with absolute path so the model can read via tool.
  //    Order matters: file augmentation runs FIRST so it sees only the user's
  //    own marker text. If we expanded paste markers first, the pasted body
  //    might contain a literal "[File #N]" substring (e.g. quoted code snippet)
  //    and our split/join would unintentionally augment it too.
  for (const att of attachments) {
    if (att.kind !== "file") continue;
    const marker = buildMarkerText(att);
    const augmented = `[File #${att.n} — path: ${att.path}]`;
    body = body.split(marker).join(augmented);
  }

  // 2. Inline-replace paste markers with the actual pasted text. Now-safe
  //    because file augmentation already ran on the original body.
  //
  //    The split target intentionally matches any `[Pasted text #N +X lines]`
  //    where X is *any* digit string — `parseMarkers()` accepts the same
  //    loose suffix so the user could have edited the line count manually.
  //    If we used `buildMarkerText(att)` (which embeds the original `lines`
  //    value) the split would miss the edited form, leaving the marker
  //    text in the body and the pasted content unsubstituted.
  for (const att of attachments) {
    if (att.kind !== "paste") continue;
    const re = new RegExp(`\\[Pasted text #${att.n}(?:\\s+\\+\\d+\\s+lines)?\\]`, "g");
    const replacement = `\n\n----- Pasted text #${att.n} (${att.lines} lines) -----\n${att.text}\n----- end Pasted text #${att.n} -----\n\n`;
    // Replacer FUNCTION (not string) — `String.prototype.replace`'s string
    // form interprets `$&`, `$1`, `$$`, etc. as backreference tokens. The
    // pasted text could contain literal `$` sequences (regex snippets,
    // template literals, currency, etc.) and we must not mutate them.
    body = body.replace(re, () => replacement);
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

/**
 * Compose a plugin-imported trigger exactly as the plugin runtime emitted it.
 * Imported triggers already carry their overlay trigger provenance envelope; adding
 * role presets or the user's current composer attachments would change both
 * authorship and trust-origin classification.
 */
export function composeImportedTriggerOutgoing(raw: string): ComposedOutgoing {
  return {
    text: raw,
    attachments: [],
  };
}
