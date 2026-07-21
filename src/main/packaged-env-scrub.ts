import { isPackagedForbiddenEnvVar } from "../boot/dev-flags.js";

export function shouldScrubPackagedEnvKey(key: string): boolean {
  // The demo runtime is retired, but older launch environments can still
  // carry its credential and private-topology variables into child processes.
  // Keep this namespace as a one-way scrub tombstone.
  return isPackagedForbiddenEnvVar(key) || key.startsWith("LVIS_DEMO_");
}

export function scrubPackagedProcessEnv(env: NodeJS.ProcessEnv): string[] {
  const scrubbed: string[] = [];
  for (const key of Object.keys(env)) {
    if (!shouldScrubPackagedEnvKey(key)) continue;
    delete env[key];
    scrubbed.push(key);
  }
  return scrubbed;
}
