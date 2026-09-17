import { setIsPackaged } from "../boot/dev-flags.js";
import { readHeadlessPackagedMarker } from "../../scripts/lib/headless-packaged-marker.mjs";
import { scrubPackagedProcessEnv } from "./packaged-env-scrub.js";

/** Establish the native host identity before importing any host implementation. */
export function configureHeadlessRuntimeIdentity(
  projectRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const packaged = readHeadlessPackagedMarker(projectRoot);
  if (packaged) {
    scrubPackagedProcessEnv(env);
    delete env.VITEST;
    env.NODE_ENV = "production";
  }
  setIsPackaged(packaged);
  return packaged;
}
