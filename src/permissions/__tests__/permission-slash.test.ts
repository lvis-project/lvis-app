import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parsePermissionDirCommand,
  dispatchPermissionDirCommand,
} from "../permission-slash.js";
import {
  readPermissionSettings,
  writePermissionSettings,
  addAllowedDirectoryPersist,
  normalizePermissionSettings,
} from "../permission-settings-store.js";

function tmpSettingsPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "lvis-perm-slash-"));
  return join(dir, "settings.json");
}

describe("parsePermissionDirCommand", () => {
  it("parses 'allow <path>'", () => {
    const r = parsePermissionDirCommand("allow /Users/ken/work");
    expect(r).toEqual({ verb: "allow", path: "/Users/ken/work", session: false, acknowledgeWarnings: false });
  });

  it("parses quoted paths with spaces", () => {
    const r = parsePermissionDirCommand('allow "/Users/ken/My Project"');
    expect(r).toEqual({ verb: "allow", path: "/Users/ken/My Project", session: false, acknowledgeWarnings: false });
  });

  it("parses 'allow <path> --session'", () => {
    const r = parsePermissionDirCommand("allow /Users/ken/work --session");
    expect(r).toEqual({ verb: "allow", path: "/Users/ken/work", session: true, acknowledgeWarnings: false });
  });

  it("parses 'allow --session <path>' (flag before path)", () => {
    const r = parsePermissionDirCommand("allow --session /Users/ken/work");
    expect(r).toEqual({ verb: "allow", path: "/Users/ken/work", session: true, acknowledgeWarnings: false });
  });

  it("parses 'allow --ack-warnings <path>'", () => {
    const r = parsePermissionDirCommand("allow --ack-warnings /Users/ken/work");
    expect(r).toEqual({ verb: "allow", path: "/Users/ken/work", session: false, acknowledgeWarnings: true });
  });

  it("parses 'deny <path>'", () => {
    const r = parsePermissionDirCommand("deny /tmp/staging");
    expect(r).toEqual({ verb: "deny", path: "/tmp/staging", session: false, acknowledgeWarnings: false });
  });

  it("parses 'list'", () => {
    const r = parsePermissionDirCommand("list");
    expect(r).toEqual({ verb: "list", path: "", session: false, acknowledgeWarnings: false });
  });

  it("rejects empty input", () => {
    const r = parsePermissionDirCommand("");
    expect(r).toMatchObject({ ok: false });
  });

  it("rejects unknown verb", () => {
    const r = parsePermissionDirCommand("toggle /foo");
    expect(r).toMatchObject({ ok: false });
  });

  it("rejects 'list' with extra arg", () => {
    const r = parsePermissionDirCommand("list /foo");
    expect(r).toMatchObject({ ok: false });
  });

  it("rejects 'allow' without path", () => {
    const r = parsePermissionDirCommand("allow");
    expect(r).toMatchObject({ ok: false });
  });

  it("rejects 'deny --session'", () => {
    const r = parsePermissionDirCommand("deny /tmp/foo --session");
    expect(r).toMatchObject({ ok: false });
  });

  it("rejects 'deny --ack-warnings'", () => {
    const r = parsePermissionDirCommand("deny /tmp/foo --ack-warnings");
    expect(r).toMatchObject({ ok: false });
  });

  it("rejects 'allow' with multiple paths", () => {
    const r = parsePermissionDirCommand("allow /foo /bar");
    expect(r).toMatchObject({ ok: false });
  });

  it("rejects unterminated quoted paths", () => {
    const r = parsePermissionDirCommand('allow "/foo');
    expect(r).toMatchObject({ ok: false });
  });
});

describe("dispatchPermissionDirCommand — allow", () => {
  it("persists a valid directory to settings.json", async () => {
    const path = tmpSettingsPath();
    const r = await dispatchPermissionDirCommand(
      { verb: "allow", path: "/Users/ken/work", session: false, acknowledgeWarnings: false },
      path,
    );
    expect(r).toMatchObject({ ok: true, verb: "allow", sessionOnly: false });
    const onDisk = readPermissionSettings(path);
    expect(onDisk.permissions.additionalDirectories).toContain("/Users/ken/work");
  });

  it("rejects sensitive path", async () => {
    const path = tmpSettingsPath();
    const r = await dispatchPermissionDirCommand(
      { verb: "allow", path: "/etc/shadow", session: false, acknowledgeWarnings: false },
      path,
    );
    expect(r).toMatchObject({ ok: false });
  });

  it("--session does NOT persist to disk", async () => {
    const path = tmpSettingsPath();
    const r = await dispatchPermissionDirCommand(
      { verb: "allow", path: "/Users/ken/work", session: true, acknowledgeWarnings: false },
      path,
    );
    expect(r).toMatchObject({ ok: true, sessionOnly: true, sessionDirectory: "/users/ken/work" });
    const onDisk = readPermissionSettings(path);
    expect(onDisk.permissions.additionalDirectories).toEqual([]);
  });

  it("requires explicit acknowledgement before persisting adjacency warnings (.git)", async () => {
    const path = tmpSettingsPath();
    const r = await dispatchPermissionDirCommand(
      { verb: "allow", path: "/Users/ken/work/proj/.git", session: false, acknowledgeWarnings: false },
      path,
    );
    expect(r).toMatchObject({ ok: false, requiresAcknowledgement: true });
    if (!r.ok) {
      expect(r.warnings.some((w) => w.includes(".git"))).toBe(true);
    }
    const onDisk = readPermissionSettings(path);
    expect(onDisk.permissions.additionalDirectories).toEqual([]);
  });

  it("persists adjacency-warning paths only after acknowledgement", async () => {
    const path = tmpSettingsPath();
    const r = await dispatchPermissionDirCommand(
      { verb: "allow", path: "/Users/ken/work/proj/.git", session: false, acknowledgeWarnings: true },
      path,
    );
    expect(r).toMatchObject({ ok: true, verb: "allow" });
    const onDisk = readPermissionSettings(path);
    expect(onDisk.permissions.additionalDirectories).toContain("/Users/ken/work/proj/.git");
  });
});

