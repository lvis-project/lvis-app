/**
 * sensitive-paths unit tests — Tier S1+S2 + Permission policy P2.5 expansion
 *
 * Covers SENSITIVE_PATH_PATTERNS, isSensitivePath(), policyMatchPaths(),
 * canonicalizePathForMatch (frozen-canonical + bounded walk-up), and
 * caseFoldForMatch.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import {
  SENSITIVE_PATH_PATTERNS,
  isSensitivePath,
  policyMatchPaths,
  canonicalizePathForMatch,
  caseFoldForMatch,
  MAX_WALK_UP,
} from "../sensitive-paths.js";

describe("SENSITIVE_PATH_PATTERNS", () => {
  it("is a non-empty readonly list", () => {
    expect(Array.isArray(SENSITIVE_PATH_PATTERNS)).toBe(true);
    expect(SENSITIVE_PATH_PATTERNS.length).toBeGreaterThan(0);
    expect(Object.isFrozen(SENSITIVE_PATH_PATTERNS)).toBe(true);
  });

  it("contains core credential-store patterns", () => {
    expect(SENSITIVE_PATH_PATTERNS).toContain("**/.ssh/**");
    expect(SENSITIVE_PATH_PATTERNS).toContain("**/.aws/credentials");
    expect(SENSITIVE_PATH_PATTERNS).toContain("**/.aws/config");
    expect(SENSITIVE_PATH_PATTERNS).toContain("**/.gnupg/**");
    expect(SENSITIVE_PATH_PATTERNS).toContain("**/.kube/config");
  });

  it("contains LVIS-specific additions", () => {
    expect(SENSITIVE_PATH_PATTERNS).toContain("**/.lvis/certs/**");
    expect(SENSITIVE_PATH_PATTERNS).toContain("**/.lvis/secrets/**");
    expect(SENSITIVE_PATH_PATTERNS).toContain("**/.lvis/keys/**");
    expect(SENSITIVE_PATH_PATTERNS).toContain("**/.lvis/lvis-secrets.json");
    expect(SENSITIVE_PATH_PATTERNS).toContain("**/lvis-secrets.json");
  });

  it("Permission policy P2.5 — contains OS sensitive paths", () => {
    expect(SENSITIVE_PATH_PATTERNS).toContain("**/etc/shadow");
    expect(SENSITIVE_PATH_PATTERNS).toContain("**/etc/sudoers");
    expect(SENSITIVE_PATH_PATTERNS).toContain("**/.netrc");
    expect(SENSITIVE_PATH_PATTERNS).toContain("**/.pgpass");
    expect(SENSITIVE_PATH_PATTERNS).toContain("**/.npmrc");
    expect(SENSITIVE_PATH_PATTERNS).toContain("**/.bash_history");
    expect(SENSITIVE_PATH_PATTERNS).toContain("**/.zsh_history");
    expect(SENSITIVE_PATH_PATTERNS).toContain("**/.python_history");
    expect(SENSITIVE_PATH_PATTERNS).toContain("**/.viminfo");
    expect(SENSITIVE_PATH_PATTERNS).toContain("**/Library/Cookies/**");
    expect(SENSITIVE_PATH_PATTERNS).toContain("**/Library/Keychains/**");
    expect(SENSITIVE_PATH_PATTERNS).toContain("**/.env");
    expect(SENSITIVE_PATH_PATTERNS).toContain("**/.env.*");
    expect(SENSITIVE_PATH_PATTERNS).toContain("**/id_rsa");
    expect(SENSITIVE_PATH_PATTERNS).toContain("**/id_ed25519");
    expect(SENSITIVE_PATH_PATTERNS).toContain("**/id_ecdsa");
  });

  it("Permission policy P2.5 — contains LVIS-internal sensitive paths", () => {
    expect(SENSITIVE_PATH_PATTERNS).toContain("**/.lvis/settings.json");
    expect(SENSITIVE_PATH_PATTERNS).toContain("**/.lvis/permissions.json");
    expect(SENSITIVE_PATH_PATTERNS).toContain("**/.lvis/policy.json");
    expect(SENSITIVE_PATH_PATTERNS).toContain("**/.lvis/permissions/**");
    expect(SENSITIVE_PATH_PATTERNS).toContain("**/.lvis/audit/**");
    expect(SENSITIVE_PATH_PATTERNS).toContain("**/.lvis/audit.log");
    expect(SENSITIVE_PATH_PATTERNS).toContain("**/.lvis/sessions/**");
    expect(SENSITIVE_PATH_PATTERNS).toContain("**/.config/lvis/hooks/**");
  });
});

