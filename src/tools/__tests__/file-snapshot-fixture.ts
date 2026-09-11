import { lstat, open } from "node:fs/promises";

/** Read fixture bytes and identity through the same open file. */
export async function readTestFileSnapshot(path: string) {
  const file = await open(path, "r");
  try {
    const bytes = await file.readFile();
    const stat = await file.stat();
    const leaf = await lstat(path);
    if (leaf.isSymbolicLink() || leaf.dev !== stat.dev || leaf.ino !== stat.ino) {
      throw new Error("Fixture path no longer identifies the opened file");
    }
    return { bytes, stat };
  } finally {
    await file.close();
  }
}
