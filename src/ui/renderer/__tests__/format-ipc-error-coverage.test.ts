/**
 * Static-grep coverage test for `formatIpcError` SOT (#830 + cluster review).
 *
 * Cross-cutting review of PR #836 (critic MAJOR-1) found that
 * `COMMON_IPC_ERROR_MESSAGES` covered only ~20% of the IPC error codes
 * actually returned by `src/ipc/domains/**`. Unmapped codes fell through
 * to the generic Korean fallback, leaking raw English kebab-case strings
 * to the UI — the exact anti-pattern PR #803 was meant to forbid.
 *
 * This test is the durable enforcement. It scans `src/ipc/domains/**`
 * for any `{ok:false, error:"<code>"}` literal and asserts each `<code>`
 * has a Korean mapping in `COMMON_IPC_ERROR_MESSAGES`. A new IPC handler
 * adding an unmapped code will fail CI here.
 *
 * The grep regex matches the `{ok:false, error: "..."}` shape used
 * uniformly by `src/ipc/domains/*.ts`. Dynamic-code patterns like
 * `reviewer-rewire-failed:<detail>` are handled by callers *before*
 * `formatIpcError` (see PermissionsTab.tsx), and the grep deliberately
 * does not capture those (template-literal interpolations).
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { COMMON_IPC_ERROR_MESSAGES } from "../format-ipc-error.js";

const __dirname = resolve(fileURLToPath(import.meta.url), "..");
const IPC_DOMAIN_DIR = resolve(__dirname, "../../../ipc/domains");

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listTsFiles(full));
    else if (entry.isFile() && entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

function extractErrorCodes(source: string): Set<string> {
  // Strict shape: `{ ok: false, error: "<code>"`. Captures only static
  // string codes; ignores dynamic-template `error: \`${prefix}:${...}\``.
  const codes = new Set<string>();
  const re = /\{\s*ok:\s*false\s*,\s*error:\s*"([a-z][a-z0-9-]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    codes.add(m[1]);
  }
  return codes;
}

describe("formatIpcError — full IPC error code coverage", () => {
  it("every error code returned by src/ipc/domains/** has a Korean mapping", () => {
    const files = listTsFiles(IPC_DOMAIN_DIR);
    expect(files.length).toBeGreaterThan(0);

    const allCodes = new Set<string>();
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      for (const code of extractErrorCodes(src)) allCodes.add(code);
    }

    const missing = [...allCodes]
      .filter((code) => !(code in COMMON_IPC_ERROR_MESSAGES))
      .sort();

    if (missing.length > 0) {
      throw new Error(
        `Unmapped IPC error codes (add to COMMON_IPC_ERROR_MESSAGES in src/ui/renderer/format-ipc-error.ts):\n  ${missing.join("\n  ")}`,
      );
    }
  });

  it("COMMON_IPC_ERROR_MESSAGES values are non-empty Korean strings", () => {
    for (const [code, message] of Object.entries(COMMON_IPC_ERROR_MESSAGES)) {
      expect(message.length, `code "${code}" has empty message`).toBeGreaterThan(0);
      // Korean range: U+AC00–U+D7A3 (Hangul syllables). Each message
      // must contain at least one Hangul codepoint — otherwise it is
      // still an English passthrough.
      expect(
        /[가-힣]/.test(message),
        `code "${code}" message lacks Korean characters: "${message}"`,
      ).toBe(true);
    }
  });
});
