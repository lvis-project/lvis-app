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
import {
  COMMON_IPC_ERROR_MESSAGES,
  formatIpcError,
  resolveIpcErrorKey,
} from "../format-ipc-error.js";

const __dirname = resolve(fileURLToPath(import.meta.url), "..");
const IPC_DOMAIN_DIR = resolve(__dirname, "../../../ipc/domains");

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "__tests__") continue; // test fixtures may quote codes
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listTsFiles(full));
    else if (entry.isFile() && entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

function extractErrorCodes(source: string): Set<string> {
  // Captures `{ ok: false[ as const][, ...intermediate fields], error: "<code>" }`.
  //   - underscore allowed (legacy snake_case in attach.ts grandfathered)
  //   - `as const` and intermediate object fields between `false` and `error`
  //     are tolerated via `[^}]*?` (non-greedy, no closing brace)
  //   - dynamic template literals (`error: \`${prefix}:...\``) are
  //     intentionally NOT captured — those are caller-handled per the
  //     formatIpcError SOT contract (see PermissionsTab reviewer-rewire-failed)
  const codes = new Set<string>();
  const re = /\{\s*ok:\s*false\b[^}]*?\berror:\s*"([a-zA-Z][a-zA-Z0-9_-]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    codes.add(m[1]);
  }
  return codes;
}

/**
 * Codes named in a DECLARED error union rather than an inline literal, e.g.
 *
 *   error?: "unauthorized" | "path-not-allowed" | "sensitive-path" | "not-found";
 *
 * `extractErrorCodes` cannot see these: the handler returns
 * `error: directoryDenyCode(reason)` — a call, not a string literal — so the
 * code never appears in a `{ok:false, error:"..."}` shape anywhere. That blind
 * spot is exactly how `path-not-allowed` / `sensitive-path` stayed unmapped
 * while this suite was green, leaving every surface but two hand-written local
 * tables to render the raw kebab-case code.
 */
function extractDeclaredErrorUnionCodes(source: string): Set<string> {
  const codes = new Set<string>();
  const union = /\berror\??:\s*((?:"[a-zA-Z][a-zA-Z0-9_-]+"\s*\|\s*)+"[a-zA-Z][a-zA-Z0-9_-]+")/g;
  let m: RegExpExecArray | null;
  while ((m = union.exec(source)) !== null) {
    for (const member of m[1].matchAll(/"([^"]+)"/g)) codes.add(member[1]);
  }
  return codes;
}

describe("formatIpcError — full IPC error code coverage", () => {
  it("every error code returned by src/ipc/domains/** has a Korean mapping", () => {
    const files = listTsFiles(IPC_DOMAIN_DIR);
    expect(files.length).toBeGreaterThan(0);

    const allCodes = new Set<string>();
    const unionCodes = new Set<string>();
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      for (const code of extractErrorCodes(src)) allCodes.add(code);
      for (const code of extractDeclaredErrorUnionCodes(src)) {
        allCodes.add(code);
        unionCodes.add(code);
      }
    }

    // Non-vacuity floor for the union extractor specifically: if its regex ever
    // stops matching, the codes it is here to catch would silently drop out of
    // `allCodes` and this suite would go green while the leak returned.
    expect(
      unionCodes.size,
      "declared-error-union regex captured zero codes — the blind spot it closes is back",
    ).toBeGreaterThan(5);
    for (const code of ["path-not-allowed", "sensitive-path"]) {
      expect(
        unionCodes.has(code),
        `"${code}" is no longer discovered by the union extractor`,
      ).toBe(true);
    }

    const missing = [...allCodes]
      .filter((code) => !(code in COMMON_IPC_ERROR_MESSAGES))
      .sort();

    if (missing.length > 0) {
      throw new Error(
        `Unmapped IPC error codes (add to COMMON_IPC_ERROR_MESSAGES in src/ui/renderer/format-ipc-error.ts):\n  ${missing.join("\n  ")}`,
      );
    }

    // Sanity floor — guards against future regex regression that silently
    // matches zero codes (and would otherwise pass with empty `allCodes`).
    // Skeptic Multi-Perspective from round-2 critic.
    expect(
      allCodes.size,
      "regex captured zero codes — likely a regex regression (cluster review C-R2-Skeptic)",
    ).toBeGreaterThan(50);
  });

  it("every common IPC error code resolves to a non-empty localized message", () => {
    // After the i18n migration, COMMON_IPC_ERROR_MESSAGES maps each code to a
    // translation KEY; formatIpcError resolves it through t(). This suite runs
    // under the Korean test locale (see vitest-locale-ko setup), so every code
    // must resolve to a non-empty Korean message — the same invariant the old
    // "values are Korean" assertion enforced, now through the translation layer.
    for (const code of Object.keys(COMMON_IPC_ERROR_MESSAGES)) {
      const message = formatIpcError(code, undefined);
      expect(message.length, `code "${code}" has empty message`).toBeGreaterThan(0);
      // Korean range: U+AC00–U+D7A3 (Hangul syllables). A resolved message
      // lacking Hangul means the key is missing from the Korean catalog and
      // fell through to the raw key/English.
      expect(
        /[가-힣]/.test(message),
        `code "${code}" did not resolve to a Korean message: "${message}"`,
      ).toBe(true);
    }
  });
});

describe("resolveIpcErrorKey — own-property lookup", () => {
  // The table is a plain object literal, and callers now pass an arbitrary
  // `Error.message` as the code (a rejected `invoke` carries its code there). A bare
  // index resolved `toString` to `Object.prototype.toString` — truthy, and handed to
  // `t()` as a FUNCTION. This guards the guard, not the symptom.
  it("does not resolve prototype members as error codes", () => {
    for (const name of ["toString", "constructor", "valueOf", "hasOwnProperty", "__proto__"]) {
      expect(resolveIpcErrorKey(name)).toBeUndefined();
      // …and the formatter falls through to its message/unknown handling instead of
      // rendering whatever the prototype held.
      expect(typeof formatIpcError(name, undefined)).toBe("string");
    }
  });

  it("resolves a real code and ignores an empty one", () => {
    expect(resolveIpcErrorKey("rate-limited")).toBe(COMMON_IPC_ERROR_MESSAGES["rate-limited"]);
    expect(resolveIpcErrorKey("")).toBeUndefined();
    expect(resolveIpcErrorKey(undefined)).toBeUndefined();
    expect(resolveIpcErrorKey("no-such-code-here")).toBeUndefined();
  });
});
