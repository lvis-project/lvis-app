// Single source of truth for Chromium / Electron command-line flag *strings*
// shared between the dev / production launchers (scripts/run-electron*.mjs)
// and the main process's lvis:// protocol registration (src/main.ts).
//
// Putting this in plain ESM means the launchers can import it directly at
// startup (before any TypeScript compile step) and the bundled main process
// can import it via a relative path that survives the dist/ layout.
//
// Each consumer applies its own gating policy because the policies legitimately
// differ:
//   - Dev/prod launchers always inject --no-sandbox on Windows (their corp-VDI
//     reliability bar) modulo LVIS_KEEP_GPU.
//   - main.ts only re-injects --no-sandbox into the protocol-registered command
//     when LVIS_DEV_NO_SANDBOX=1 is set, so a packaged build that hasn't asked
//     for the bypass keeps Chromium's sandbox.
//
// Keep this module dependency-free.

/**
 * Windows-safe Chromium GPU flags. Corp/VDI machines with restricted GPU
 * drivers crash the GPU process before the window appears (`GPU process
 * isn't usable. Goodbye!`); these flags route around it. Opt-out via
 * `LVIS_KEEP_GPU=1` for developers running on a machine with working GPU.
 */
export const WINDOWS_SAFE_GPU_FLAGS = Object.freeze([
  "--disable-gpu",
  "--disable-software-rasterizer",
  "--disable-gpu-compositing",
]);

/**
 * Chromium sandbox bypass. Required on corp/VDI boxes whose sandbox init
 * fails (silent crash on launch). The launchers always inject this on
 * Windows; main.ts re-injects it only behind LVIS_DEV_NO_SANDBOX=1 so a
 * packaged build that never set the env var preserves Chromium's default
 * protection.
 */
export const SANDBOX_BYPASS_FLAG = "--no-sandbox";
