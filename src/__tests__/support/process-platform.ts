/**
 * Shared test helper: override `process.platform` within a test.
 *
 * Several platform-branching units (Windows srt-win consent IPC, pwsh
 * resolution, worker spawn, MCP stdio sandbox wrapping) need to force
 * `process.platform` to exercise the win32 / darwin / linux paths from any
 * host. This is the single definition of that override; the duplicate gate
 * flags any test that re-declares the body instead of importing it.
 */
export function setProcessPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
}
