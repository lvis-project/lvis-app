/**
 * DLP Hit Statistics — Observability
 *
 * Reads audit JSONL files, filters type="dlp" entries, and aggregates
 * hit statistics for the Privacy tab dashboard.
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { AuditEntry } from "./audit-logger.js";
import { lvisHome } from "../shared/lvis-home.js";
import { iterateJsonlLines } from "./jsonl-reader.js";

export interface DlpStats {
  totalHits: number;
  byKind: Record<string, number>;
  /** hits per calendar day, key = "YYYY-MM-DD" */
  byDay: Record<string, number>;
  /** top 5 patterns sorted by hit count descending */
  topPatterns: Array<{ kind: string; count: number }>;
}

function filesInRange(auditDir: string, days: number): string[] {
  const dateFrom = new Date(Date.now() - days * 86_400_000)
    .toISOString()
    .slice(0, 10);
  let files: string[];
  try {
    files = readdirSync(auditDir)
      .filter((f) => f.endsWith(".jsonl"))
      .sort();
  } catch {
    return [];
  }
  return files.filter((f) => f.replace(".jsonl", "") >= dateFrom);
}

export async function getDlpStats(days = 7): Promise<DlpStats> {
  const auditDir = join(lvisHome(), "audit");
  const files = filesInRange(auditDir, days);

  const byKind: Record<string, number> = {};
  const byDay: Record<string, number> = {};
  let totalHits = 0;

  for (const file of files) {
    const filePath = join(auditDir, file);
    if (!existsSync(filePath)) continue;
    for await (const line of iterateJsonlLines(filePath)) {
      if (!line.trim()) continue;
      let entry: AuditEntry;
      try {
        entry = JSON.parse(line) as AuditEntry;
      } catch {
        continue;
      }
      if (entry.type !== "dlp" || !entry.dlp) continue;

      const day = entry.timestamp?.slice(0, 10) ?? file.replace(".jsonl", "");
      const hits = entry.dlp.totalRedactions;
      totalHits += hits;
      byDay[day] = (byDay[day] ?? 0) + hits;

      for (const [kind, count] of Object.entries(entry.dlp.byKind)) {
        byKind[kind] = (byKind[kind] ?? 0) + count;
      }
    }
  }

  const topPatterns = Object.entries(byKind)
    .map(([kind, count]) => ({ kind, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  return { totalHits, byKind, byDay, topPatterns };
}
