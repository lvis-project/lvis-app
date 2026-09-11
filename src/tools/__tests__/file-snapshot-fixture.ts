import { open } from "node:fs/promises";

/** Read fixture bytes and identity through the same open file. */
export async function readTestFileSnapshot(path: string) {
  const file = await open(path, "r");
  try {
    const bytes = await file.readFile();
    const stat = await file.stat();
    return { bytes, stat };
  } finally {
    await file.close();
  }
}
