/**
 * The view-key vocabulary.
 *
 * These tests exist because the key space used to be defined twice — a regex
 * in the main process, nothing at all in the renderer — and the renderer's
 * "nothing at all" meant an unrecognized string was rendered as a plugin view
 * rather than rejected. So the assertions here are mostly about what the
 * parser REFUSES, and about the two derived artifacts (the detach allow-list
 * and the window titles) still agreeing with the table they come from.
 */
import { describe, expect, it } from "vitest";
import {
  BUILTIN_VIEWS,
  DETACHABLE_VIEW_KEY_PATTERN,
  detachedWindowTitle,
  isDetachableViewKey,
  isInlineViewKey,
  parseInlineViewKey,
  parseViewKey,
  pluginViewKey,
  type BuiltinViewKey,
} from "../view-key.js";

describe("parseViewKey", () => {
  it("identifies every built-in destination", () => {
    for (const key of Object.keys(BUILTIN_VIEWS)) {
      expect(parseViewKey(key)).toEqual({ kind: "builtin", key });
    }
  });

  it("takes a plugin key apart into its two ids", () => {
    expect(parseViewKey("plugin:my-plugin:main-view")).toEqual({
      kind: "plugin",
      key: "plugin:my-plugin:main-view",
      pluginId: "my-plugin",
      viewId: "main-view",
    });
    expect(parseViewKey("plugin:my_plugin.v2:panel_a")).toMatchObject({
      pluginId: "my_plugin.v2",
      viewId: "panel_a",
    });
  });

  it("takes an MCP-app key apart into server hex and card id", () => {
    expect(parseViewKey("mcp-app:6162:card-1")).toEqual({
      kind: "mcp-app",
      key: "mcp-app:6162:card-1",
      serverIdHex: "6162",
      cardId: "card-1",
    });
  });

  it.each([
    ["", "empty"],
    ["hom", "a misspelled built-in"],
    ["HOME", "wrong case"],
    ["unknown-view", "an arbitrary word"],
    ["plugin:", "prefix only"],
    ["plugin:my-plugin", "one segment"],
    ["plugin::view", "an empty plugin id"],
    ["plugin:my-plugin:", "an empty view id"],
    ["plugin:a:b:c", "three segments"],
    ["mcp-app:zz:card", "a non-hex server id"],
    ["mcp-app:6162", "an MCP key with no card"],
    ["mcp-app:6162:", "an empty card id"],
    ["../etc/passwd", "a relative path"],
  ])("refuses %j (%s)", (raw) => {
    expect(parseViewKey(raw)).toBeNull();
  });

  it("accepts a UI extension id the manifest schema permits but the detach list does not", () => {
    // `ui[].id` is a bare `string` in schemas/plugin-manifest.schema.json, so
    // this key ships today and renders inline. Parsing must not be the place
    // that decides it is illegal — that would break a working plugin.
    const key = "plugin:my-plugin:MainView";
    expect(parseViewKey(key)).toMatchObject({ kind: "plugin", viewId: "MainView" });
    expect(isInlineViewKey(key)).toBe(true);
    // ...and it still cannot open a window, exactly as before this module.
    expect(isDetachableViewKey(key)).toBe(false);
  });

  it("builds plugin keys through the one constructor", () => {
    const key = pluginViewKey("git", "status");
    expect(key).toBe("plugin:git:status");
    expect(parseViewKey(key)).toMatchObject({ kind: "plugin", pluginId: "git", viewId: "status" });
  });
});

