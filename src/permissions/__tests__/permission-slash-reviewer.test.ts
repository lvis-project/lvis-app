/**
 * Permission policy Phase 3 — `/permission reviewer` slash + settings persistence tests.
 */
import { afterEach, describe, it, expect, vi } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  parsePermissionReviewerCommand,
  dispatchPermissionReviewerCommand,
  dispatchPermissionReviewerCommandWithRewire,
} from "../permission-slash.js";
import {
  readPermissionSettings,
  setReviewerSettingsPersist,
  normalizePermissionSettings,
  writePermissionSettings,
} from "../permission-settings-store.js";
import { PermissionTestResources } from "./test-resources.js";

/** Only ever named in a fault; `normalizePermissionSettings` reads no file. */
const SETTINGS_PATH = "/nonexistent/settings.json";

const resources = new PermissionTestResources();

function tmpSettingsPath(): string {
  const dir = resources.makeTmpDir("lvis-perm-reviewer-");
  return join(dir, "settings.json");
}

afterEach(async () => {
  await resources.cleanup();
});

describe("parsePermissionReviewerCommand", () => {
  it("parses 'show'", () => {
    expect(parsePermissionReviewerCommand("show")).toEqual({ verb: "show", value: "" });
  });

  it("parses 'mode disabled'", () => {
    expect(parsePermissionReviewerCommand("mode disabled")).toEqual({
      verb: "mode",
      value: "disabled",
    });
  });

  it("parses 'mode rule'", () => {
    expect(parsePermissionReviewerCommand("mode rule")).toEqual({
      verb: "mode",
      value: "rule",
    });
  });

  it("parses 'mode llm'", () => {
    expect(parsePermissionReviewerCommand("mode llm")).toEqual({
      verb: "mode",
      value: "llm",
    });
  });

  it("rejects reviewer-local provider changes", () => {
    expect(parsePermissionReviewerCommand("provider openai")).toEqual({
      ok: false,
      error: expect.stringContaining("active LLM settings"),
    });
  });

  it("rejects reviewer-local model changes", () => {
    expect(parsePermissionReviewerCommand("model gpt-4o-mini")).toEqual({
      ok: false,
      error: expect.stringContaining("active LLM settings"),
    });
  });

  it("parses 'fallback deny'", () => {
    expect(parsePermissionReviewerCommand("fallback deny")).toEqual({
      verb: "fallback",
      value: "deny",
    });
  });

  it("parses 'interactive off' (issue #690)", () => {
    expect(parsePermissionReviewerCommand("interactive off")).toEqual({
      verb: "interactive",
      value: "off",
    });
  });

  it("parses 'interactive low' (issue #690)", () => {
    expect(parsePermissionReviewerCommand("interactive low")).toEqual({
      verb: "interactive",
      value: "low",
    });
  });

  it("parses 'interactive medium'", () => {
    expect(parsePermissionReviewerCommand("interactive medium")).toEqual({
      verb: "interactive",
      value: "medium",
    });
  });

  it("rejects empty input", () => {
    const r = parsePermissionReviewerCommand("");
    expect(r).toEqual({ ok: false, error: expect.stringMatching(/missing subcommand/) });
  });

  it("rejects unknown verb", () => {
    const r = parsePermissionReviewerCommand("foo bar");
    expect(r).toEqual({ ok: false, error: expect.stringMatching(/unknown subcommand/) });
  });

  it("rejects 'mode' with no value", () => {
    const r = parsePermissionReviewerCommand("mode");
    expect(r).toEqual({ ok: false, error: expect.stringMatching(/requires a value/) });
  });

  it("rejects 'mode' with too many args", () => {
    const r = parsePermissionReviewerCommand("mode rule extra");
    expect(r).toEqual({ ok: false, error: expect.stringMatching(/single value/) });
  });

  it("parses 'adjudication <field> <value>'", () => {
    expect(parsePermissionReviewerCommand("adjudication maxVerdict low")).toEqual({
      verb: "adjudication",
      value: "low",
      field: "maxVerdict",
    });
  });

  it("rejects 'adjudication' with no field", () => {
    const r = parsePermissionReviewerCommand("adjudication");
    expect(r).toEqual({ ok: false, error: expect.stringMatching(/requires a field and a value/) });
  });

  it("rejects an unknown adjudication field", () => {
    const r = parsePermissionReviewerCommand("adjudication bogus 1");
    expect(r).toEqual({ ok: false, error: expect.stringMatching(/unknown adjudication field/) });
  });

  it("rejects 'adjudication' with too many args", () => {
    const r = parsePermissionReviewerCommand("adjudication timeoutMs 1000 extra");
    expect(r).toEqual({ ok: false, error: expect.stringMatching(/single value/) });
  });
});

