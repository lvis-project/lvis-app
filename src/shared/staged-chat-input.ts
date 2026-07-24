/**
 * Canonical staged-chat provenance.
 *
 * App and plugin text are parsed exactly once at their ingress boundary. The
 * resulting object, rather than a later raw-string reparse, travels through
 * streaming and turn orchestration so routing and tool scope cannot activate
 * from untrusted staged body text.
 */
import type { ChatInputOrigin } from "./chat-origin.js";
import {
  parseImportedTriggerEnvelopePayload,
  type ImportedTriggerEnvelope,
} from "./overlay-trigger-source.js";
import {
  parseAppMessageEnvelopePayload,
  type AppMessageEnvelope,
} from "./mcp-app-message-source.js";

export type StagedChatInputOrigin = "plugin-emitted" | "app-emitted";

export interface CanonicalStagedChatInput {
  inputOrigin: StagedChatInputOrigin;
  source: string;
  body: string;
}

export function isStagedChatInputOrigin(
  inputOrigin: ChatInputOrigin,
): inputOrigin is StagedChatInputOrigin {
  return inputOrigin === "plugin-emitted" || inputOrigin === "app-emitted";
}

/**
 * Parse the complete envelope for an already-declared staged input origin.
 * Non-staged origins deliberately return null: envelope-looking user text is
 * ordinary user text and is never reclassified by its contents.
 */
export function parseCanonicalStagedChatInput(
  inputOrigin: ChatInputOrigin,
  input: string,
): CanonicalStagedChatInput | null {
  if (inputOrigin === "plugin-emitted") {
    const envelope: ImportedTriggerEnvelope | null =
      parseImportedTriggerEnvelopePayload(input);
    return envelope
      ? { inputOrigin, source: envelope.source, body: envelope.body }
      : null;
  }
  if (inputOrigin === "app-emitted") {
    const envelope: AppMessageEnvelope | null = parseAppMessageEnvelopePayload(input);
    return envelope
      ? { inputOrigin, source: envelope.source, body: envelope.body }
      : null;
  }
  return null;
}
