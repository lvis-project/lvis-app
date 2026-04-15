/**
 * sensitive-paths unit tests — Tier S1+S2
 *
 * Covers SENSITIVE_PATH_PATTERNS, isSensitivePath(), and policyMatchPaths().
 */
import { describe, it, expect } from "vitest";
import {
  SENSITIVE_PATH_PATTERNS,
  isSensitivePath,
  policyMatchPaths,
} from "../sensitive-paths.js";

describe("SENSITIVE_PATH_PATTERNS", () => {
  it("is a non-empty readonly list", () => {
    expect(Array.isArray(SENSITIVE_PATH_PATTERNS)).toBe(true);
    expect(SENSITIVE_PATH_PATTERNS.length).toBeGreaterThan(0);
    // Frozen — cannot be mutated by callers
    expect(Object.isFrozen(SENSITIVE_PATH_PATTERNS)).toBe(true);
  });

  it("contains core OpenHarness patterns", () => {
    expect(SENSITIVE_PATH_PATTERNS).toContain("**/.ssh/*");
    expect(SENSITIVE_PATH_PATTERNS).toContain("**/.aws/credentials");
    expect(SENSITIVE_PATH_PATTERNS).toContain("**/.aws/config");
    expect(SENSITIVE_PATH_PATTERNS).toContain("**/.gnupg/**");
    expect(SENSITIVE_PATH_PATTERNS).toContain("**/.kube/config");
  });

  it("contains LGE/LVIS-specific additions", () => {
    expect(SENSITIVE_PATH_PATTERNS).toContain("**/.lvis/certs/**");
    expect(SENSITIVE_PATH_PATTERNS).toContain("**/.lvis/secrets/**");
    expect(SENSITIVE_PATH_PATTERNS).toContain("**/.lvis/keys/**");
    expect(SENSITIVE_PATH_PATTERNS).toContain("**/.lvis/lvis-secrets.json");
    expect(SENSITIVE_PATH_PATTERNS).toContain("**/lvis-secrets.json");
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
  it("matches /home/ken/.ssh/id_rsa against **/.ssh/*", () => {
    const result = isSensitivePath("/home/ken/.ssh/id_rsa");
    expect(result).toBe("**/.ssh/*");
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

  it("matches /Users/ken/.lvis/certs/corp-ca.pem (LGE addition)", () => {
    const result = isSensitivePath("/Users/ken/.lvis/certs/corp-ca.pem");
    expect(result).toBe("**/.lvis/certs/**");
  });

  it("matches /Users/ken/.lvis/secrets/openai.key (LGE addition)", () => {
    expect(isSensitivePath("/Users/ken/.lvis/secrets/openai.key")).toBe(
      "**/.lvis/secrets/**",
    );
  });

  it("matches /Users/ken/.lvis/lvis-secrets.json (LGE addition)", () => {
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
    // `.gnupg` as a directory path (no trailing slash) should still be
    // flagged: the helper tries both `/home/ken/.gnupg` and the trailing
    // slash form. Pattern `**/.gnupg/**` has `**` which can match empty,
    // so `/home/ken/.gnupg/` matches.
    const result = isSensitivePath("/home/ken/.gnupg");
    expect(result).toBe("**/.gnupg/**");
  });

  it("matches /Users/ken/.lvis/certs (directory form) via **/.lvis/certs/**", () => {
    expect(isSensitivePath("/Users/ken/.lvis/certs")).toBe("**/.lvis/certs/**");
  });
});

describe("isSensitivePath — negative cases", () => {
  it("returns null for /home/ken/code/ssh-utils.ts (filename contains ssh but not in .ssh dir)", () => {
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

  it("returns null for /Users/ken/.lvis/notes/meeting.md (non-sensitive subdir of .lvis)", () => {
    expect(isSensitivePath("/Users/ken/.lvis/notes/meeting.md")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(isSensitivePath("")).toBeNull();
  });
});