describe("dispatchPermissionReviewerCommand — parent adjudication", () => {
  it("persists one ceiling without disturbing the other five", async () => {
    const path = tmpSettingsPath();
    const r = await dispatchPermissionReviewerCommand(
      { verb: "adjudication", value: "low", field: "maxVerdict" },
      path,
    );
    expect(r.ok).toBe(true);
    const block = readPermissionSettings(path).permissions.reviewer.parentAdjudication;
    expect(block.maxVerdict).toBe("low");
    expect(block.timeoutMs).toBe(30_000);
    expect(block.maxPerChildRun).toBe(200);
    expect(block.includeParentContextTurns).toBe(0);
    expect(block.backgroundEscalation).toBe("deferred");
    expect(block.model).toBe("reviewer");
  });

  it("persists every writable field", async () => {
    const path = tmpSettingsPath();
    for (const [field, value] of [
      ["timeoutMs", "45000"],
      ["maxPerChildRun", "50"],
      ["includeParentContextTurns", "2"],
      ["backgroundEscalation", "modal"],
      ["model", "parent-session"],
    ] as const) {
      const r = await dispatchPermissionReviewerCommand(
        { verb: "adjudication", value, field },
        path,
      );
      expect(r.ok, `${field}=${value}`).toBe(true);
    }
    const block = readPermissionSettings(path).permissions.reviewer.parentAdjudication;
    expect(block.timeoutMs).toBe(45_000);
    expect(block.maxPerChildRun).toBe(50);
    expect(block.includeParentContextTurns).toBe(2);
    expect(block.backgroundEscalation).toBe("modal");
    expect(block.model).toBe("parent-session");
  });

  it("rejects an out-of-range number rather than clamping it", async () => {
    const path = tmpSettingsPath();
    const r = await dispatchPermissionReviewerCommand(
      { verb: "adjudication", value: "900000", field: "timeoutMs" },
      path,
    );
    expect(r).toEqual({ ok: false, error: expect.stringMatching(/expected 1000\.\.120000/) });
    expect(readPermissionSettings(path).permissions.reviewer.parentAdjudication.timeoutMs)
      .toBe(30_000);
  });

  it("rejects a non-integer number", async () => {
    const path = tmpSettingsPath();
    const r = await dispatchPermissionReviewerCommand(
      { verb: "adjudication", value: "2.5", field: "includeParentContextTurns" },
      path,
    );
    expect(r).toEqual({ ok: false, error: expect.stringMatching(/expected an integer/) });
  });

  it("rejects a verdict ceiling the type does not allow", async () => {
    const path = tmpSettingsPath();
    const r = await dispatchPermissionReviewerCommand(
      { verb: "adjudication", value: "high", field: "maxVerdict" },
      path,
    );
    expect(r).toEqual({ ok: false, error: expect.stringMatching(/invalid maxVerdict/) });
    expect(readPermissionSettings(path).permissions.reviewer.parentAdjudication.maxVerdict)
      .toBe("medium");
  });

  it("rejects an unknown adjudicating model source", async () => {
    const path = tmpSettingsPath();
    const r = await dispatchPermissionReviewerCommand(
      { verb: "adjudication", value: "gpt-4o", field: "model" },
      path,
    );
    expect(r).toEqual({ ok: false, error: expect.stringMatching(/invalid model/) });
  });
});

