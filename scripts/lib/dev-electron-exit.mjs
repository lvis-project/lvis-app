export const DEMO_ACTIVATION_DEV_RELAUNCH_EXIT_CODE = 42;

export function classifyElectronExit({ code, signal, shuttingDown, restartInFlight }) {
  if (shuttingDown || restartInFlight) return "ignore";
  if (
    code === DEMO_ACTIVATION_DEV_RELAUNCH_EXIT_CODE &&
    (signal === null || signal === undefined)
  ) {
    return "restart";
  }
  if (signal !== "SIGTERM" && signal !== "SIGKILL") return "shutdown";
  return "ignore";
}
