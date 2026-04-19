/**
 * dlp-stats aggregation tests — fixture-based, no real filesystem I/O.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";

// ── Fixture data ───────────────────────────────────────────────────────────
const TODAY = new Date().toISOString().slice(0, 10);
const YESTERDAY = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

const FILE_LINES: Record<string, string[]> = {
  [`${TODAY}.jsonl`]: [
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
    JSON.stringify({ timestamp: `${TODAY}T12:00:00.000Z`, sessionId: "s1", type: "turn", input: "hello" }),
    "{ bad json ::::",
  ],
  [`${YESTERDAY}.jsonl`]: [
    JSON.stringify({
      timestamp: `${YESTERDAY}T09:00:00.000Z`,
      sessionId: "s1",
      type: "dlp",
      dlp: { byKind: { EMAIL: 3 }, totalRedactions: 3, turnId: "t3" },
    }),
  ],
};

// ── Mocks (factories must be self-contained — no outer variable refs) ───────
vi.mock("node:fs", () => {
  const { EventEmitter: EE } = require("node:events") as typeof import("node:events");
  const { basename } = require("node:path") as typeof import("node:path");
  const TODAY_KEY = new Date().toISOString().slice(0, 10);
  const YESTERDAY_KEY = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

  const FILE_DATA: Record<string, string[]> = {
    [`${TODAY_KEY}.jsonl`]: [
      JSON.stringify({ timestamp: `${TODAY_KEY}T10:00:00.000Z`, sessionId: "s1", type: "dlp", dlp: { byKind: { EMAIL: 2, PHONE_KR: 1 }, totalRedactions: 3, turnId: "t1" } }),
      JSON.stringify({ timestamp: `${TODAY_KEY}T11:00:00.000Z`, sessionId: "s1", type: "dlp", dlp: { byKind: { CREDIT_CARD: 1 }, totalRedactions: 1, turnId: "t2" } }),
      JSON.stringify({ timestamp: `${TODAY_KEY}T12:00:00.000Z`, sessionId: "s1", type: "turn", input: "hello" }),
      "{ bad json ::::",
    ],
    [`${YESTERDAY_KEY}.jsonl`]: [
      JSON.stringify({ timestamp: `${YESTERDAY_KEY}T09:00:00.000Z`, sessionId: "s1", type: "dlp", dlp: { byKind: { EMAIL: 3 }, totalRedactions: 3, turnId: "t3" } }),
    ],
  };

  return {
    existsSync: vi.fn(() => true),
    readdirSync: vi.fn(() => Object.keys(FILE_DATA)),
    createReadStream: vi.fn((filePath: string) => {
      const filename = basename(filePath as string);
      const lines = FILE_DATA[filename] ?? [];
      const em = new EE();
      setTimeout(() => {
        for (const line of lines) em.emit("data", line + "\n");
        em.emit("end");
      }, 0);
      return em;
    }),
  };
});

vi.mock("node:readline", () => ({
  createInterface: ({ input }: { input: NodeJS.EventEmitter }) => {
    const { EventEmitter: EE } = require("node:events") as typeof import("node:events");
    const rl = new EE();
    const chunks: string[] = [];
    input.on("data", (chunk: string) => chunks.push(chunk));
    input.on("end", () => {
      chunks.join("").split("\n").filter(Boolean).forEach((l) => rl.emit("line", l));
      rl.emit("close");
    });
    return rl;
  },
}));

// ── Import after mocks ────────────────────────────────────────────────────
import { getDlpStats } from "../dlp-stats.js";
import * as fsModule from "node:fs";

describe("getDlpStats", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Restore default mock behaviour for readdirSync
    (fsModule.readdirSync as ReturnType<typeof vi.fn>).mockReturnValue(
      Object.keys(FILE_LINES)
    );
    (fsModule.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);
  });

  it("sums totalHits across all dlp entries", async () => {
    const stats = await getDlpStats(7);
    expect(stats.totalHits).toBe(7); // 3+1 today, 3 yesterday
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
    expect(stats.topPatterns[0].kind).toBe("EMAIL");
    expect(stats.topPatterns[0].count).toBe(5);
    expect(stats.topPatterns.length).toBeLessThanOrEqual(5);
  });

  it("ignores non-dlp entries and malformed lines", async () => {
    const stats = await getDlpStats(7);
    expect(stats.totalHits).toBe(7);
  });

  it("returns zero stats when no files exist", async () => {
    (fsModule.readdirSync as ReturnType<typeof vi.fn>).mockReturnValueOnce([]);
    const stats = await getDlpStats(7);
    expect(stats.totalHits).toBe(0);
    expect(stats.topPatterns).toHaveLength(0);
  });
});
