import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

type NativeImageModule = typeof import("electron").nativeImage;
type NativeImage = ReturnType<NativeImageModule["createFromPath"]>;

interface TrayIconPathOptions {
  platform?: NodeJS.Platform;
  resourcesPath?: string;
  cwd?: string;
  moduleDir?: string;
  exists?: (path: string) => boolean;
}

interface TrayIconOptions extends TrayIconPathOptions {
  nativeImage: NativeImageModule;
}

function trayIconFileName(platform: NodeJS.Platform): string {
  return platform === "darwin" ? "tray-iconTemplate.png" : "tray-icon.png";
}

export function resolveTrayIconPath(options: TrayIconPathOptions = {}): string {
  const platform = options.platform ?? process.platform;
  const resourcesPath = options.resourcesPath ?? process.resourcesPath;
  const cwd = options.cwd ?? process.cwd();
  const moduleDir = options.moduleDir ?? __dirname;
  const exists = options.exists ?? existsSync;
  const fileName = trayIconFileName(platform);

  const candidates = [
    resourcesPath ? join(resourcesPath, fileName) : null,
    resolve(moduleDir, "..", "..", "build", fileName),
    resolve(moduleDir, "..", "..", "..", "build", fileName),
    resolve(cwd, "build", fileName),
  ].filter((candidate): candidate is string => Boolean(candidate));

  const iconPath = candidates.find((candidate) => exists(candidate));
  if (!iconPath) {
    throw new Error(`LVIS tray icon asset missing: ${fileName}. Run bun run build:icons before launching.`);
  }
  return iconPath;
}

export function createLvisTrayIcon(options: TrayIconOptions): NativeImage {
  const platform = options.platform ?? process.platform;
  const icon = options.nativeImage.createFromPath(resolveTrayIconPath(options));
  if (icon.isEmpty()) {
    throw new Error("LVIS tray icon asset decoded to an empty image.");
  }
  if (platform === "darwin") {
    icon.setTemplateImage(true);
  }
  return icon;
}
