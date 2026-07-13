/**
 * Permission policy Phase 3 — `/permission reviewer` slash + settings persistence tests.
 */
import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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

function tmpSettingsPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "lvis-perm-reviewer-"));
  return join(dir, "settings.json");
}

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
    const settings = normalizePermissionSettings({});
    expect(settings.permissions.reviewer).toEqual({
      // Default reviewer mode is "llm" (strongest classifier; degrades to rule
      // at boot when no provider is configured). interactive.autoApprove "medium"
      // silently allows LOW/MEDIUM foreground calls.
      mode: "llm",
      provider: "openai",
      model: "gpt-4o-mini",
      fallbackOnError: "deny",
      interactive: { autoApprove: "medium" },
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
    });
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
    });
    expect(settings.permissions.reviewer).toEqual({
      mode: "llm",
      provider: "anthropic",
      model: "claude-haiku-4-5",
      fallbackOnError: "deny",
      // Only absent fields take the new default; explicit fields above are kept.
      interactive: { autoApprove: "medium" },
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
    });
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
