import { existsSync } from "node:fs";
import { join } from "node:path";
import { projectRoot } from "./main-paths.js";

let cachedIconPath: string | null | undefined;

export interface AppIconPathOptions {
  resourcesPath?: string;
  projectRoot?: string;
  cwd?: string;
  exists?: (path: string) => boolean;
}

export function resolveAppIconPath(options: AppIconPathOptions = {}): string | undefined {
  const useCache = Object.keys(options).length === 0;
  if (useCache && cachedIconPath !== undefined) {
    return cachedIconPath ?? undefined;
  }

  const resourcesPath = options.resourcesPath ?? process.resourcesPath;
  const devProjectRoot = options.projectRoot ?? projectRoot;
  const cwd = options.cwd ?? process.cwd();
  const exists = options.exists ?? existsSync;
  const candidates = [
    resourcesPath ? join(resourcesPath, "icon.png") : null,
    join(devProjectRoot, "build", "icon.png"),
    join(cwd, "build", "icon.png"),
  ].filter((candidate): candidate is string => Boolean(candidate));

  const iconPath = candidates.find((candidate) => exists(candidate)) ?? null;
  if (useCache) cachedIconPath = iconPath;
  return iconPath ?? undefined;
}