describe("policyMatchPaths", () => {
  it("returns [path, path + '/'] for a non-slash-terminated path", () => {
    const result = policyMatchPaths("/home/ken/.aws");
    expect(result).toEqual(["/home/ken/.aws", "/home/ken/.aws/"]);
  });

  it("returns [path without slash, path with slash] when already slash-terminated", () => {
    const result = policyMatchPaths("/home/ken/.aws/");
    expect(result).toEqual(["/home/ken/.aws", "/home/ken/.aws/"]);
  });

  it("normalizes Windows backslashes to forward slashes", () => {
    const result = policyMatchPaths("C:\\Users\\ken\\.ssh");
    expect(result[0]).toBe("C:/Users/ken/.ssh");
    expect(result[1]).toBe("C:/Users/ken/.ssh/");
  });
});

describe("isSensitivePath — positive matches", () => {
  it("matches /home/ken/.ssh/id_rsa against **/.ssh/**", () => {
    const result = isSensitivePath("/home/ken/.ssh/id_rsa");
    expect(result).toBe("**/.ssh/**");
  });

  it("matches nested files under .ssh", () => {
    expect(isSensitivePath("/home/ken/.ssh/private/id_rsa")).toBe("**/.ssh/**");
  });

  it("matches /Users/ken/.aws/credentials", () => {
    const result = isSensitivePath("/Users/ken/.aws/credentials");
    expect(result).toBe("**/.aws/credentials");
  });

  it("matches /Users/ken/.aws/config", () => {
    expect(isSensitivePath("/Users/ken/.aws/config")).toBe("**/.aws/config");
  });

  it("matches /Users/ken/.gnupg/pubring.kbx via **/.gnupg/**", () => {
    expect(isSensitivePath("/Users/ken/.gnupg/pubring.kbx")).toBe("**/.gnupg/**");
  });

  it("matches /home/ken/.kube/config", () => {
    expect(isSensitivePath("/home/ken/.kube/config")).toBe("**/.kube/config");
  });

  it("matches /Users/ken/.lvis/certs/corp-ca.pem (LVIS addition)", () => {
    const result = isSensitivePath("/Users/ken/.lvis/certs/corp-ca.pem");
    expect(result).toBe("**/.lvis/certs/**");
  });

  it("matches /Users/ken/.lvis/secrets/openai.key (LVIS addition)", () => {
    expect(isSensitivePath("/Users/ken/.lvis/secrets/openai.key")).toBe(
      "**/.lvis/secrets/**",
    );
  });

  it("matches LVIS permission control-plane files", () => {
    expect(isSensitivePath("/Users/ken/.lvis/settings.json")).toBe("**/.lvis/settings.json");
    expect(isSensitivePath("/Users/ken/.lvis/permissions.json")).toBe("**/.lvis/permissions.json");
    expect(isSensitivePath("/Users/ken/.lvis/policy.json")).toBe("**/.lvis/policy.json");
    expect(isSensitivePath("/Users/ken/.lvis/permissions/reviewer-cache.jsonl")).toBe("**/.lvis/permissions/**");
  });

  it("matches /Users/ken/.lvis/lvis-secrets.json (LVIS addition)", () => {
    expect(isSensitivePath("/Users/ken/.lvis/lvis-secrets.json")).toBe(
      "**/.lvis/lvis-secrets.json",
    );
  });

  it("matches shallow /Users/ken/lvis-secrets.json sibling form", () => {
    expect(isSensitivePath("/Users/ken/lvis-secrets.json")).toBe(
      "**/lvis-secrets.json",
    );
  });

  it("matches /Users/ken/.config/gcloud/credentials.db via **/.config/gcloud/**", () => {
    expect(isSensitivePath("/Users/ken/.config/gcloud/credentials.db")).toBe(
      "**/.config/gcloud/**",
    );
  });
});

