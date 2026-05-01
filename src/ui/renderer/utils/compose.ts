import type { RolePreset } from "../../../data/role-presets.js";
import { buildPresetPrefix } from "../../../data/role-presets.js";

/**
 * Multimodal attachment marker produced by the Composer component.
 * Supports three kinds of attachments:
 * - `image` — base-64 data URI, contributes to `ComposedOutgoing.attachments`
 * - `file`  — resolved file path (not yet wired; marker stays in `text`)
 * - `paste` — pasted text block (not yet wired; marker stays in `text`)
 */
export type Attachment =
  | { kind: "image"; id: string; mimeType: string; data: string }
  | { kind: "file"; id: string; mimeType?: string; path: string }
  | { kind: "paste"; id: string; text: string; lines: number };

/**
 * Return value of `composeOutgoing`.  Callers use `.text` for the chat
 * API today; `.attachments` will be wired to `api.chatSend` in a
 * follow-up multimodal PR.
 */
export interface ComposedOutgoing {
  /** Text portion — preset prefix + attached-doc notice + raw input. */
  text: string;
  /**
   * Image content parts populated by `composeOutgoing()` from `kind="image"`
   * attachments only.  Non-image attachments (file/paste) are not yet wired
   * and their markers remain verbatim in `text`; full substitution will be
   * added in the Composer integration PR (#440).
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
 * @param attachments  - All attachment types (image, file, paste). Only
 *   `kind="image"` attachments contribute to `ComposedOutgoing.attachments`;
 *   file/paste markers currently stay verbatim in `text` (substitution
 *   pending Composer integration PR #440).  Pass `[]` until wired up.
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
    attachments: attachments
      .filter((a): a is Extract<Attachment, { kind: "image" }> => a.kind === "image")
      .map((a) => ({ type: "image" as const, mimeType: a.mimeType, data: a.data })),
  };
}
