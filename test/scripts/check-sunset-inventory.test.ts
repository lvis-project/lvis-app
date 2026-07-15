import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const SCRIPT = resolve(process.cwd(), "scripts/check-sunset-inventory.mjs");

function validInventory(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    lastReviewed: "2026-07-01",
    minSupportedAppVersion: "0.4.4",
    policy: {},
    entries: [
      {
        id: "test-migration",
        kind: "migration",
        status: "active",
        owner: "test",
        introduced: "2026-06-01",
        introducedBy: "0123456789abcdef",
        rationale: "Test migration inventory entry.",
        codeReferences: ["src/boot.ts"],
        dataPreservationTests: ["src/boot/steps/__tests__/work-board-migration.test.ts"],
        validation: ["bun run test:vitest -- run src/boot/steps/__tests__/work-board-migration.test.ts"],
        sunsetNotBefore: "2026-08-30",
        sunsetCriteria: ["The migration is outside the supported upgrade floor."],
        ...overrides,
      },
    ],
  };
}

function runInventory(body: object) {
  const dir = mkdtempSync(join(tmpdir(), "lvis-sunset-inventory-"));
  const file = join(dir, "inventory.json");
  writeFileSync(file, JSON.stringify(body, null, 2), "utf-8");
  try {
    return spawnSync(process.execPath, [SCRIPT, "--file", file], {
      cwd: process.cwd(),
      encoding: "utf-8",
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("check-sunset-inventory", () => {
  it("accepts a complete migration entry", () => {
    const result = runInventory(validInventory());

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("[sunset-inventory] OK entries=1");
  });

  it("rejects duplicate entry ids", () => {
    const body = validInventory();
    body.entries.push({ ...body.entries[0] });

    const result = runInventory(body);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("duplicate entry id: test-migration");
  });

  it("rejects experimental-isolated entries without an experimental path or feature flag", () => {
    const result = runInventory(
      validInventory({
        id: "test-experimental",
        kind: "dormant-experimental",
        status: "experimental-isolated",
        codeReferences: ["src/boot.ts"],
        dataPreservationTests: [],
        reviewAfter: "2026-08-01",
        deleteOrPromoteAfter: "2026-10-01",
      }),
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("experimental-isolated entries need an experimental/ path or featureFlag");
  });

  it("rejects removed status so deletion PRs remove the inventory entry", () => {
    const result = runInventory(validInventory({ status: "removed" }));

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("unsupported status removed");
  });

  it("rejects code references that do not exist", () => {
    const result = runInventory(validInventory({ codeReferences: ["src/missing-sunset-target.ts"] }));

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("codeReferences path does not exist");
  });
});
