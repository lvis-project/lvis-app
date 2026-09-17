import { lstatSync } from "node:fs";
import { join } from "node:path";

export const HEADLESS_PACKAGED_MARKER_NAME = ".lvis-headless-packaged-v1";

export function headlessPackagedMarkerPath(projectRoot) {
  return join(projectRoot, HEADLESS_PACKAGED_MARKER_NAME);
}

/**
 * Missing is the source/development identity. Any present marker must be the
 * exact zero-byte regular file emitted by the native runtime packager.
 */
export function readHeadlessPackagedMarker(projectRoot, inspect = lstatSync) {
  const markerPath = headlessPackagedMarkerPath(projectRoot);
  let marker;
  try {
    marker = inspect(markerPath, { throwIfNoEntry: false });
  } catch (error) {
    throw new Error(`Packaged runtime marker inspection failed: ${markerPath}`, { cause: error });
  }
  if (marker === undefined) return false;
  if (!marker.isFile() || marker.size !== 0) {
    throw new Error(`Packaged runtime marker is invalid: ${markerPath}`);
  }
  return true;
}
