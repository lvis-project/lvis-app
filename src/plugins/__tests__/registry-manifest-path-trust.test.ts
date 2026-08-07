/**
 * `resolveManifestPathsFromRegistry` is the producer; `PythonRuntime`'s
 * lockfile discovery is the consumer. Every case below drives the producer
 * end-to-end from a REAL `registry.json` on disk through the REAL
 * `readPluginRegistry`, and asserts on the list the consumer is handed.
 *
 * Why the consumer matters: `python-runtime.ts` feeds each returned path to
 * `lockCandidatesFromManifest`, which reads the manifest and contains the
 * declared lockfile relative to `dirname(manifestPath)` — containment anchored
 * to whatever directory the registry entry named. The chosen lockfile drives
 * the `uv` bootstrap, which by explicit design runs at boot BEFORE the ASRT
 * sandbox is initialized.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { readPluginRegistry, resolveManifestPathsFromRegistry } from "../registry.js";
import { resolveTrustedRegistryManifestPath } from "../registry-manifest-trust.js";

let testDir: string;
let pluginsRoot: string;
let registryPath: string;
let outsideDir: string;

async function writeManifestAt(dir: string, id: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  const manifestPath = join(dir, "plugin.json");
  await writeFile(
    manifestPath,
    JSON.stringify({ id, name: id, version: "1.0.0", python: { requirementsLock: "attacker.lock" } }),
    "utf-8",
  );
  await writeFile(join(dir, "attacker.lock"), "evil-package==1.0.0\n", "utf-8");
  return manifestPath;
}

/** Write a real registry.json the real reader will accept. */
async function writeRegistry(
  entries: { id: string; manifestPath: string }[],
): Promise<void> {
  await writeFile(
    registryPath,
    JSON.stringify({ version: 1, plugins: entries.map((e) => ({ ...e, enabled: true })) }),
    "utf-8",
  );
}

/** The exact producer call `python-runtime.ts` makes. */
async function consumerInput(): Promise<string[]> {
  const registry = await readPluginRegistry(registryPath);
  return resolveManifestPathsFromRegistry(registryPath, registry.plugins);
}

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), "lvis-regtrust-"));
  // `dirname(registryPath) === pluginsRoot` by construction.
  pluginsRoot = join(testDir, "plugins");
  outsideDir = join(testDir, "outside");
  await mkdir(pluginsRoot, { recursive: true });
  await mkdir(outsideDir, { recursive: true });
  registryPath = join(pluginsRoot, "registry.json");
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

describe("resolveManifestPathsFromRegistry — trust root is enforced before the consumer sees a path", () => {
  it("passes through a legitimate entry under pluginsRoot (positive control)", async () => {
    const good = await writeManifestAt(join(pluginsRoot, "good"), "good");
    await writeRegistry([{ id: "good", manifestPath: good }]);

    const paths = await consumerInput();
    expect(paths).toHaveLength(1);
    expect(resolve(paths[0]!)).toBe(resolve(good));
  });

  it("drops an ABSOLUTE entry pointing outside pluginsRoot", async () => {
    const good = await writeManifestAt(join(pluginsRoot, "good"), "good");
    const evil = await writeManifestAt(join(outsideDir, "evil"), "evil");
    await writeRegistry([
      { id: "good", manifestPath: good },
      { id: "evil", manifestPath: evil },
    ]);

    const paths = await consumerInput();
    // The consumer must never be handed the escaping path — it would read
    // that manifest and derive lockfile candidates anchored to `outsideDir`.
    expect(paths.map((p) => resolve(p))).toEqual([resolve(good)]);
    expect(paths.some((p) => p.includes("outside"))).toBe(false);
  });

  it("drops a RELATIVE `../..` traversal entry", async () => {
    const evil = await writeManifestAt(join(outsideDir, "evil"), "evil");
    await writeRegistry([
      { id: "evil", manifestPath: join("..", "outside", "evil", "plugin.json") },
    ]);
    // Sanity: the traversal really does resolve onto the planted manifest, so
    // this fixture expresses a reachable escape rather than a dead string.
    expect(resolve(pluginsRoot, "..", "outside", "evil", "plugin.json")).toBe(resolve(evil));

    expect(await consumerInput()).toEqual([]);
  });

  it("drops a SYMLINK that is lexically inside the root but links out", async () => {
    const evil = await writeManifestAt(join(outsideDir, "evil"), "evil");
    const linkDir = join(pluginsRoot, "linked");
    try {
      await symlink(join(outsideDir, "evil"), linkDir, "junction");
    } catch {
      return; // symlink/junction creation unavailable — nothing to assert
    }
    await writeRegistry([{ id: "linked", manifestPath: join(linkDir, "plugin.json") }]);
    expect(evil).toContain("outside");

    // A lexical containment check would ACCEPT this path; realpath is what
    // rejects it.
    expect(await consumerInput()).toEqual([]);
  });

  it("still drops pendingUpdate rows (pre-existing behaviour preserved)", async () => {
    const good = await writeManifestAt(join(pluginsRoot, "good"), "good");
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        plugins: [
          {
            id: "good",
            manifestPath: good,
            enabled: true,
            pendingUpdate: {
              kind: "marketplace",
              previousManifestFileSha256: null,
              previousReceiptRaw: null,
            },
          },
        ],
      }),
      "utf-8",
    );
    expect(await consumerInput()).toEqual([]);
  });
});

describe("resolveTrustedRegistryManifestPath — the authority itself", () => {
  it("does not blanket-trust a relative path the way the old predicate did", async () => {
    await writeManifestAt(join(outsideDir, "evil"), "evil");
    // The predicate this replaced opened with `if (!isAbsolute(p)) return true`,
    // so this exact input returned TRUE.
    expect(
      resolveTrustedRegistryManifestPath(
        join("..", "outside", "evil", "plugin.json"),
        pluginsRoot,
      ),
    ).toBeNull();
  });

  it("returns the absolute path for a contained relative entry", async () => {
    const good = await writeManifestAt(join(pluginsRoot, "good"), "good");
    const got = resolveTrustedRegistryManifestPath(join("good", "plugin.json"), pluginsRoot);
    expect(got).not.toBeNull();
    expect(resolve(got!)).toBe(resolve(good));
  });

  it("returns null for a non-existent entry (a dangling row is not trustworthy)", () => {
    expect(
      resolveTrustedRegistryManifestPath(join(pluginsRoot, "nope", "plugin.json"), pluginsRoot),
    ).toBeNull();
  });

  it("returns null when the root itself cannot be resolved", () => {
    expect(
      resolveTrustedRegistryManifestPath("plugin.json", join(testDir, "no-such-root")),
    ).toBeNull();
  });
});
