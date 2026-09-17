import type { Stats } from "node:fs";

export declare const HEADLESS_PACKAGED_MARKER_NAME: ".lvis-headless-packaged-v1";

export declare function headlessPackagedMarkerPath(projectRoot: string): string;

export declare function readHeadlessPackagedMarker(
  projectRoot: string,
  inspect?: (path: string, options: { throwIfNoEntry: false }) => Stats | undefined,
): boolean;
