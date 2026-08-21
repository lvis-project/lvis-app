import { vi } from "vitest";
import type { BootContext } from "../../boot/context.js";

export interface SandboxBootHarness {
  /** The gate's audit sink, for asserting outcome and call ordering. */
  readonly logSandboxGate: ReturnType<typeof vi.fn>;
  /** The audit drain the abort paths must await before throwing. */
  readonly flush: ReturnType<typeof vi.fn>;
  /** A boot context whose only knob is the sandbox setting. */
  context(settingOn: boolean): BootContext;
}

/**
 * The minimal host `initSandboxGate` needs, with its audit spies.
 *
 * Both sandbox boot suites drive the same gate from the same two inputs (this
 * setting and `LVIS_SANDBOX_ENABLED`). A copy per suite is a second place for
 * the context to fall behind `BootContext`, after which the two suites are
 * testing subtly different hosts and neither one says so.
 *
 * Build it fresh per test — it owns the spies, so a shared instance would carry
 * one test's calls into the next.
 */
export function createSandboxBootHarness(): SandboxBootHarness {
  const logSandboxGate = vi.fn();
  const flush = vi.fn(async () => undefined);
  return {
    logSandboxGate,
    flush,
    context: (settingOn: boolean): BootContext =>
      ({
        settingsService: {
          get: vi.fn((key: string) =>
            key === "features"
              ? { osToolSandbox: settingOn, hostClassifiesRisk: false }
              : undefined,
          ),
        },
        bootAuditLogger: { logSandboxGate, flush },
        pluginRuntime: {
          listPluginIds: vi.fn(() => []),
          getPluginManifest: vi.fn(() => undefined),
        },
        buildSandboxUnionDomains: vi.fn(async () => []),
      }) as unknown as BootContext,
  };
}