describe("dispatchPermissionReviewerCommand — persistence", () => {
  it("show returns defaults on a missing settings file", async () => {
    const path = tmpSettingsPath();
    const r = await dispatchPermissionReviewerCommand({ verb: "show", value: "" }, path);
    expect(r.ok).toBe(true);
    if (r.ok && r.verb === "show") {
      // Default reviewer is "llm" (strongest classifier). Boot wiring degrades
      // to rule at runtime when no LLM provider is configured (fresh install),
      // but the persisted/default mode is "llm" so intent stays visible.
      // interactive.autoApprove defaults to "medium" so LOW/MEDIUM foreground
      // calls are silently allowed; HIGH still surfaces.
      expect(r.settings.mode).toBe("llm");
      expect(r.settings.provider).toBe("openai");
      expect(r.settings.model).toBe("gpt-4o-mini");
      expect(r.settings.fallbackOnError).toBe("deny");
      expect(r.settings.interactive.autoApprove).toBe("medium");
    }
  });

  it("mode rule persists to settings.json", async () => {
    const path = tmpSettingsPath();
    await dispatchPermissionReviewerCommand({ verb: "mode", value: "rule" }, path);
    const settings = readPermissionSettings(path);
    expect(settings.permissions.reviewer.mode).toBe("rule");
  });

  it("provider changes are rejected and leave legacy settings untouched", async () => {
    const path = tmpSettingsPath();
    const result = await dispatchPermissionReviewerCommand(
      { verb: "provider", value: "anthropic" } as never,
      path,
    );
    const settings = readPermissionSettings(path);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("active LLM settings");
    expect(settings.permissions.reviewer.provider).toBe("openai");
  });

  it("model changes are rejected and leave legacy settings untouched", async () => {
    const path = tmpSettingsPath();
    const result = await dispatchPermissionReviewerCommand(
      { verb: "model", value: "claude-haiku-4-5" } as never,
      path,
    );
    const settings = readPermissionSettings(path);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("active LLM settings");
    expect(settings.permissions.reviewer.model).toBe("gpt-4o-mini");
  });

  it("fallback rule persists when explicitly selected", async () => {
    const path = tmpSettingsPath();
    await dispatchPermissionReviewerCommand({ verb: "fallback", value: "rule" }, path);
    const settings = readPermissionSettings(path);
    expect(settings.permissions.reviewer.fallbackOnError).toBe("rule");
  });

  it("interactive low persists (issue #690 — opt-in for auto-approve LOW)", async () => {
    const path = tmpSettingsPath();
    const r = await dispatchPermissionReviewerCommand(
      { verb: "interactive", value: "low" },
      path,
    );
    expect(r.ok).toBe(true);
    const settings = readPermissionSettings(path);
    expect(settings.permissions.reviewer.interactive.autoApprove).toBe("low");
  });

  it("interactive off persists as an explicit fail-closed choice", async () => {
    const path = tmpSettingsPath();
    // First flip to low, then back to off — confirms the toggle is bidirectional.
    await dispatchPermissionReviewerCommand({ verb: "interactive", value: "low" }, path);
    await dispatchPermissionReviewerCommand({ verb: "interactive", value: "off" }, path);
    const settings = readPermissionSettings(path);
    expect(settings.permissions.reviewer.interactive.autoApprove).toBe("off");
  });

  it("interactive medium persists as the LOW+MEDIUM foreground threshold", async () => {
    const path = tmpSettingsPath();
    const r = await dispatchPermissionReviewerCommand(
      { verb: "interactive", value: "medium" },
      path,
    );
    expect(r.ok).toBe(true);
    const settings = readPermissionSettings(path);
    expect(settings.permissions.reviewer.interactive.autoApprove).toBe("medium");
  });

  it("invalid mode returns ok:false", async () => {
    const path = tmpSettingsPath();
    const r = await dispatchPermissionReviewerCommand(
      { verb: "mode", value: "yolo" },
      path,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/invalid mode/);
  });

  it("invalid provider subcommand returns the active-LLM guidance", async () => {
    const path = tmpSettingsPath();
    const r = await dispatchPermissionReviewerCommand(
      { verb: "provider", value: "ollama" } as never,
      path,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/active LLM settings/);
  });

  it("invalid fallback returns ok:false", async () => {
    const path = tmpSettingsPath();
    const r = await dispatchPermissionReviewerCommand(
      { verb: "fallback", value: "allow" },
      path,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/invalid fallback/);
  });

  it("empty model subcommand returns the active-LLM guidance", async () => {
    const path = tmpSettingsPath();
    const r = await dispatchPermissionReviewerCommand({ verb: "model", value: "" } as never, path);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/active LLM settings/);
  });

  it("setReviewerSettingsPersist preserves additionalDirectories", async () => {
    const path = tmpSettingsPath();
    // Seed: write directories first.
    await writePermissionSettings({ additionalDirectories: ["/foo"] }, path);
    // Now change reviewer.
    await setReviewerSettingsPersist({ mode: "rule" }, path);
    const settings = readPermissionSettings(path);
    expect(settings.permissions.additionalDirectories).toEqual(["/foo"]);
    expect(settings.permissions.reviewer.mode).toBe("rule");
  });

  it("rolls back reviewer settings when runtime rewire fails", async () => {
    const path = tmpSettingsPath();
    await setReviewerSettingsPersist({ mode: "rule" }, path);
    const rewire = vi.fn(() => {
      throw new Error("missing provider");
    });

    const result = await dispatchPermissionReviewerCommandWithRewire(
      { verb: "mode", value: "llm" },
      rewire,
      path,
    );

    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining("reviewer-rewire-failed"),
    });
    expect(readPermissionSettings(path).permissions.reviewer.mode).toBe("rule");
    expect(rewire).toHaveBeenCalledTimes(2);
  });
});

