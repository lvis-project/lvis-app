import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseEnvDemoText } from "./env-demo-parser.mjs";

export function loadRepoDemoEnv(env, repoRoot) {
  const dotEnvDemoPath = resolve(repoRoot, ".env.demo");
  if (!existsSync(dotEnvDemoPath)) {
    return { loaded: false, path: dotEnvDemoPath, applied: 0 };
  }

  let applied = 0;
  const parsed = parseEnvDemoText(readFileSync(dotEnvDemoPath, "utf8"));
  for (const [key, val] of Object.entries(parsed)) {
    if (!(key in env)) {
      env[key] = val;
      applied += 1;
    }
  }

  return { loaded: true, path: dotEnvDemoPath, applied };
}
