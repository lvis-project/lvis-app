import type { RolePreset } from "../../../data/role-presets.js";
import { buildPresetPrefix } from "../../../data/role-presets.js";

/**
 * Multimodal attachment marker produced by the Composer component.
 * Represents a single image entry (kind === "image") the user added before
 * sending.  File and paste entries are serialised into inline text via the
 * `raw` string, not as `Attachment` objects.  When multimodal wire-up is
 * complete the caller passes `attachments` to `api.chatSend(text, parts)`.
 */
export interface Attachment {
  /** Stable client-side id for React keying / de-dup. */
  id: string;
  /** MIME type, e.g. "image/png", "application/pdf". */
  mimeType: string;
  /** Base-64 encoded data URI or a resolved file path. */
  data: string;
}

/**
 * Return value of `composeOutgoing`.  Callers use `.text` for the chat
 * API today; `.attachments` will be wired to `api.chatSend` in a
 * follow-up multimodal PR.
 */
export interface ComposedOutgoing {
  /** Text portion — preset prefix + attached-doc notice + raw input. */
  text: string;
  /**
   * Image content parts populated by `composeOutgoing()` from the caller's
   * `attachments` array.  The `Attachment` type is currently image-only;
   * file and paste content is delivered via the `raw` text string, not as
   * attachment objects.  Composer wire-up will supply the `attachments`
   * array from the textarea state.
   */
  attachments: Array<{ type: "image"; mimeType: string; data: string }>;
}

/**
 * Compose outgoing message with role-preset prefix and attached-doc notice.
 * Pure function — extracted from App.tsx so it can be unit-tested and reused
 * by use-cost-estimate's draft serialization.
 *
 * CTRL simplification: language lock removed. Modern LLMs detect language
 * from user input automatically; an explicit "Respond in Korean/English"
 * directive is unnecessary and brittle.
 *
 * @param attachedDocs - Paperclip-pinned indexed documents (separate IPC
 *   flow from multimodal `attachments`).
 * @param attachments  - Composer image/file/paste markers.  Pass `[]` until
 *   the multimodal wire-up PR connects the Composer component.
 */
export function composeOutgoing(params: {
  raw: string;
  activePreset: RolePreset | null;
  attachedDocs: Array<{ id: string; name: string }>;
  attachments: Attachment[];
}): ComposedOutgoing {
  const { raw, activePreset, attachedDocs, attachments } = params;
  const parts: string[] = [];
  const presetPrefix = buildPresetPrefix(activePreset);
  if (presetPrefix) parts.push(presetPrefix.trimEnd());
  if (attachedDocs.length > 0) {
    const lines = attachedDocs.map((d) => `- ${d.name} (id: ${d.id})`).join("\n");
    parts.push(`[Attached documents — use knowledge_search / document_structure to read them]\n${lines}`);
  }
  parts.push(raw);
  return {
    text: parts.join("\n\n"),
    attachments: attachments.map((a) => ({ type: "image" as const, mimeType: a.mimeType, data: a.data })),
  };
}
