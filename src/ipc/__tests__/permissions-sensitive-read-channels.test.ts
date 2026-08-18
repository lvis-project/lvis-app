/**
 * Six permission-domain channels are READ-ONLY but not low-risk, and read-only
 * is what previously earned them the base sender validator — which admits
 * plugin UI shell frames by design.
 *
 * Reading the approval queue tells a plugin what the user is about to be asked
 * to approve, which is reconnaissance for timing a request against it, not a
 * read. The same holds for the audit log, the audit chain's integrity state,
 * the hook trust list, and which providers hold a key.
 *
 * `deferredList`'s own comment claimed it was "gated to prevent a compromised
 * foreign frame from harvesting them" while calling the validator that does not
 * reject those frames.
 *
 * These invoke the registered handlers with a plugin-shell sender, because the
 * defect was a handler calling the wrong guard and the whole existing suite
 * stayed green while it did — nothing observed which guard ran.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IpcMainInvokeEvent } from "electron";

const handleMap = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>();

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn((channel: string, fn: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown) => {
      handleMap.set(channel, fn);
    }),
  },
  BrowserWindow: { getAllWindows: () => [], fromWebContents: () => null },
}));

const { registerPermissionsHandlers } = await import("../domains/permissions.js");
const { PERMISSIONS } = await import("../../shared/ipc-channels.js");

const PLUGIN_SHELL = "file:///dist/src/plugin-ui-shell.html";
const HOST_RENDERER = "file:///dist/src/index.html";

function ev(url: string): IpcMainInvokeEvent {
  return { senderFrame: { url } } as unknown as IpcMainInvokeEvent;
}

/**
 * Read-only, and each discloses something a plugin can act on. `args` are the
 * minimum a handler needs to reach its guard — the guard runs first, so these
 * never have to be valid beyond that.
 */
const SENSITIVE_READ_CHANNELS: ReadonlyArray<readonly [string, string, unknown[]]> = [
  ["deferredList", PERMISSIONS.deferredList, []],
  ["userApprovalList", PERMISSIONS.userApprovalList, []],
  ["auditShow", PERMISSIONS.auditShow, [10]],
  ["auditVerify", PERMISSIONS.auditVerify, []],
  ["hookTrustList", PERMISSIONS.hookTrustList, []],
  ["reviewerProviderHasKey", PERMISSIONS.reviewerProviderHasKey, ["openai"]],
];

beforeEach(() => {
  handleMap.clear();
  // Enough of each dependency for a handler to run to completion once its
  // guard has passed. The guard runs first, so the refusal cases never reach
  // any of this — it exists so the host-renderer cases can prove they got
  // PAST the guard rather than merely not saying "unauthorized-frame".
  const auditLogger = {
    log: vi.fn(),
    logWarn: vi.fn(),
    flush: vi.fn(async () => undefined),
    getAuditDir: vi.fn(() => "/nonexistent-audit-dir"),
    getPermissionAuditSecret: vi.fn(() => null),
  };
  registerPermissionsHandlers({
    conversationLoop: { permissionManager: undefined },
    approvalGate: undefined,
    auditLogger,
    settingsService: {
      get: vi.fn(() => undefined),
      set: vi.fn(),
      getSecret: vi.fn(() => null),
    },
  } as never);
});

describe("sensitive read-only permission channels", () => {
  it.each(SENSITIVE_READ_CHANNELS)(
    "%s refuses a plugin shell frame",
    async (_name, channel, args) => {
      const handler = handleMap.get(channel);
      expect(handler, `${channel} was never registered`).toBeDefined();
      const result = await handler!(ev(PLUGIN_SHELL), ...args);
      expect(result).toMatchObject({ ok: false, error: "unauthorized-frame" });
    },
  );

  it.each(SENSITIVE_READ_CHANNELS)(
    "%s does not refuse the host renderer",
    async (_name, channel, args) => {
      // The guard must reject the shell WITHOUT rejecting the surface that
      // legitimately uses it — a test that only pinned the refusal would pass
      // just as well if the channel refused everyone.
      const handler = handleMap.get(channel);
      const result = await handler!(ev(HOST_RENDERER), ...args);
      expect(result).not.toMatchObject({ error: "unauthorized-frame" });
    },
  );
});
