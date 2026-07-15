import { lstatSync } from "node:fs";
import { win32 } from "node:path";

export const LVIS_NSIS_PER_MACHINE_MARKER_FILENAME =
  ".lvis-nsis-per-machine-v1";

export type PackagedWindowsProtocolMarkerState =
  | "present"
  | "absent"
  | "unknown";

export type LstatSync = typeof lstatSync;

function normalizeLocalDriveWindowsPath(value: unknown): string | null {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    value.includes("\0") ||
    value.startsWith("\\\\")
  ) {
    return null;
  }

  if (!win32.isAbsolute(value)) {
    return null;
  }

  const normalized = win32.normalize(value);
  if (!/^[a-z]:\\$/i.test(win32.parse(normalized).root)) {
    return null;
  }

  return normalized;
}

/**
 * A per-machine NSIS install places a versioned regular-file marker beside
 * the executable. Electron's Windows protocol setter always writes HKCU, so
 * that marker is the only reason to skip it. ZIP/win-unpacked builds have no
 * marker and keep Electron's normal self-registration behavior.
 *
 * Validate the executable path lexically before touching the filesystem. This
 * prevents malformed, relative, UNC, and device paths from triggering I/O.
 * Unexpected filesystem errors are deliberately tri-state unknown: callers
 * fail closed by skipping registration and emitting a generic warning without
 * exposing the path.
 */
export function getPackagedWindowsProtocolMarkerState(
  currentExecutable: unknown,
  inspectMarker: LstatSync = lstatSync,
): PackagedWindowsProtocolMarkerState {
  const normalizedExecutable =
    normalizeLocalDriveWindowsPath(currentExecutable);
  if (normalizedExecutable === null) {
    return "unknown";
  }

  const markerPath = win32.join(
    win32.dirname(normalizedExecutable),
    LVIS_NSIS_PER_MACHINE_MARKER_FILENAME,
  );

  try {
    const marker = inspectMarker(markerPath, { throwIfNoEntry: false });
    return marker?.isFile() === true ? "present" : "absent";
  } catch {
    return "unknown";
  }
}
