import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export function loadRepoDemoEnv(env, repoRoot) {
  const dotEnvDemoPath = resolve(repoRoot, ".env.demo");
  if (!existsSync(dotEnvDemoPath)) {
    return { loaded: false, path: dotEnvDemoPath, applied: 0 };
  }

  let applied = 0;
  const lines = readFileSync(dotEnvDemoPath, "utf8").split("\n");
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const stripped = line.replace(/^export\s+/, "");
    const eq = stripped.indexOf("=");
    if (eq < 1) continue;
    const key = stripped.slice(0, eq).trim();
    let val = stripped.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (!(key in env)) {
      env[key] = val;
      applied += 1;
    }
  }

  return { loaded: true, path: dotEnvDemoPath, applied };
}
