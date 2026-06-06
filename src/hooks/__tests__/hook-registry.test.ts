/**
 * Tests for the unified hook registry (#811 command-hooks milestone).
 *
 * Spec ref: docs/architecture/hook-runtime-expansion-design.md §4.1. Covers `.sh`
 * + config merge into one normalized list and event+matcher filtering (reusing
 * the `.sh` glob via hookMatchesTool).
 */
import { describe, expect, it } from "vitest";
import {
  buildHookRegistry,
  filterRegistryByEventAndTool,
  type HookRegistryEntry,
} from "../hook-registry.js";
import type { DiscoveredHook } from "../hook-discovery.js";
import type { HookConfigEntry } from "../hook-config.js";

function shHook(over: Partial<DiscoveredHook> & Pick<DiscoveredHook, "fileName" | "hookType">): DiscoveredHook {
  return {
    path: `/home/u/.config/lvis/hooks/${over.fileName}`,
    sha256: "deadbeef",
    size: 10,
    ...over,
  };
}

function configEntry(over: Partial<HookConfigEntry> & Pick<HookConfigEntry, "id" | "event">): HookConfigEntry {
  return {
    command: ["./hook.py"],
    timeoutMs: 5000,
    source: "config",
    ...over,
  };
}

describe("buildHookRegistry — normalization + merge", () => {
  it("normalizes a .sh DiscoveredHook into the unified shape", () => {
    const reg = buildHookRegistry(
      [shHook({ fileName: "pre-guard.sh", hookType: "pre", matcher: "bash" })],
      [],
    );
    expect(reg).toHaveLength(1);
    const e = reg[0];
    expect(e.source).toBe("sh");
    expect(e.event).toBe("pre");
    expect(e.matcher).toBe("bash");
    expect(e.command).toEqual(["/home/u/.config/lvis/hooks/pre-guard.sh"]);
    expect(e.id).toBe("sh:pre-guard.sh");
    if (e.source === "sh") {
      expect(e.discovered.sha256).toBe("deadbeef");
    }
  });

  it("a .sh hook with no matcher normalizes with undefined matcher", () => {
    const reg = buildHookRegistry([shHook({ fileName: "post-x.sh", hookType: "post" })], []);
    expect(reg[0].matcher).toBeUndefined();
  });

  it("carries a config entry through with its timeout", () => {
    const reg = buildHookRegistry(
      [],
      [configEntry({ id: "PreToolUse#0.0", event: "pre", matcher: "mcp__*", timeoutMs: 1234 })],
    );
    expect(reg).toHaveLength(1);
    const e = reg[0];
    expect(e.source).toBe("config");
    expect(e.event).toBe("pre");
    expect(e.matcher).toBe("mcp__*");
    expect(e.id).toBe("config:PreToolUse#0.0");
    if (e.source === "config") {
      expect(e.timeoutMs).toBe(1234);
    }
  });

  it("merges .sh (first) then config (after), preserving order", () => {
    const reg = buildHookRegistry(
      [
        shHook({ fileName: "pre-a.sh", hookType: "pre" }),
        shHook({ fileName: "pre-b.sh", hookType: "pre" }),
      ],
      [
        configEntry({ id: "PreToolUse#0.0", event: "pre" }),
        configEntry({ id: "PreToolUse#0.1", event: "pre" }),
      ],
    );
    expect(reg.map((e) => e.source)).toEqual(["sh", "sh", "config", "config"]);
    expect(reg.map((e) => e.id)).toEqual([
      "sh:pre-a.sh",
      "sh:pre-b.sh",
      "config:PreToolUse#0.0",
      "config:PreToolUse#0.1",
    ]);
  });

  it("does not mutate its inputs", () => {
    const sh = [shHook({ fileName: "pre-a.sh", hookType: "pre" })];
    const cfg = [configEntry({ id: "x", event: "pre" })];
    buildHookRegistry(sh, cfg);
    expect(sh).toHaveLength(1);
    expect(cfg).toHaveLength(1);
  });
});

describe("filterRegistryByEventAndTool — event + matcher (decision a)", () => {
  const registry: HookRegistryEntry[] = buildHookRegistry(
    [
      shHook({ fileName: "pre-all.sh", hookType: "pre" }), // no matcher → all tools
      shHook({ fileName: "pre-mcp.sh", hookType: "pre", matcher: "mcp__*" }),
      shHook({ fileName: "post-all.sh", hookType: "post" }),
    ],
    [
      configEntry({ id: "PreToolUse#0.0", event: "pre", matcher: "bash" }),
      configEntry({ id: "PermissionRequest#0.0", event: "perm", matcher: "mcp__hr_*" }),
    ],
  );

  it("filters by event", () => {
    const post = filterRegistryByEventAndTool(registry, "post", "bash");
    expect(post.map((e) => e.id)).toEqual(["sh:post-all.sh"]);
  });

  it("an entry with no matcher applies to every tool", () => {
    const r = filterRegistryByEventAndTool(registry, "pre", "some_random_tool");
    expect(r.map((e) => e.id)).toEqual(["sh:pre-all.sh"]);
  });

  it("glob matcher matches across both .sh and config origins", () => {
    const r = filterRegistryByEventAndTool(registry, "pre", "mcp__hr_list");
    // pre-all (no matcher) + pre-mcp (mcp__*) match; the bash config entry does not.
    expect(r.map((e) => e.id)).toEqual(["sh:pre-all.sh", "sh:pre-mcp.sh"]);
  });

  it("exact-glob matcher matches the named tool", () => {
    const r = filterRegistryByEventAndTool(registry, "pre", "bash");
    expect(r.map((e) => e.id)).toEqual(["sh:pre-all.sh", "config:PreToolUse#0.0"]);
  });

  it("perm event matcher is honored independently", () => {
    expect(filterRegistryByEventAndTool(registry, "perm", "mcp__hr_get").map((e) => e.id)).toEqual([
      "config:PermissionRequest#0.0",
    ]);
    expect(filterRegistryByEventAndTool(registry, "perm", "mcp__sales_get")).toEqual([]);
  });
});
