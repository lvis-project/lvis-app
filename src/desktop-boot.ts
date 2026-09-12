import { acquireHostInstanceLock } from "./main/host-instance-lock.js";
import type { BrowserWindow } from "electron";
import { bootstrap as bootstrapHost, type BootLaunch } from "./boot.js";
import { createDesktopBootHost } from "./boot/desktop-host-runtime.js";

export async function bootstrap(
  projectRoot: string,
  mainWindow: BrowserWindow | null,
  getMainWindow: () => BrowserWindow | null,
  launch: BootLaunch,
) {
  await acquireHostInstanceLock();
  const host = createDesktopBootHost(projectRoot);
  return bootstrapHost(projectRoot, mainWindow, getMainWindow, launch, host);
}
