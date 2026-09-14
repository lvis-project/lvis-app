import { vi } from "vitest";
import type { FeatureNamespaceHandle } from "../../main/storage/feature-namespace.js";

export function createSubscriptionRuntimeNamespace(): FeatureNamespaceHandle {
  return {
    dir: "C:\\isolated\\subscription-runtimes",
    childDir: vi.fn(async (name: string) => `C:\\isolated\\subscription-runtimes\\${name}`),
    readJson: vi.fn(async (_name: string, fallback: unknown) => fallback),
    writeJson: vi.fn(async () => undefined),
  } as unknown as FeatureNamespaceHandle;
}
