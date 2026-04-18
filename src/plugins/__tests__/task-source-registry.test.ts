import { describe, it, expect } from "vitest";
import { TaskSourceRegistry, deriveCategoryId } from "../task-source-registry.js";

describe("TaskSourceRegistry", () => {
  it("seeds legacy categories on construction", () => {
    const reg = new TaskSourceRegistry();
    for (const id of ["email", "meeting", "calendar", "teams", "manual"]) {
      expect(reg.has(id)).toBe(true);
    }
  });

  it("host-default entries have correct origin", () => {
    const reg = new TaskSourceRegistry();
    expect(reg.get("manual")?.origin).toBe("host-default");
    expect(reg.get("host")?.origin).toBe("host-default");
  });

  it("registers a new plugin category", () => {
    const reg = new TaskSourceRegistry();
    reg.register({ id: "my-plugin", origin: "plugin", pluginId: "com.example.my-plugin", label: "My Plugin" });
    const entry = reg.get("my-plugin");
    expect(entry?.origin).toBe("plugin");
    expect(entry?.label).toBe("My Plugin");
  });

  it("plugin can enrich legacy seed with label", () => {
    const reg = new TaskSourceRegistry();
    reg.register({ id: "email", origin: "plugin", pluginId: "com.lge.email", label: "이메일" });
    expect(reg.get("email")?.label).toBe("이메일");
  });

  it("does not overwrite host-default with plugin registration", () => {
    const reg = new TaskSourceRegistry();
    reg.register({ id: "manual", origin: "plugin", pluginId: "com.bad.plugin" });
    expect(reg.get("manual")?.origin).toBe("host-default");
  });

  it("list() returns all entries", () => {
    const reg = new TaskSourceRegistry();
    const ids = reg.list().map((e) => e.id);
    expect(ids).toContain("manual");
    expect(ids).toContain("email");
  });
});

describe("deriveCategoryId", () => {
  it("uses explicit source when provided", () => {
    expect(deriveCategoryId("com.lge.email", "email-task")).toBe("email-task");
  });

  it("derives from last dotted segment of pluginId", () => {
    expect(deriveCategoryId("com.lge.meeting-recorder", undefined)).toBe("meeting-recorder");
  });

  it("returns pluginId as-is when no dots", () => {
    expect(deriveCategoryId("myplugin", undefined)).toBe("myplugin");
  });

  it("trims whitespace from explicit source", () => {
    expect(deriveCategoryId("com.lge.email", "  email  ")).toBe("email");
  });

  it("ignores empty string explicit source", () => {
    expect(deriveCategoryId("com.lge.email", "")).toBe("email");
  });

  it("does not throw when explicitSource is an object (falls back to pluginId)", () => {
    // A buggy plugin might pass `source: { x: 1 }` — the previous
    // `explicitSource && explicitSource.trim()` would throw on this.
    expect(() =>
      deriveCategoryId("com.lge.email", { x: 1 } as unknown as string),
    ).not.toThrow();
    expect(deriveCategoryId("com.lge.email", { x: 1 } as unknown as string)).toBe("email");
  });

  it("does not throw when explicitSource is a number (falls back to pluginId)", () => {
    expect(() =>
      deriveCategoryId("com.lge.email", 42 as unknown as string),
    ).not.toThrow();
    expect(deriveCategoryId("com.lge.email", 42 as unknown as string)).toBe("email");
  });

  it("ignores null explicitSource", () => {
    expect(deriveCategoryId("com.lge.email", null as unknown as string)).toBe("email");
  });
});
