/** Select the native command before loading or launching the desktop runtime. */
export function headlessLaunchArgs(args) {
  const nativeCommand = args.some((arg) =>
    arg === "--exec" || arg.startsWith("--exec=") ||
    arg === "--set-secret" || arg.startsWith("--set-secret=") ||
    arg === "--serve" || arg === "--runtime-check");
  if (!nativeCommand) return null;
  // The desktop wrapper accepts its main module as the first positional arg.
  return args.filter((arg, index) => !(index === 0 && !arg.startsWith("--")));
}
