import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export interface SkillRegistryEntry {
  id: string;
  version: string;
  source: "marketplace";
  manifestPath: string;
  skillPath: string;
  installedAt: string;
  enabled?: boolean;
  artifactSha256?: string;
  signerKeyId?: string;
}

export interface SkillRegistry {
  version: 1;
  skills: SkillRegistryEntry[];
}

const registryLocks = new Map<string, Promise<void>>();

export async function readSkillRegistry(registryPath: string): Promise<SkillRegistry> {
  let raw: string;
  try {
    raw = await readFile(registryPath, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { version: 1, skills: [] };
    }
    throw err;
  }
  const parsed = JSON.parse(raw) as Partial<SkillRegistry>;
  if (!Array.isArray(parsed.skills)) {
    throw new Error(`Invalid skill registry: ${registryPath}`);
  }
  return { version: 1, skills: parsed.skills };
}

export async function writeSkillRegistry(registryPath: string, registry: SkillRegistry): Promise<void> {
  await mkdir(dirname(registryPath), { recursive: true });
  await writeFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`, "utf-8");
}

export async function withSkillRegistryLock<T>(
  registryPath: string,
  fn: () => Promise<T>,
): Promise<T> {
  const key = resolve(registryPath);
  const prev = registryLocks.get(key) ?? Promise.resolve();
  const next = prev.then(() => fn());
  registryLocks.set(key, next.then(() => undefined, () => undefined));
  return next;
}

export async function updateSkillRegistry(
  registryPath: string,
  mutator: (registry: SkillRegistry) => void | Promise<void>,
): Promise<void> {
  await withSkillRegistryLock(registryPath, async () => {
    const registry = await readSkillRegistry(registryPath);
    await mutator(registry);
    await writeSkillRegistry(registryPath, registry);
  });
}
