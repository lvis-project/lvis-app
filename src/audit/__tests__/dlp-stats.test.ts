/**
 * DLP statistics over real streamed JSONL fixtures.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { getDlpStats } from "../dlp-stats.js";

const TODAY = new Date().toISOString().slice(0, 10);
const YESTERDAY = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

let root: string;
let auditDir: string;

function writeLines(filename: string, lines: string[]): void {
  writeFileSync(join(auditDir, filename), `${lines.join("\n")}\n`, "utf-8");
}

beforeEach(() => {
  root = mkdtempSync(join(process.cwd(), ".lvis-dlp-stats-"));
  auditDir = join(root, "audit");
  mkdirSync(auditDir, { recursive: true });
  process.env.LVIS_HOME = root;
  writeLines(`${TODAY}.jsonl`, [
    JSON.stringify({
      timestamp: `${TODAY}T10:00:00.000Z`,
      sessionId: "s1",
      type: "dlp",
      dlp: { byKind: { EMAIL: 2, PHONE_KR: 1 }, totalRedactions: 3, turnId: "t1" },
    }),
    JSON.stringify({
      timestamp: `${TODAY}T11:00:00.000Z`,
      sessionId: "s1",
      type: "dlp",
      dlp: { byKind: { CREDIT_CARD: 1 }, totalRedactions: 1, turnId: "t2" },
    }),
    JSON.stringify({ timestamp: `${TODAY}T12:00:00.000Z`, sessionId: "s1", type: "turn" }),
    "{ bad json ::::",
  ]);
  writeLines(`${YESTERDAY}.jsonl`, [
    JSON.stringify({
      timestamp: `${YESTERDAY}T09:00:00.000Z`,
      sessionId: "s1",
      type: "dlp",
      dlp: { byKind: { EMAIL: 3 }, totalRedactions: 3, turnId: "t3" },
    }),
  ]);
});

afterEach(() => {
  delete process.env.LVIS_HOME;
  rmSync(root, { recursive: true, force: true });
});

describe("getDlpStats", () => {
  it("sums totalHits across all dlp entries", async () => {
    expect((await getDlpStats(7)).totalHits).toBe(7);
  });

  it("aggregates byKind correctly", async () => {
    const stats = await getDlpStats(7);
    expect(stats.byKind.EMAIL).toBe(5);
    expect(stats.byKind.PHONE_KR).toBe(1);
    expect(stats.byKind.CREDIT_CARD).toBe(1);
  });

  it("aggregates byDay correctly", async () => {
    const stats = await getDlpStats(7);
    expect(stats.byDay[TODAY]).toBe(4);
    expect(stats.byDay[YESTERDAY]).toBe(3);
  });

  it("returns topPatterns sorted descending, max 5", async () => {
    const stats = await getDlpStats(7);
    expect(stats.topPatterns[0]).toEqual({ kind: "EMAIL", count: 5 });
    expect(stats.topPatterns.length).toBeLessThanOrEqual(5);
  });

  it("ignores non-dlp entries and malformed lines", async () => {
    expect((await getDlpStats(7)).totalHits).toBe(7);
  });

  it("returns zero stats when no files exist", async () => {
    rmSync(auditDir, { recursive: true, force: true });
    mkdirSync(auditDir, { recursive: true });
    const stats = await getDlpStats(7);
    expect(stats.totalHits).toBe(0);
    expect(stats.topPatterns).toHaveLength(0);
  });
});
