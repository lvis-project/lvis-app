import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export interface AgentRegistryEntry {
  id: string;
  version: string;
  source: "marketplace";
  manifestPath: string;
  profilePath: string;
  installedAt: string;
  enabled?: boolean;
  artifactSha256?: string;
  signerKeyId?: string;
}

export interface AgentRegistry {
  version: 1;
  agents: AgentRegistryEntry[];
}

const registryLocks = new Map<string, Promise<void>>();

export async function readAgentRegistry(registryPath: string): Promise<AgentRegistry> {
  let raw: string;
  try {
    raw = await readFile(registryPath, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { version: 1, agents: [] };
    }
    throw err;
  }
  const parsed = JSON.parse(raw) as Partial<AgentRegistry>;
  if (!Array.isArray(parsed.agents)) {
    throw new Error(`Invalid agent registry: ${registryPath}`);
  }
  return { version: 1, agents: parsed.agents };
}

export async function writeAgentRegistry(registryPath: string, registry: AgentRegistry): Promise<void> {
  await mkdir(dirname(registryPath), { recursive: true });
  await writeFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`, "utf-8");
}

export async function withAgentRegistryLock<T>(
  registryPath: string,
  fn: () => Promise<T>,
): Promise<T> {
  const key = resolve(registryPath);
  const prev = registryLocks.get(key) ?? Promise.resolve();
  const next = prev.then(() => fn());
  registryLocks.set(key, next.then(() => undefined, () => undefined));
  return next;
}

export async function updateAgentRegistry(
  registryPath: string,
  mutator: (registry: AgentRegistry) => void | Promise<void>,
): Promise<void> {
  await withAgentRegistryLock(registryPath, async () => {
    const registry = await readAgentRegistry(registryPath);
    await mutator(registry);
    await writeAgentRegistry(registryPath, registry);
  });
}
