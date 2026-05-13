import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let cachedIconPath: string | null | undefined;

export function resolveAppIconPath(): string | undefined {
  if (cachedIconPath !== undefined) {
    return cachedIconPath ?? undefined;
  }

  const candidates = [
    process.resourcesPath ? join(process.resourcesPath, "icon.png") : null,
    resolve(__dirname, "..", "..", "build", "icon.png"),
    resolve(__dirname, "..", "..", "..", "build", "icon.png"),
    resolve(process.cwd(), "build", "icon.png"),
  ].filter((candidate): candidate is string => Boolean(candidate));

  cachedIconPath = candidates.find((candidate) => existsSync(candidate)) ?? null;
  return cachedIconPath ?? undefined;
}
