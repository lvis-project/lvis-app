/**
 * The burned `poc-v1` anchor must not come back.
 *
 * `poc-v1`'s ed25519 PRIVATE half is public — it shipped in the marketplace
 * repo's test fixtures and was exposed again in a merged public PR. While it
 * remained in `MARKETPLACE_PUBLIC_KEYS`, anyone who could serve an artifact
 * could sign one that every LVIS build accepted, because `verifyEnvelope`
 * accepts ANY key in that map. One burned anchor was sufficient on its own.
 *
 * It was removable only after nothing installable still needed it: the catalog
 * was re-signed to `prod-v1` (804 of 860 version rows), and the 56 still on
 * `poc-v1` have no artifact file on disk, so their download 404s before any
 * signature check runs.
 *
 * A test rather than a comment because the failure mode is silent. Re-adding
 * the anchor restores acceptance of forged artifacts without changing any
 * behaviour a normal test would observe — every install keeps working, which
 * is exactly why nothing would catch it.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/** Every .ts/.tsx file under the given roots, skipping build output. */
function sourceFilesUnder(...roots: string[]): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry === "dist") continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry)) found.push(full);
    }
  };
  for (const root of roots) walk(root);
  return found;
}

import { MARKETPLACE_PUBLIC_KEYS } from "../marketplace-keys.js";

/** Public half of the leaked key, derived from the committed private seed. */
const BURNED_POC_V1_PUBLIC = "Qm3FUAMek2r5OkXCurgX6dNYSqiT1GRnjb5fWfuOoao=";

describe("marketplace trust anchors", () => {
  it("does not carry the burned poc-v1 key id", () => {
    expect(Object.keys(MARKETPLACE_PUBLIC_KEYS)).not.toContain("poc-v1");
  });

  it("does not carry the burned key's VALUE under any id", () => {
    // Guards the rename dodge: re-adding the same public key under a fresh id
    // would restore the exposure while passing the id check above.
    expect(Object.values(MARKETPLACE_PUBLIC_KEYS)).not.toContain(BURNED_POC_V1_PUBLIC);
  });

  it("still has a usable production anchor", () => {
    // The opposite failure: an empty map makes every install fail closed with
    // KEYS_NOT_CONFIGURED, which is safe but ships a broken marketplace.
    expect(Object.keys(MARKETPLACE_PUBLIC_KEYS).length).toBeGreaterThan(0);
    expect(MARKETPLACE_PUBLIC_KEYS["prod-v1"]).toBeTruthy();
  });

  it("holds raw 32-byte ed25519 keys", () => {
    for (const [id, b64] of Object.entries(MARKETPLACE_PUBLIC_KEYS)) {
      expect(Buffer.from(b64, "base64").length, `key ${id}`).toBe(32);
    }
  });

  it("is frozen so a caller cannot add an anchor at runtime", () => {
    expect(Object.isFrozen(MARKETPLACE_PUBLIC_KEYS)).toBe(true);
  });

  it("no fixture signs with the burned key id either", () => {
    // Removing the anchor made `poc-v1` a value nothing can present any more.
    // A fixture still using it stages a state that cannot occur, which reads
    // as a normal case to whoever edits the test next.
    //
    // `signerKeyId` is recorded on the install receipt rather than verified
    // against — `installSource` is the authoritative trust signal — so this
    // never affected behaviour. That is exactly why nothing else catches it.
    //
    // The prose above and in `marketplace-keys.ts` keeps the name on purpose:
    // explaining why a key was retired requires naming it. This looks only at
    // code that USES the id as a value.
    const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
    const offenders: string[] = [];
    for (const file of sourceFilesUnder(join(root, "src"), join(root, "test"))) {
      const text = readFileSync(file, "utf8");
      for (const [index, line] of text.split("\n").entries()) {
        if (/(signerKeyId|signerId)\s*:\s*["'`]poc-v1["'`]/.test(line)) {
          offenders.push(`${relative(root, file)}:${index + 1}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
