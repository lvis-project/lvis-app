import { isPackagedForbiddenEnvVar } from "../boot/dev-flags.js";

export function shouldScrubPackagedEnvKey(key: string): boolean {
  return isPackagedForbiddenEnvVar(key) || key.startsWith("LVIS_DEMO");
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
