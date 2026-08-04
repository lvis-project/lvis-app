/**
 * Shared fixture for the Telegram connection tests.
 *
 * The store and the owner service both need a real file layer — atomic tmp +
 * rename, 0o700 directories, 0o600 files — rooted at a throwaway directory, so
 * their tests exercise the actual persistence path rather than a mock of it.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  readJsonFile,
  writeJsonAtomic,
  type FeatureNamespaceHandle,
} from "../storage/feature-namespace.js";

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
