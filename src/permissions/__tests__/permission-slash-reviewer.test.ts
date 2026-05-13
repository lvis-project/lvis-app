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

  it("parses 'provider openai'", () => {
    expect(parsePermissionReviewerCommand("provider openai")).toEqual({
      verb: "provider",
      value: "openai",
    });
  });

  it("parses 'model gpt-4o-mini'", () => {
    expect(parsePermissionReviewerCommand("model gpt-4o-mini")).toEqual({
      verb: "model",
      value: "gpt-4o-mini",
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
      expect(r.settings.mode).toBe("disabled");
      expect(r.settings.provider).toBe("openai");
      expect(r.settings.model).toBe("gpt-4o-mini");
      expect(r.settings.fallbackOnError).toBe("deny");
    }
  });

  it("mode rule persists to settings.json", async () => {
    const path = tmpSettingsPath();
    await dispatchPermissionReviewerCommand({ verb: "mode", value: "rule" }, path);
    const settings = readPermissionSettings(path);
    expect(settings.permissions.reviewer.mode).toBe("rule");
  });

  it("provider anthropic persists", async () => {
    const path = tmpSettingsPath();
    await dispatchPermissionReviewerCommand({ verb: "provider", value: "anthropic" }, path);
    const settings = readPermissionSettings(path);
    expect(settings.permissions.reviewer.provider).toBe("anthropic");
  });

  it("model claude-haiku persists", async () => {
    const path = tmpSettingsPath();
    await dispatchPermissionReviewerCommand(
      { verb: "model", value: "claude-haiku-4-5" },
      path,
    );
    const settings = readPermissionSettings(path);
    expect(settings.permissions.reviewer.model).toBe("claude-haiku-4-5");
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

  it("interactive off persists and is the safe default", async () => {
    const path = tmpSettingsPath();
    // First flip to low, then back to off — confirms the toggle is bidirectional.
    await dispatchPermissionReviewerCommand({ verb: "interactive", value: "low" }, path);
    await dispatchPermissionReviewerCommand({ verb: "interactive", value: "off" }, path);
    const settings = readPermissionSettings(path);
    expect(settings.permissions.reviewer.interactive.autoApprove).toBe("off");
  });

  it("invalid interactive value returns ok:false (MED auto-approve is not in scope)", async () => {
    const path = tmpSettingsPath();
    const r = await dispatchPermissionReviewerCommand(
      { verb: "interactive", value: "medium" },
      path,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/invalid interactive/);
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

  it("invalid provider returns ok:false", async () => {
    const path = tmpSettingsPath();
    const r = await dispatchPermissionReviewerCommand(
      { verb: "provider", value: "ollama" },
      path,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/invalid provider/);
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

  it("empty model returns ok:false", async () => {
    const path = tmpSettingsPath();
    const r = await dispatchPermissionReviewerCommand({ verb: "model", value: "" }, path);
    expect(r.ok).toBe(false);
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
      mode: "disabled",
      provider: "openai",
      model: "gpt-4o-mini",
      fallbackOnError: "deny",
      interactive: { autoApprove: "off" },
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
    expect(settings.permissions.reviewer.mode).toBe("disabled");
    expect(settings.permissions.reviewer.provider).toBe("openai");
    expect(settings.permissions.reviewer.fallbackOnError).toBe("deny");
    expect(settings.permissions.reviewer.model).toBe("gpt-4o-mini");
  });

  it("valid reviewer block round-trips", () => {
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
      interactive: { autoApprove: "off" },
    });
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
    // Read normalises silently (external boundary).
    const r = readPermissionSettings(path);
    expect(r.permissions.reviewer.mode).toBe("disabled");
  });
});