describe("inline vs detachable", () => {
  it("agrees with the table for every built-in", () => {
    for (const [key, spec] of Object.entries(BUILTIN_VIEWS)) {
      expect(isInlineViewKey(key)).toBe(spec.inline);
      expect(isDetachableViewKey(key)).toBe(spec.detachable);
    }
  });

  it("keeps home and settings out of the detach allow-list", () => {
    // They have no detached form; letting them through would open a window
    // that renders nothing.
    expect(isDetachableViewKey("home")).toBe(false);
    expect(isDetachableViewKey("settings")).toBe(false);
  });

  it("keeps a detach-only destination out of the inline space", () => {
    expect(isInlineViewKey("reminders")).toBe(false);
    expect(parseInlineViewKey("reminders")).toBeNull();
  });

  it("treats MCP-app cards as detach-only", () => {
    expect(isDetachableViewKey("mcp-app:6162:card-1")).toBe(true);
    expect(isInlineViewKey("mcp-app:6162:card-1")).toBe(false);
    expect(parseInlineViewKey("mcp-app:6162:card-1")).toBeNull();
  });

  it("treats plugin views as both", () => {
    expect(isInlineViewKey("plugin:git:status")).toBe(true);
    expect(isDetachableViewKey("plugin:git:status")).toBe(true);
  });

  it("rejects unparseable keys from both spaces", () => {
    for (const raw of ["", "hom", "plugin:git", "mcp-app:zz:card"]) {
      expect(isInlineViewKey(raw)).toBe(false);
      expect(isDetachableViewKey(raw)).toBe(false);
    }
  });

  it("keeps the detach allow-list no looser than it was", () => {
    // Structurally parseable, but never permitted to open a window. Pinning
    // this stops a future "simplification" from collapsing the two charsets
    // and quietly widening an IPC input check.
    for (const raw of ["plugin:../evil:view", "plugin:my-plugin:../evil", "plugin:-bad:view"]) {
      expect(parseViewKey(raw)).not.toBeNull();
      expect(isDetachableViewKey(raw)).toBe(false);
    }
  });
});

describe("DETACHABLE_VIEW_KEY_PATTERN", () => {
  it("matches isDetachableViewKey for every built-in — one authority, two forms", () => {
    // The pattern is what the main process validates the detach IPC against;
    // if it and the predicate disagree, one of them is lying about the table.
    for (const key of Object.keys(BUILTIN_VIEWS)) {
      expect(DETACHABLE_VIEW_KEY_PATTERN.test(key)).toBe(isDetachableViewKey(key));
    }
  });

  it("matches the namespaced forms and refuses malformed ones", () => {
    expect(DETACHABLE_VIEW_KEY_PATTERN.test("plugin:meeting:meeting-control")).toBe(true);
    expect(DETACHABLE_VIEW_KEY_PATTERN.test("mcp-app:6162:card-1")).toBe(true);
    expect(DETACHABLE_VIEW_KEY_PATTERN.test("plugin:meeting")).toBe(false);
    expect(DETACHABLE_VIEW_KEY_PATTERN.test("tasks")).toBe(false);
    expect(DETACHABLE_VIEW_KEY_PATTERN.test("")).toBe(false);
  });

  it("is anchored — a valid key with anything appended is not a match", () => {
    expect(DETACHABLE_VIEW_KEY_PATTERN.test("routines\nreminders")).toBe(false);
    expect(DETACHABLE_VIEW_KEY_PATTERN.test("xroutines")).toBe(false);
    expect(DETACHABLE_VIEW_KEY_PATTERN.test("routinesx")).toBe(false);
  });
});

describe("detachedWindowTitle", () => {
  it("gives every detachable built-in a title and no other key one", () => {
    for (const [key, spec] of Object.entries(BUILTIN_VIEWS)) {
      // A detached window with no title is a defect; a title on a surface that
      // never detaches is dead text.
      expect(detachedWindowTitle(key) === null).toBe(!spec.detachable);
    }
  });

  it("returns null for namespaced keys, whose titles come from their metadata", () => {
    expect(detachedWindowTitle("plugin:git:status")).toBeNull();
    expect(detachedWindowTitle("mcp-app:6162:card-1")).toBeNull();
  });

  it("returns null rather than throwing for an unparseable key", () => {
    expect(detachedWindowTitle("hom")).toBeNull();
  });
});

describe("the table itself", () => {
  it("gives a window title to exactly the detachable built-ins", () => {
    for (const key of Object.keys(BUILTIN_VIEWS) as BuiltinViewKey[]) {
      const spec: { detachable: boolean; windowTitle?: string } = BUILTIN_VIEWS[key];
      expect(Boolean(spec.windowTitle)).toBe(spec.detachable);
    }
  });

  it("has no destination that is neither inline nor detachable", () => {
    for (const [key, spec] of Object.entries(BUILTIN_VIEWS)) {
      expect(spec.inline || spec.detachable, `${key} is unreachable`).toBe(true);
    }
  });
});