describe("normalizePermissionSettings — reviewer block", () => {
  it("missing reviewer block → defaults", () => {
    const settings = normalizePermissionSettings({}, SETTINGS_PATH);
    expect(settings.permissions.reviewer).toEqual({
      // Default reviewer mode is "llm" (strongest classifier; degrades to rule
      // at boot when no provider is configured). interactive.autoApprove "medium"
      // silently allows LOW/MEDIUM foreground calls.
      mode: "llm",
      provider: "openai",
      model: "gpt-4o-mini",
      fallbackOnError: "deny",
      interactive: { autoApprove: "medium" },
      parentAdjudication: {
        maxVerdict: "medium",
        timeoutMs: 30_000,
        maxPerChildRun: 200,
        includeParentContextTurns: 0,
        backgroundEscalation: "deferred",
        model: "reviewer",
      },
    });
  });

  it("invalid enum values fall back to defaults", () => {
    const settings = normalizePermissionSettings({
      permissions: {
        reviewer: {
          mode: "yolo",
          provider: "ollama",
          fallbackOnError: "allow-and-audit",
          model: "",
        },
      },
    }, SETTINGS_PATH);
    // Unknown enum values fall back to the new "llm" default (external
    // boundary: hand-edited settings file with bad values).
    expect(settings.permissions.reviewer.mode).toBe("llm");
    expect(settings.permissions.reviewer.provider).toBe("openai");
    expect(settings.permissions.reviewer.fallbackOnError).toBe("deny");
    expect(settings.permissions.reviewer.model).toBe("gpt-4o-mini");
  });

  it("valid reviewer block round-trips (absent interactive → default medium)", () => {
    const settings = normalizePermissionSettings({
      permissions: {
        reviewer: {
          mode: "llm",
          provider: "anthropic",
          model: "claude-haiku-4-5",
          fallbackOnError: "deny",
        },
      },
    }, SETTINGS_PATH);
    expect(settings.permissions.reviewer).toEqual({
      mode: "llm",
      provider: "anthropic",
      model: "claude-haiku-4-5",
      fallbackOnError: "deny",
      // Only absent fields take the new default; explicit fields above are kept.
      interactive: { autoApprove: "medium" },
      parentAdjudication: {
        maxVerdict: "medium",
        timeoutMs: 30_000,
        maxPerChildRun: 200,
        includeParentContextTurns: 0,
        backgroundEscalation: "deferred",
        model: "reviewer",
      },
    });
  });

  it("explicit mode:rule + autoApprove:off are preserved (not overwritten by new defaults)", () => {
    // Backward-compat: a user who explicitly configured the pre-change defaults
    // must keep them. Only ABSENT fields fall to the new "llm"/"low" defaults.
    const settings = normalizePermissionSettings({
      permissions: {
        reviewer: {
          mode: "rule",
          provider: "openai",
          model: "gpt-4o-mini",
          fallbackOnError: "deny",
          interactive: { autoApprove: "off" },
        },
      },
    }, SETTINGS_PATH);
    expect(settings.permissions.reviewer.mode).toBe("rule");
    expect(settings.permissions.reviewer.interactive.autoApprove).toBe("off");
  });
});

describe("settings file persistence — reviewer block format", () => {
  it("writePermissionSettings produces stable JSON shape", async () => {
    const path = tmpSettingsPath();
    await writePermissionSettings(
      {
        additionalDirectories: ["/Users/ken/work"],
        reviewer: {
          mode: "llm",
          provider: "openai",
          model: "gpt-4o-mini",
          fallbackOnError: "rule",
        },
      },
      path,
    );
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw);
    expect(parsed.permissions.additionalDirectories).toEqual(["/Users/ken/work"]);
    expect(parsed.permissions.reviewer.mode).toBe("llm");
    expect(parsed.permissions.reviewer.provider).toBe("openai");
  });

  it("hand-edited bad enum is normalized on read but bad write rejected", async () => {
    const path = tmpSettingsPath();
    writeFileSync(
      path,
      JSON.stringify({
        permissions: { reviewer: { mode: "yolo", provider: "openai", model: "x", fallbackOnError: "rule" } },
      }),
    );
    // Read normalises silently (external boundary). Bad enum → "llm" default.
    const r = readPermissionSettings(path);
    expect(r.permissions.reviewer.mode).toBe("llm");
  });
});
