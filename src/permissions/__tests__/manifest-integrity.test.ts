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
  it("recordViolation marks a plugin disabled", async () => {
    const state = new ManifestIntegrityState();
    expect(state.isDisabled("p")).toBe(false);
    await state.recordViolation("p", "t", "writeFileSync");
    expect(state.isDisabled("p")).toBe(true);
    expect(state.listDisabled()).toEqual(["p"]);
  });

  it("recordViolation is idempotent", async () => {
    const state = new ManifestIntegrityState();
    await state.recordViolation("p", "t", "writeFileSync");
    await state.recordViolation("p", "t", "writeFileSync");
    expect(state.listDisabled()).toEqual(["p"]);
  });

  it("onViolation listeners fire", async () => {
    const state = new ManifestIntegrityState();
    const fn = vi.fn();
    const dispose = state.onViolation(fn);
    await state.recordViolation("p", "t", "rmSync");
    expect(fn).toHaveBeenCalledWith("p", "t", "rmSync");
    dispose();
    await state.recordViolation("p2", "t2", "writeFileSync");
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe("Permission policy P4 bindManifestIntegrityAudit", () => {
  it("fails closed when the permission audit chain is not ready", async () => {
    const state = new ManifestIntegrityState();
    const audit = {
      log: vi.fn(),
      isPermissionAuditChainReady: vi.fn(() => false),
      appendPermissionAuditEntry: vi.fn(async () => {
        throw new Error("permission audit chain not initialized");
      }),
    } as unknown as import("../../audit/audit-logger.js").AuditLogger;
    bindManifestIntegrityAudit(audit, state);
    await expect(state.recordViolation("p", "tool_x", "writeFileSync")).rejects.toThrow(
      "permission audit chain not initialized",
    );
    expect(audit.log).toHaveBeenCalledOnce();
    const entry = (audit.log as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(entry.type).toBe("error");
    expect(entry.input).toContain("manifest_integrity_violation");
    expect(entry.input).toContain("tool_x");
    expect(audit.appendPermissionAuditEntry).toHaveBeenCalledOnce();
  });

  it("appends manifest_violation to the permission audit chain when ready", async () => {
    const state = new ManifestIntegrityState();
    const appendPermissionAuditEntry = vi.fn(async (entry: Record<string, unknown>) => ({
      ...entry,
      prevHash: "h",
    }));
    const audit = {
      log: vi.fn(),
      isPermissionAuditChainReady: vi.fn(() => true),
      appendPermissionAuditEntry,
    } as unknown as import("../../audit/audit-logger.js").AuditLogger;

    bindManifestIntegrityAudit(audit, state);
    await state.recordViolation("p", "tool_x", "writeFileSync");
    expect(appendPermissionAuditEntry).toHaveBeenCalledOnce();
    expect(appendPermissionAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        decision: "manifest_violation",
        pluginId: "p",
        toolName: "tool_x",
        attemptedOperation: "writeFileSync",
        trustOrigin: "plugin-emitted",
      }),
    );
  });

  it("surfaces permission audit append failures to the violation caller", async () => {
    const state = new ManifestIntegrityState();
    const audit = {
      log: vi.fn(),
      isPermissionAuditChainReady: vi.fn(() => true),
      appendPermissionAuditEntry: vi.fn(async () => {
        throw new Error("append failed");
      }),
    } as unknown as import("../../audit/audit-logger.js").AuditLogger;

    bindManifestIntegrityAudit(audit, state);

    await expect(state.recordViolation("p", "tool_x", "writeFileSync")).rejects.toThrow("append failed");
    expect(state.isDisabled("p")).toBe(true);
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
