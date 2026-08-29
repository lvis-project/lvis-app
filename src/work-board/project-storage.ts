import { projectRootKey } from "../shared/project-identity.js";
import { sha256Hex } from "../lib/hex-digest-equal.js";

export function workBoardProjectStorageKey(projectRoot: string | undefined): string | undefined {
  const key = projectRootKey(projectRoot);
  if (!key) return undefined;
  return sha256Hex(key).slice(0, 32);
}