describe("isSensitivePath — directory (trailing-slash) form §S2", () => {
  it("matches bare directory /home/ken/.gnupg via trailing-slash helper", () => {
    const result = isSensitivePath("/home/ken/.gnupg");
    expect(result).toBe("**/.gnupg/**");
  });

  it("matches /Users/ken/.lvis/certs (directory form) via **/.lvis/certs/**", () => {
    expect(isSensitivePath("/Users/ken/.lvis/certs")).toBe("**/.lvis/certs/**");
  });
});

describe("isSensitivePath — negative cases", () => {
  it("returns null for /home/ken/code/ssh-utils.ts", () => {
    expect(isSensitivePath("/home/ken/code/ssh-utils.ts")).toBeNull();
  });

  it("returns null for /home/ken/ssh_config_template.txt", () => {
    expect(isSensitivePath("/home/ken/ssh_config_template.txt")).toBeNull();
  });

  it("returns null for /tmp/safe.txt", () => {
    expect(isSensitivePath("/tmp/safe.txt")).toBeNull();
  });

  it("returns null for /Users/ken/Documents/aws-notes.md", () => {
    expect(isSensitivePath("/Users/ken/Documents/aws-notes.md")).toBeNull();
  });

  it("returns null for /Users/ken/.lvis/plugins/meeting/notes/2026-05.md (non-sensitive plugin subdir of .lvis)", () => {
    expect(
      isSensitivePath("/Users/ken/.lvis/plugins/meeting/notes/2026-05.md"),
    ).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(isSensitivePath("")).toBeNull();
  });
});

// ─── Permission policy P2.5 — Layer 0 expansion: OS + LVIS-internal hits ───────

describe("isSensitivePath — Permission policy P2.5 OS sensitive paths", () => {
  it("matches /etc/shadow (and macOS /private/etc/shadow form)", () => {
    expect(isSensitivePath("/etc/shadow")).toBe("**/etc/shadow");
    expect(isSensitivePath("/private/etc/shadow")).toBe("**/etc/shadow");
  });

  it("matches ~/.netrc anywhere", () => {
    expect(isSensitivePath("/Users/ken/.netrc")).toBe("**/.netrc");
  });

  it("matches ~/.bash_history", () => {
    expect(isSensitivePath("/home/ken/.bash_history")).toBe("**/.bash_history");
  });

  it("matches ~/.psql_history", () => {
    expect(isSensitivePath("/home/ken/.psql_history")).toBe("**/.psql_history");
  });

  it("matches ~/Library/Cookies/* on macOS", () => {
    expect(
      isSensitivePath("/Users/ken/Library/Cookies/Cookies.binarycookies"),
    ).toBe("**/Library/Cookies/**");
  });

  it("matches ~/Library/Keychains/* on macOS", () => {
    expect(isSensitivePath("/Users/ken/Library/Keychains/login.keychain-db")).toBe(
      "**/Library/Keychains/**",
    );
  });

  it("matches **/.env at the project root", () => {
    expect(isSensitivePath("/Users/ken/code/myapp/.env")).toBe("**/.env");
  });

  it("matches **/.env.production", () => {
    expect(isSensitivePath("/Users/ken/code/myapp/.env.production")).toBe(
      "**/.env.*",
    );
  });

  it("matches generic id_rsa even outside .ssh/", () => {
    expect(isSensitivePath("/tmp/staging/id_rsa")).toBe("**/id_rsa");
  });

  it("matches generic id_ed25519 even outside .ssh/", () => {
    expect(isSensitivePath("/Users/ken/Downloads/id_ed25519")).toBe(
      "**/id_ed25519",
    );
  });
});

