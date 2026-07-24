import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";

function looksLikePath(token: string): boolean {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(token)) return false;
  return token.startsWith(".") || token.startsWith("~") || token.includes("/") || token.includes("\\");
}

function isContained(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Anchor path-like command tokens to a sealed, receipt-verified generation.
 *
 * The artifact generation id carried by the caller already commits to every
 * receipt-covered byte. Do not hash an executable here: reading a path and
 * later spawning that same path creates a check/use race. Materialization
 * seals the retained generation before this function can return it.
 */
export function anchorBundledCommand(
  payloadRoot: string,
  descriptorPath: string,
  argv: readonly string[],
  baseFingerprint: string,
  label: string,
): { command: readonly string[]; fingerprint: string } {
  const rootReal = realpathSync(payloadRoot);
  const descriptorDirectory = dirname(resolve(rootReal, descriptorPath));
  const anchored = [...argv];
  const identities: string[] = [];
  for (let index = 0; index < anchored.length; index += 1) {
    const token = anchored[index];
    if (!looksLikePath(token)) continue;
    if (token.startsWith("~") || isAbsolute(token) || /^[A-Za-z]:[\\/]/.test(token)) {
      throw new Error(`${label} command path must be relative to its bundled descriptor`);
    }
    const candidate = resolve(descriptorDirectory, token);
    if (!isContained(rootReal, candidate)) throw new Error(`${label} command path escapes the retained plugin generation`);
    let candidateReal: string | undefined;
    try { candidateReal = realpathSync(candidate); } catch { candidateReal = undefined; }
    if (!candidateReal || !isContained(rootReal, candidateReal)) {
      throw new Error(`${label} command path is not a retained package file`);
    }
    const rel = relative(rootReal, candidateReal).split("\\").join("/");
    let descriptor: number | undefined;
    try {
      descriptor = openSync(candidateReal, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      if (!fstatSync(descriptor).isFile()) {
        throw new Error(`${label} command path is not a regular file`);
      }
      const sha256 = createHash("sha256").update(readFileSync(descriptor)).digest("hex");
      identities.push(`${index}\0${rel}\0${sha256}`);
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
    anchored[index] = candidateReal;
  }
  const fingerprint = createHash("sha256")
    .update(baseFingerprint)
    .update("\0")
    .update(identities.join("\n"))
    .digest("hex");
  return { command: Object.freeze(anchored), fingerprint };
}
