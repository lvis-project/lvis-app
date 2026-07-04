import { createHash } from "node:crypto";
import { projectRootKey } from "../shared/project-identity.js";

export function workBoardProjectStorageKey(projectRoot: string | undefined): string | undefined {
  const key = projectRootKey(projectRoot);
  if (!key) return undefined;
  return createHash("sha256").update(key).digest("hex").slice(0, 32);
}
