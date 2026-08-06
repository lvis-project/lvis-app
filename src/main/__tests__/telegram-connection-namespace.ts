/**
 * Shared fixture for the Telegram connection tests.
 *
 * The store and the owner service both need a real file layer — atomic tmp +
 * rename, 0o700 directories, 0o600 files — rooted at a throwaway directory, so
 * their tests exercise the actual persistence path rather than a mock of it.
 *
 * They also need the same conversation-digest derivation. Production wires one
 * function into both the store and the service and the store refuses a grant
 * whose two derivations disagree, so a second copy here would test a shape the
 * app never runs.
 */
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  readJsonFile,
  writeJsonAtomic,
  type FeatureNamespaceHandle,
} from "../storage/feature-namespace.js";

/**
 * Bot-scoped exactly like `telegramConversationDigest`, so an approval cannot
 * survive being re-pointed at a different bot. The store re-runs this on every
 * read to decide whether a stored plaintext conversation id is real.
 */
export function conversationDigestFor(botFingerprint: string, conversationId: string): string {
  return createHash("sha256").update("conversation", "utf8").update("\0", "utf8")
    .update(botFingerprint, "utf8").update("\0", "utf8")
    .update(conversationId, "utf8").digest("hex");
}

export function namespaceAt(directory: string): FeatureNamespaceHandle {
  return {
    get dir(): string {
      return directory;
    },
    readJson: <T>(name: string, fallback: T) => readJsonFile(join(directory, name), fallback),
    writeJson: <T>(name: string, value: T) => writeJsonAtomic(directory, name, value),
    childDir: async (name: string) => {
      const child = join(directory, name);
      mkdirSync(child, { recursive: true, mode: 0o700 });
      return child;
    },
  };
}
