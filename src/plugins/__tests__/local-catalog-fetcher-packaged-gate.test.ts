/**
 * `LocalCatalogMarketplaceFetcher` packaged-build gate.
 *
 * The local `plugins/marketplace.json` is user-writable and cannot serve as a
 * trust anchor. Packaged builds must fail closed when any code path tries to
 * instantiate the local-catalog fetcher.
 */
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { writeFile, rm } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _resetForTest, setIsPackaged } from "../../boot/dev-flags.js";
import { DisabledMarketplaceFetcher, LocalCatalogMarketplaceFetcher } from "../marketplace.js";

describe("LocalCatalogMarketplaceFetcher — packaged-build gate", () => {
  beforeEach(() => {
    _resetForTest();
  });
  afterEach(() => {
    _resetForTest();
  });

  it("constructor throws when boot has marked the build as packaged", () => {
    setIsPackaged(true);
    expect(() => new LocalCatalogMarketplaceFetcher("/tmp/marketplace.json")).toThrow(
      /LocalCatalogMarketplaceFetcher is dev-only/,
    );
  });

  it("constructor throws by default before boot configures the gate", () => {
    // Default state is fail-closed (isPackagedCached = true). Any module that
    // instantiates the mock before boot wiring also fails — by design.
    expect(() => new LocalCatalogMarketplaceFetcher("/tmp/marketplace.json")).toThrow(
      /LocalCatalogMarketplaceFetcher is dev-only/,
    );
  });

  it("constructor succeeds in unpackaged dev/test builds", () => {
    setIsPackaged(false);
    expect(() => new LocalCatalogMarketplaceFetcher("/tmp/marketplace.json")).not.toThrow();
  });

  it("error message does not leak the marketplace path or other secrets", () => {
    setIsPackaged(true);
    let caught: Error | null = null;
    try {
      new LocalCatalogMarketplaceFetcher("/secret/path/marketplace.json");
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).not.toBeNull();
    expect(caught?.message).not.toContain("/secret/path");
  });
});

describe("LocalCatalogMarketplaceFetcher — announcement fixture contract", () => {
  let testDir: string;
  let marketplacePath: string;

  beforeEach(() => {
    setIsPackaged(false);
    testDir = mkdtempSync(join(tmpdir(), "lvis-mock-marketplace-"));
    marketplacePath = join(testDir, "marketplace.json");
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
    _resetForTest();
  });

  async function writeCatalog(announcements?: unknown): Promise<void> {
    await writeFile(
      marketplacePath,
      JSON.stringify({
        version: 1,
        plugins: [],
        ...(announcements === undefined ? {} : { announcements }),
      }),
      "utf-8",
    );
  }

  it("returns valid announcement fixtures from the local catalog", async () => {
    await writeCatalog([
      {
        id: 7,
        title: "Maintenance",
        body: "Scheduled window",
        level: "warning",
        createdAt: "2026-06-12T00:00:00.000Z",
        startsAt: null,
        endsAt: "2026-06-13T00:00:00.000Z",
      },
    ]);

    const fetcher = new LocalCatalogMarketplaceFetcher(marketplacePath);

    await expect(fetcher.listAnnouncements()).resolves.toEqual([
      {
        id: 7,
        title: "Maintenance",
        body: "Scheduled window",
        level: "warning",
        createdAt: "2026-06-12T00:00:00.000Z",
        startsAt: null,
        endsAt: "2026-06-13T00:00:00.000Z",
      },
    ]);
  });

  it("rejects non-array announcement fixtures", async () => {
    await writeCatalog({ id: 7 });

    const fetcher = new LocalCatalogMarketplaceFetcher(marketplacePath);

    await expect(fetcher.listAnnouncements()).rejects.toThrow(
      /Invalid marketplace catalog announcements/,
    );
  });

  it("rejects malformed announcement rows", async () => {
    await writeCatalog([
      {
        id: 7,
        title: "Maintenance",
        body: "Scheduled window",
        level: "notice",
        createdAt: "2026-06-12T00:00:00.000Z",
        startsAt: null,
        endsAt: null,
      },
    ]);

    const fetcher = new LocalCatalogMarketplaceFetcher(marketplacePath);

    await expect(fetcher.listAnnouncements()).rejects.toThrow(
      /Invalid marketplace catalog announcement at index 0/,
    );
  });
});

describe("DisabledMarketplaceFetcher — packaged-build fallback stub", () => {
  // Used by boot when packaged && no real-cloud URL. Constructor must be
  // side-effect free (no throw) so PluginMarketplaceService boot doesn't
  // crash even though every method call is fail-closed.
  it("constructs in packaged builds without throwing", () => {
    setIsPackaged(true);
    expect(() => new DisabledMarketplaceFetcher()).not.toThrow();
    _resetForTest();
  });

  it("listPlugins() throws marketplace-disabled", async () => {
    const f = new DisabledMarketplaceFetcher();
    await expect(f.listPlugins()).rejects.toThrow(/marketplace-disabled/);
  });

  it("getPluginDetail() throws marketplace-disabled", async () => {
    const f = new DisabledMarketplaceFetcher();
    await expect(f.getPluginDetail()).rejects.toThrow(/marketplace-disabled/);
  });

  it("downloadVersion() throws marketplace-disabled", async () => {
    const f = new DisabledMarketplaceFetcher();
    await expect(f.downloadVersion()).rejects.toThrow(/marketplace-disabled/);
  });
});