describe("dispatchPermissionDirCommand — deny", () => {
  it("removes a directory from settings.json", async () => {
    const path = tmpSettingsPath();
    await addAllowedDirectoryPersist("/Users/ken/work", path);
    await addAllowedDirectoryPersist("/Users/ken/Documents", path);

    const r = await dispatchPermissionDirCommand(
      { verb: "deny", path: "/Users/ken/work", session: false, acknowledgeWarnings: false },
      path,
    );
    expect(r).toMatchObject({ ok: true, verb: "deny" });
    const onDisk = readPermissionSettings(path);
    expect(onDisk.permissions.additionalDirectories).not.toContain("/Users/ken/work");
    expect(onDisk.permissions.additionalDirectories).toContain("/Users/ken/Documents");
  });
});

describe("dispatchPermissionDirCommand — list", () => {
  it("returns defaults + user additions + effective scope", async () => {
    const path = tmpSettingsPath();
    await addAllowedDirectoryPersist("/Users/ken/Documents", path);
    const r = await dispatchPermissionDirCommand(
      { verb: "list", path: "", session: false, acknowledgeWarnings: false },
      path,
    );
    expect(r).toMatchObject({ ok: true, verb: "list" });
    if (r.ok && r.verb === "list") {
      expect(r.userAdditions).toContain("/Users/ken/Documents");
      // effective = defaults ∪ user-additions
      expect(r.effective.length).toBeGreaterThanOrEqual(r.defaults.length);
    }
  });
});

describe("readPermissionSettings — settings persistence", () => {
  it("returns empty default when file does not exist", () => {
    const path = tmpSettingsPath();
    const r = readPermissionSettings(path);
    expect(r.permissions.additionalDirectories).toEqual([]);
  });

  it("round-trips additionalDirectories", async () => {
    const path = tmpSettingsPath();
    await writePermissionSettings(
      { additionalDirectories: ["/Users/ken/a", "/Users/ken/b"] },
      path,
    );
    const r = readPermissionSettings(path);
    expect(r.permissions.additionalDirectories).toEqual([
      "/Users/ken/a",
      "/Users/ken/b",
    ]);
  });

  it("preserves unrelated top-level keys on write", async () => {
    const path = tmpSettingsPath();
    writeFileSync(
      path,
      JSON.stringify({ otherKey: "preserve me", permissions: {} }),
      "utf-8",
    );
    await writePermissionSettings({ additionalDirectories: ["/foo"] }, path);
    const raw = JSON.parse(readFileSync(path, "utf-8"));
    expect(raw.otherKey).toBe("preserve me");
    expect(raw.permissions.additionalDirectories).toEqual(["/foo"]);
  });

  it("falls back to defaults on malformed JSON", () => {
    const path = tmpSettingsPath();
    writeFileSync(path, "{not-json", "utf-8");
    const r = readPermissionSettings(path);
    expect(r.permissions.additionalDirectories).toEqual([]);
  });
});

describe("normalizePermissionSettings — canonical permissions", () => {
  it("ignores non-SOT 'allowedDirectories' entries", () => {
    const r = normalizePermissionSettings({
      permissions: { allowedDirectories: ["/legacy/dir"] },
    });
    expect(r.permissions.additionalDirectories).toEqual([]);
  });

  it("uses canonical 'additionalDirectories' when both keys are present", () => {
    const r = normalizePermissionSettings({
      permissions: {
        additionalDirectories: ["/new/dir"],
        allowedDirectories: ["/legacy/dir"],
      },
    });
    expect(r.permissions.additionalDirectories).toEqual(["/new/dir"]);
  });

  it("returns empty when neither key is present", () => {
    const r = normalizePermissionSettings({ permissions: {} });
    expect(r.permissions.additionalDirectories).toEqual([]);
  });
});

describe("writePermissionSettings — alias is dropped on write", () => {
  it("removes legacy allowedDirectories key when re-saving", async () => {
    const path = tmpSettingsPath();
    writeFileSync(
      path,
      JSON.stringify({
        permissions: {
          allowedDirectories: ["/legacy"],
          someOtherKey: 42,
        },
      }),
      "utf-8",
    );
    await writePermissionSettings({ additionalDirectories: ["/new"] }, path);
    const raw = JSON.parse(readFileSync(path, "utf-8"));
    expect(raw.permissions.allowedDirectories).toBeUndefined();
    expect(raw.permissions.additionalDirectories).toEqual(["/new"]);
    expect(raw.permissions.someOtherKey).toBe(42);
  });
});
