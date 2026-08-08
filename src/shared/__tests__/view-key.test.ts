/**
 * The view-key vocabulary.
 *
 * These tests exist because the key space used to be defined twice — a regex
 * in the main process, nothing at all in the renderer — and the renderer's
 * "nothing at all" meant an unrecognized string was rendered as a plugin view
 * rather than rejected. So the assertions here are mostly about what the
 * parser REFUSES.
 *
 * The table used to carry a `detachable` column and a per-built-in window title,
 * with a derived allow-list regex for the detach IPC. Detach is retired: every
 * destination renders inline, there is no second window to open, and the keys that
 * named one (`mcp-app:<hex>:<cardId>`) named a detached card instance. The cases
 * below therefore pin the surviving question — what a key IS — and, for the
 * namespaced forms, that a key naming a window is no longer a key at all.
 */
import { describe, expect, it } from "vitest";
import {
  BUILTIN_VIEWS,
  isInlineViewKey,
  parseInlineViewKey,
  parseViewKey,
  pluginViewKey,
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
    ["../etc/passwd", "a relative path"],
  ])("refuses %j (%s)", (raw) => {
    expect(parseViewKey(raw)).toBeNull();
  });

  it.each([
    ["mcp-app:6162:card-1", "a well-formed one"],
    ["mcp-app:zz:card", "a non-hex server id"],
    ["mcp-app:6162", "one with no card"],
    ["mcp-app:6162:", "an empty card id"],
  ])("refuses the retired detached-card key %j (%s)", (raw) => {
    // These named a card's instance in its own window. Nothing mints them and
    // nothing can render one, so the parser must not hand back a destination for a
    // place the app cannot go — every caller here treats a parsed key as somewhere
    // it may navigate.
    expect(parseViewKey(raw)).toBeNull();
    expect(isInlineViewKey(raw)).toBe(false);
    expect(parseInlineViewKey(raw)).toBeNull();
  });

  it("accepts a UI extension id the manifest schema permits", () => {
    // `ui[].id` is a bare `string` in schemas/plugin-manifest.schema.json, so
    // this key ships today and renders inline. Parsing must not be the place
    // that decides it is illegal — that would break a working plugin.
    const key = "plugin:my-plugin:MainView";
    expect(parseViewKey(key)).toMatchObject({ kind: "plugin", viewId: "MainView" });
    expect(isInlineViewKey(key)).toBe(true);
  });

  it("parses structurally odd plugin keys rather than refusing them", () => {
    // Structurally parseable and rendered inline. These used to be pinned as
    // "parseable but never allowed to open a window"; with no window to open, what
    // is left to pin is that parsing stayed STRUCTURAL and did not quietly acquire
    // the retired allow-list's stricter charset.
    for (const raw of ["plugin:../evil:view", "plugin:my-plugin:../evil", "plugin:-bad:view"]) {
      expect(parseViewKey(raw)).not.toBeNull();
      expect(isInlineViewKey(raw)).toBe(true);
    }
  });

  it("builds plugin keys through the one constructor", () => {
    const key = pluginViewKey("git", "status");
    expect(key).toBe("plugin:git:status");
    expect(parseViewKey(key)).toMatchObject({ kind: "plugin", pluginId: "git", viewId: "status" });
  });
});

describe("isInlineViewKey", () => {
  it("admits every built-in and every plugin view", () => {
    for (const key of Object.keys(BUILTIN_VIEWS)) {
      expect(isInlineViewKey(key)).toBe(true);
    }
    expect(isInlineViewKey("plugin:git:status")).toBe(true);
  });

  it("rejects unparseable keys", () => {
    for (const raw of ["", "hom", "plugin:git"]) {
      expect(isInlineViewKey(raw)).toBe(false);
    }
  });
});

describe("parseInlineViewKey", () => {
  it("returns the narrowed shape for the keys the main window can be at", () => {
    expect(parseInlineViewKey("home")).toEqual({ kind: "builtin", key: "home" });
    expect(parseInlineViewKey("plugin:git:status")).toMatchObject({
      kind: "plugin",
      pluginId: "git",
      viewId: "status",
    });
  });

  it("returns null for anything unparseable", () => {
    expect(parseInlineViewKey("hom")).toBeNull();
  });
});
