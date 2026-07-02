import { readFile, readdir } from "node:fs/promises";

/**
 * Shared test helper — read the concatenated boot-wiring source. Boot wiring is
 * spread across boot.ts + boot/*.ts + boot/steps/*.ts (BootContext split), so the
 * source-pinned guard tests scan the union and find a wiring pattern wherever its
 * step module landed — robust to future step reorganization. Consolidated here
 * (single source) so boot-llm-fetch-source and main-plugin-lifecycle-source share
 * one implementation.
 *
 * Path note: this module lives at `src/testing/`, one level under `src/`, so the
 * `../boot*` specifiers resolve to `src/boot*` exactly as they did from
 * `src/__tests__/`.
 */
export async function readBootWiring(): Promise<string> {
  const parts: string[] = [await readFile(new URL("../boot.ts", import.meta.url), "utf8")];
  for (const dir of ["../boot/", "../boot/steps/"]) {
    const dirUrl = new URL(dir, import.meta.url);
    const entries = await readdir(dirUrl);
    for (const name of entries.sort()) {
      if (name.endsWith(".ts") && !name.endsWith(".d.ts")) {
        parts.push(await readFile(new URL(name, dirUrl), "utf8"));
      }
    }
  }
  return parts.join("\n");
}
