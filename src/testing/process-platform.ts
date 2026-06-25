/**
 * Shared test helper: override `process.platform` within a test.
 *
 * Several platform-branching units (Windows srt-win consent IPC, pwsh
 * resolution, …) need to force `process.platform` to exercise the win32 /
 * darwin / linux paths from any host. Extracted here so the override body is
 * defined ONCE — the test-duplicate quality gate flags identical helper bodies
 * copied across test files, and this is the single source for them.
 *
 * Lives outside any `__tests__/` path so it is itself excluded from the gate's
 * scan; the two consumers import it instead of re-declaring it.
 */
export function setProcessPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
}
