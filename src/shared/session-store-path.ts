import { join } from "node:path";
import { lvisHome } from "./lvis-home.js";

/** Primary session storage follows the configured application data root. */
export function sessionStorePath(applicationRoot: string = lvisHome()): string {
  return join(applicationRoot, "sessions");
}