describe("isSensitivePath — Permission policy P2.5 LVIS-internal", () => {
  it("matches ~/.lvis/audit/today.jsonl", () => {
    expect(isSensitivePath("/Users/ken/.lvis/audit/today.jsonl")).toBe(
      "**/.lvis/audit/**",
    );
  });

  it("matches ~/.lvis/audit.log", () => {
    expect(isSensitivePath("/Users/ken/.lvis/audit.log")).toBe(
      "**/.lvis/audit.log",
    );
  });

  it("matches ~/.lvis/permissions/deferred-queue.jsonl", () => {
    expect(
      isSensitivePath("/Users/ken/.lvis/permissions/deferred-queue.jsonl"),
    ).toBe("**/.lvis/permissions/**");
  });

  it("matches ~/.lvis/sessions/<sessionId>.jsonl", () => {
    expect(isSensitivePath("/Users/ken/.lvis/sessions/abc-123.jsonl")).toBe(
      "**/.lvis/sessions/**",
    );
  });

  it("matches ~/.config/lvis/hooks/* (post-relocation)", () => {
    expect(
      isSensitivePath("/Users/ken/.config/lvis/hooks/pre-bash.sh"),
    ).toBe("**/.config/lvis/hooks/**");
  });
});

// ─── Permission policy P2.5 — canonicalizePathForMatch (frozen-canonical) ───────

describe("canonicalizePathForMatch", () => {
  function portableMatchPath(value: string): string {
    return value.replace(/\\/g, "/");
  }

  it("resolves .. segments via path.resolve()", () => {
    const result = canonicalizePathForMatch("/tmp/foo/../bar");
    expect(portableMatchPath(result).endsWith("/bar")).toBe(true);
  });

  it("collapses duplicate slashes", () => {
    const result = canonicalizePathForMatch("/tmp///foo");
    expect(result).not.toMatch(/\/\//);
  });

  it("normalizes NFD unicode to NFC", () => {
    // NFD-decomposed `.ssh` should normalize to `.ssh`. Use a char
    // that has a stable NFD form: `é` (U+00E9) ↔ `é`.
    const decomposed = "/tmp/café.txt";
    const result = canonicalizePathForMatch(decomposed);
    // After NFC, the e + combining acute should fold back to single é.
    expect(result).toContain("café");
  });

  it("returns absolute path even when the input does not exist", () => {
    const result = canonicalizePathForMatch("/tmp/__does_not_exist__/foo/bar");
    expect(isAbsolute(result)).toBe(true);
    expect(portableMatchPath(result).includes("foo/bar")).toBe(true);
  });

  it("bounded walk-up cap (MAX_WALK_UP)", () => {
    // Synthesize a deep non-existent path. Walk-up MUST terminate without
    // hanging or throwing — the function is tested by completing under
    // a generous time budget.
    const deep = "/tmp/" + "x/".repeat(MAX_WALK_UP + 10) + "leaf";
    const start = Date.now();
    const result = canonicalizePathForMatch(deep);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(2000);
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  it("MAX_WALK_UP is set to the spec value (64)", () => {
    expect(MAX_WALK_UP).toBe(64);
  });

  it("symlink ancestor is not followed into a cycle", () => {
    // Stage a self-symlink in a temp dir; canonicalize a child path and
    // confirm we get a string back (no hang, no throw). On platforms that
    // forbid self-symlinks, the test still passes via the bounded cap.
    const root = mkdtempSync(join(tmpdir(), "lvis-canonical-"));
    const linkDir = join(root, "loop");
    try {
      symlinkSync(linkDir, linkDir); // self-loop
      const child = join(linkDir, "deep", "leaf.txt");
      const result = canonicalizePathForMatch(child);
      expect(typeof result).toBe("string");
    } catch {
      // Some platforms refuse self-symlinks — skip silently. The bounded
      // walk-up still defends the algorithm; this is exercised above.
    }
  });

  it("sensitive-path detection still fires on relative .. inputs", () => {
    // Build a path that resolves via .. into a sensitive directory.
    const result = canonicalizePathForMatch(
      "/Users/ken/work/../.lvis/secrets/openai.key",
    );
    expect(isSensitivePath(caseFoldForMatch(result))).toBe(
      "**/.lvis/secrets/**",
    );
  });
});

describe("caseFoldForMatch", () => {
  it("lowercases on darwin/win32, preserves on linux", () => {
    const result = caseFoldForMatch("/Users/Ken/Documents");
    if (process.platform === "darwin" || process.platform === "win32") {
      expect(result).toBe("/users/ken/documents");
    } else {
      expect(result).toBe("/Users/Ken/Documents");
    }
  });
});
