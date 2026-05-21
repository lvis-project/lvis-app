export const DEMO_ACTIVATION_DEV_RELAUNCH_EXIT_CODE: number;

export function classifyElectronExit(input: {
  code: number | null;
  signal: NodeJS.Signals | string | null;
  shuttingDown: boolean;
  restartInFlight: boolean;
}): "ignore" | "restart" | "shutdown";
