import { copyFile } from "node:fs/promises";
import { join } from "node:path";
import {
  buildMainBoundaryBundle, childBundleDir, repositoryRoot,
} from "../../plugins/isolation/__tests__/child-entry-bundle.js";

/** Emit only the image child, using the shipped bundle's dependency boundary. */
export async function buildImagePreparationEntry(cacheName: string): Promise<string> {
  const directory = childBundleDir(cacheName);
  await buildMainBoundaryBundle({
    entryPoints: { "image-preparation-child": join(repositoryRoot(), "src/tools/image-preparation-child.ts") },
    outdir: directory, splitting: true,
  });
  await copyFile(join(directory, "image-preparation-child.mjs"), join(directory, "image-preparation-child.js"));
  return directory;
}

export function imageFixturePath(name: string): string {
  return join(repositoryRoot(), "src/__tests__/fixtures/images", name);
}
