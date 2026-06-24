/**
 * buildSafeChildEnv() — allowlist correctness, secret stripping, extra merging.
 *
 * UQ-QUALITY SEV-2 #2
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { vi } from "vitest";

import { buildSafeChildEnv, buildSandboxedChildEnv } from "../safe-env.js";

const SAFE_KEYS = ["PATH", "HOME", "USER", "USERNAME", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "TERM", "SHELL", "TMPDIR", "TMP", "TEMP", "PWD"] as const;

const SECRET_KEYS = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GOOGLE_API_KEY",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "GITHUB_TOKEN",
  "LVIS_INTERNAL_SECRET",
  "LVIS_API_KEY",
];

beforeEach(() => {
  // Inject known-value safe keys and dangerous secret keys into process.env
  vi.stubEnv("PATH", "/usr/bin:/bin");
  vi.stubEnv("HOME", "/home/testuser");
  vi.stubEnv("ANTHROPIC_API_KEY", "sk-secret-anthropic-key");
  vi.stubEnv("OPENAI_API_KEY", "sk-secret-openai-key");
  vi.stubEnv("GOOGLE_API_KEY", "google-secret");
  vi.stubEnv("AWS_ACCESS_KEY_ID", "AKIAIOSFODNN7EXAMPLE");
  vi.stubEnv("AWS_SECRET_ACCESS_KEY", "wJalrXUtnFEMI/K7MDENG");
  vi.stubEnv("GITHUB_TOKEN", "ghp_xxxxxxxxxxxx");
  vi.stubEnv("LVIS_INTERNAL_SECRET", "lvis-secret-value");
  vi.stubEnv("LVIS_API_KEY", "lvis-api-key-value");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("buildSafeChildEnv — secret stripping", () => {
  it("does not include ANTHROPIC_API_KEY", () => {
    const env = buildSafeChildEnv();
    expect(env).not.toHaveProperty("ANTHROPIC_API_KEY");
  });

  it("does not include OPENAI_API_KEY", () => {
    const env = buildSafeChildEnv();
    expect(env).not.toHaveProperty("OPENAI_API_KEY");
  });

  it("does not include GOOGLE_API_KEY", () => {
    const env = buildSafeChildEnv();
    expect(env).not.toHaveProperty("GOOGLE_API_KEY");
  });

  it("does not include AWS_ACCESS_KEY_ID", () => {
    const env = buildSafeChildEnv();
    expect(env).not.toHaveProperty("AWS_ACCESS_KEY_ID");
  });

  it("does not include AWS_SECRET_ACCESS_KEY", () => {
    const env = buildSafeChildEnv();
    expect(env).not.toHaveProperty("AWS_SECRET_ACCESS_KEY");
  });

  it("does not include GITHUB_TOKEN", () => {
    const env = buildSafeChildEnv();
    expect(env).not.toHaveProperty("GITHUB_TOKEN");
  });

  it("does not include LVIS-prefixed internal secrets", () => {
    const env = buildSafeChildEnv();
    expect(env).not.toHaveProperty("LVIS_INTERNAL_SECRET");
    expect(env).not.toHaveProperty("LVIS_API_KEY");
  });

  it("strips all secret keys simultaneously", () => {
    const env = buildSafeChildEnv();
    for (const key of SECRET_KEYS) {
      expect(Object.prototype.hasOwnProperty.call(env, key)).toBe(false);
    }
  });
});

describe("buildSafeChildEnv — allowlist forwarding", () => {
  it("forwards PATH when present", () => {
    const env = buildSafeChildEnv();
    expect(env.PATH).toBe("/usr/bin:/bin");
  });

  it("forwards HOME when present", () => {
    const env = buildSafeChildEnv();
    expect(env.HOME).toBe("/home/testuser");
  });

  it("only includes keys from FORWARD_ENV_KEYS (plus extras)", () => {
    const env = buildSafeChildEnv();
    for (const key of Object.keys(env)) {
      const isSafeKey = (SAFE_KEYS as readonly string[]).includes(key);
      // extra keys would be added separately — base call has no extras
      expect(isSafeKey).toBe(true);
    }
  });

  it("omits undefined safe keys (does not inject empty strings)", () => {
    // USERNAME is often undefined on macOS — confirm no undefined values
    const env = buildSafeChildEnv();
    for (const [, val] of Object.entries(env)) {
      expect(val).not.toBeUndefined();
    }
  });
});

describe("buildSafeChildEnv — extra merging", () => {
  it("includes extra keys passed in", () => {
    const env = buildSafeChildEnv({ LVIS_HOOK_EVENT: "pre-turn", LVIS_HOOK_SESSION: "sess-1" });
    expect(env.LVIS_HOOK_EVENT).toBe("pre-turn");
    expect(env.LVIS_HOOK_SESSION).toBe("sess-1");
  });

  it("extra keys override safe baseline when colliding", () => {
    const env = buildSafeChildEnv({ PATH: "/custom/bin" });
    expect(env.PATH).toBe("/custom/bin");
  });

  it("extras do NOT include secret keys that were not in FORWARD_ENV_KEYS", () => {
    // Confirm that secrets from process.env are still not forwarded even with extras present
    const env = buildSafeChildEnv({ CUSTOM_KEY: "safe-value" });
    expect(env).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(env.CUSTOM_KEY).toBe("safe-value");
  });

  it("returns a fresh object each call (no shared state)", () => {
    const env1 = buildSafeChildEnv({ X: "1" });
    const env2 = buildSafeChildEnv({ X: "2" });
    expect(env1.X).toBe("1");
    expect(env2.X).toBe("2");
    expect(env1).not.toBe(env2);
  });

  it("empty extras results in only safe keys", () => {
    const envWithEmpty = buildSafeChildEnv({});
    const envWithNoArg = buildSafeChildEnv();
    expect(Object.keys(envWithEmpty)).toEqual(Object.keys(envWithNoArg));
  });
});

describe("buildSandboxedChildEnv — ASRT env composition (PR #1356 allow-list)", () => {
  it("strips host secrets on the sandbox path (wrapped env carrying them does not re-leak)", () => {
    // ASRT's wrapped env = process.env + its additions. Simulate it carrying
    // the host secrets verbatim (same value as process.env) — they must NOT
    // appear in the composed child env.
    const wrapped: NodeJS.ProcessEnv = {
      ...process.env,
      HTTP_PROXY: "http://localhost:9999",
    };
    const env = buildSandboxedChildEnv(wrapped);
    for (const key of SECRET_KEYS) {
      expect(Object.prototype.hasOwnProperty.call(env, key)).toBe(false);
    }
  });

  it("preserves ASRT proxy keys it added", () => {
    const wrapped: NodeJS.ProcessEnv = {
      ...process.env,
      HTTP_PROXY: "http://srt:tok@localhost:8080",
      HTTPS_PROXY: "http://srt:tok@localhost:8080",
      ALL_PROXY: "socks5h://srt:tok@localhost:1080",
      NO_PROXY: "localhost,127.0.0.1",
    };
    const env = buildSandboxedChildEnv(wrapped);
    expect(env.HTTP_PROXY).toBe("http://srt:tok@localhost:8080");
    expect(env.HTTPS_PROXY).toBe("http://srt:tok@localhost:8080");
    expect(env.ALL_PROXY).toBe("socks5h://srt:tok@localhost:1080");
    expect(env.NO_PROXY).toBe("localhost,127.0.0.1");
  });

  it("preserves ASRT CA-cert keys it added (NODE_EXTRA_CA_CERTS et al.)", () => {
    const wrapped: NodeJS.ProcessEnv = {
      ...process.env,
      NODE_EXTRA_CA_CERTS: "/tmp/srt-ca.pem",
      SSL_CERT_FILE: "/tmp/srt-ca.pem",
      REQUESTS_CA_BUNDLE: "/tmp/srt-ca.pem",
      PIP_CERT: "/tmp/srt-ca.pem",
    };
    const env = buildSandboxedChildEnv(wrapped);
    expect(env.NODE_EXTRA_CA_CERTS).toBe("/tmp/srt-ca.pem");
    expect(env.SSL_CERT_FILE).toBe("/tmp/srt-ca.pem");
    expect(env.REQUESTS_CA_BUNDLE).toBe("/tmp/srt-ca.pem");
    expect(env.PIP_CERT).toBe("/tmp/srt-ca.pem");
  });

  it("does NOT propagate a non-allow-listed key even when it differs from process.env", () => {
    // A future ASRT (or a tampered wrap) emits a non-allow-listed key with a
    // value that differs from process.env. Under the old "overlay anything that
    // differs" rule this would leak; the explicit allow-list refuses it.
    const wrapped: NodeJS.ProcessEnv = {
      ...process.env,
      ANTHROPIC_API_KEY: "sk-MUTATED-leaked-value", // differs from process.env
      SOME_FUTURE_ASRT_VAR: "unexpected",
      HTTP_PROXY: "http://localhost:8080", // allow-listed → should pass
    };
    const env = buildSandboxedChildEnv(wrapped);
    expect(Object.prototype.hasOwnProperty.call(env, "ANTHROPIC_API_KEY")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(env, "SOME_FUTURE_ASRT_VAR")).toBe(false);
    expect(env.HTTP_PROXY).toBe("http://localhost:8080");
  });

  it("includes the safe baseline (PATH/HOME) alongside ASRT additions", () => {
    const env = buildSandboxedChildEnv({ ...process.env, HTTP_PROXY: "http://localhost:8080" });
    expect(env.PATH).toBe("/usr/bin:/bin");
    expect(env.HOME).toBe("/home/testuser");
  });
});
