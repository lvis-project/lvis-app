/**
 * Permission policy P4 Area C — manifest integrity proxy tests.
 *
 * Spec ref: docs/architecture/permission-policy-design.md §3.5.
 */
import { describe, expect, it, beforeEach, vi } from "vitest";
import * as nodeFs from "node:fs";
import {
  ManifestIntegrityViolation,
  ManifestIntegrityState,
  bindManifestIntegrityAudit,
  createReadOnlyFsProxy,
  createReadOnlyFsPromisesProxy,
  manifestIntegrityState,
  READ_ONLY_FS_DENY_METHODS,
} from "../manifest-integrity.js";

beforeEach(() => {
  manifestIntegrityState.resetForTests();
});

describe("Permission policy P4 createReadOnlyFsProxy", () => {
  it("passes through read methods", () => {
    const proxy = createReadOnlyFsProxy(nodeFs as unknown as Record<string, unknown>, {
      pluginId: "p",
      toolName: "t",
    });
    expect(typeof (proxy as { readFileSync: unknown }).readFileSync).toBe("function");
    expect(typeof (proxy as { readdirSync: unknown }).readdirSync).toBe("function");
  });

  it("throws ManifestIntegrityViolation on writeFileSync", () => {
    const proxy = createReadOnlyFsProxy(nodeFs as unknown as Record<string, unknown>, {
      pluginId: "rogue-plugin",
      toolName: "rogue-tool",
    });
    const writeFn = (proxy as { writeFileSync: (...args: unknown[]) => void }).writeFileSync;
    expect(() => writeFn("/tmp/x", "data")).toThrow(ManifestIntegrityViolation);
    try {
      writeFn("/tmp/x", "data");
    } catch (err) {
      expect((err as ManifestIntegrityViolation).code).toBe("MANIFEST_INTEGRITY_VIOLATION");
      expect((err as ManifestIntegrityViolation).pluginId).toBe("rogue-plugin");
      expect((err as ManifestIntegrityViolation).toolName).toBe("rogue-tool");
      expect((err as ManifestIntegrityViolation).attemptedMethod).toBe("writeFileSync");
    }
  });

  it("throws on every deny-list write method", () => {
    const proxy = createReadOnlyFsProxy(nodeFs as unknown as Record<string, unknown>, {
      pluginId: "p",
      toolName: "t",
    });
    const sample = ["unlinkSync", "mkdirSync", "rmSync", "renameSync", "chmodSync", "createWriteStream"];
    for (const method of sample) {
      const fn = (proxy as Record<string, unknown>)[method];
      expect(typeof fn).toBe("function");
      expect(() => (fn as () => void)()).toThrow(ManifestIntegrityViolation);
    }
  });

  it("captured property reference still throws when invoked later", () => {
    const proxy = createReadOnlyFsProxy(nodeFs as unknown as Record<string, unknown>, {
      pluginId: "p",
      toolName: "t",
    });
    const captured = (proxy as { writeFileSync: () => void }).writeFileSync;
    expect(() => captured()).toThrow(ManifestIntegrityViolation);
  });
});

describe("Permission policy P4 createReadOnlyFsPromisesProxy", () => {
  it("passes through read methods (e.g. readFile)", () => {
    const proxy = createReadOnlyFsPromisesProxy({ readFile: () => "ok" } as Record<string, unknown>, {
      pluginId: "p",
      toolName: "t",
    });
    expect(typeof (proxy as { readFile: unknown }).readFile).toBe("function");
  });

  it("rejects async-thrown when calling writeFile", async () => {
    const proxy = createReadOnlyFsPromisesProxy({} as Record<string, unknown>, {
      pluginId: "rogue",
      toolName: "t1",
    });
    const writeFn = (proxy as { writeFile: () => Promise<void> }).writeFile;
    await expect(writeFn()).rejects.toThrow(ManifestIntegrityViolation);
  });
});

describe("Permission policy P4 ManifestIntegrityState", () => {
  it("recordViolation marks a plugin disabled", () => {
    const state = new ManifestIntegrityState();
    expect(state.isDisabled("p")).toBe(false);
    state.recordViolation("p", "t", "writeFileSync");
    expect(state.isDisabled("p")).toBe(true);
    expect(state.listDisabled()).toEqual(["p"]);
  });

  it("recordViolation is idempotent", () => {
    const state = new ManifestIntegrityState();
    state.recordViolation("p", "t", "writeFileSync");
    state.recordViolation("p", "t", "writeFileSync");
    expect(state.listDisabled()).toEqual(["p"]);
  });

  it("onViolation listeners fire", () => {
    const state = new ManifestIntegrityState();
    const fn = vi.fn();
    const dispose = state.onViolation(fn);
    state.recordViolation("p", "t", "rmSync");
    expect(fn).toHaveBeenCalledWith("p", "t", "rmSync");
    dispose();
    state.recordViolation("p2", "t2", "writeFileSync");
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe("Permission policy P4 bindManifestIntegrityAudit", () => {
  it("writes an audit entry per violation", () => {
    const state = new ManifestIntegrityState();
    const audit = { log: vi.fn() } as unknown as import("../../audit/audit-logger.js").AuditLogger;
    bindManifestIntegrityAudit(audit, state);
    state.recordViolation("p", "tool_x", "writeFileSync");
    expect(audit.log).toHaveBeenCalledOnce();
    const entry = (audit.log as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(entry.type).toBe("error");
    expect(entry.input).toContain("manifest_integrity_violation");
    expect(entry.input).toContain("tool_x");
  });
});

describe("Permission policy P4 deny-list completeness", () => {
  it("includes all sync write entry points", () => {
    expect(READ_ONLY_FS_DENY_METHODS.has("writeFileSync")).toBe(true);
    expect(READ_ONLY_FS_DENY_METHODS.has("appendFileSync")).toBe(true);
    expect(READ_ONLY_FS_DENY_METHODS.has("mkdirSync")).toBe(true);
    expect(READ_ONLY_FS_DENY_METHODS.has("rmSync")).toBe(true);
    expect(READ_ONLY_FS_DENY_METHODS.has("unlinkSync")).toBe(true);
    expect(READ_ONLY_FS_DENY_METHODS.has("renameSync")).toBe(true);
    expect(READ_ONLY_FS_DENY_METHODS.has("createWriteStream")).toBe(true);
  });

  it("does NOT include read methods (positive control)", () => {
    expect(READ_ONLY_FS_DENY_METHODS.has("readFileSync")).toBe(false);
    expect(READ_ONLY_FS_DENY_METHODS.has("readdirSync")).toBe(false);
    expect(READ_ONLY_FS_DENY_METHODS.has("statSync")).toBe(false);
  });
});
