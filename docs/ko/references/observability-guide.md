# LVIS Observability Guide

> Covers: Audit log · Plugin perf · LLM cost · DLP stats
> Sprint: Observability X-D (PR #113–#116)

---

## 1. Audit Log

### Format

Append-only NDJSON at `~/.lvis/audit/audit.ndjson`. Each line is one JSON object:

```jsonc
{
  "ts": "2026-04-19T04:12:00.123Z",
  "type": "tool_call",           // see types below
  "toolName": "bash",
  "result": "allow",
  "message": "optional detail",
  "turnId": "t-abc123",
  "dlp": { "byKind": { "pii": 2 }, "turnId": "t-abc123" }  // only for type=dlp
}
```

**Entry types**

| type | When written |
| --- | --- |
| `tool_call` | Every tool execution attempt |
| `permission_decision` | L2/L3 permission gate result |
| `bash_validation` | AST pre-validator result (§6.5) |
| `compact` | Auto-compact trigger |
| `error` | Unhandled engine error |
| `dlp` | Redaction fired in `dlp-filter.ts` |

Rotation: file exceeds 50 MB → renamed `audit.YYYYMMDD-HHMMSS.ndjson`. Queue cap: 10,000 events (oldest dropped on overflow).

### Search Approach

`AuditLogger.search(query)` streams NDJSON, applies filters in order:

1. Date range (`ts >= dateFrom && ts <= dateTo`)
2. Type filter (exact match on `type`)
3. Text search (substring on serialized line)

IPC: `lvis:audit:search` → `AuditEntry[]` · `lvis:audit:stats` → aggregate counts.

---

## 2. Plugin Performance Stats

Stats are **in-memory, per-session** — reset on app restart.

### Semantics

| Field | Computation |
| --- | --- |
| `startupMs` | `Date.now()` delta across `PluginRuntime.load()` |
| `calls` | Incremented in `PluginRuntime.call()` |
| `errors` | Incremented when `call()` throws |
| `avgMs` | `totalDurationMs / calls` (rolling) |
| `lastCall` | UTC timestamp of most recent call |
| `errorRate` | `errors / calls` — UI threshold: green <1%, amber 1–5%, red >5% |

Collection point: `src/plugins/runtime.ts`.
IPC: `lvis:plugins:perf-stats` → `Record<pluginId, PluginPerfStats>`.

> **Persistence gap**: Current implementation holds stats in memory only. If cross-session trends are needed, plan a `~/.lvis/perf/` write path in a future sprint.

---

## 3. LLM Cost Monitor

### Pricing Sources

Token costs are defined as constants in `src/engine/usage-stats.ts`:

```ts
// example — update when vendor pricing changes
const PRICE_PER_1K: Record<string, { input: number; output: number }> = {
  "gpt-4o": { input: 0.005, output: 0.015 },
  // ...
};
```

Update this file when model pricing changes. No external price-fetch at runtime.

### Monthly Projection Formula

```
projection = (totalCostInRange / daysElapsed) * daysInMonth
```

`computeMonthlyProjection(usedDays, totalCost)` in `src/engine/usage-stats.ts`. "Days elapsed" counts calendar days that have at least one usage entry in the selected range.

### Session Breakdown

Top-5 sessions ranked by total cost. Each row: `sessionId · date · inputTokens · outputTokens · cost`.

### CSV Export

`lvis:usage:export-csv` IPC → triggers renderer `<a download>` with CSV blob. Columns: `date, sessionId, model, inputTokens, outputTokens, costUSD`.

---

## 4. DLP Hit Statistics

### Audit Entry Type `dlp`

When `dlp-filter.ts` `redactForLLM()` fires a redaction, it writes:

```jsonc
{
  "ts": "...",
  "type": "dlp",
  "turnId": "t-abc123",
  "dlp": {
    "byKind": { "pii": 1, "secret": 0 },
    "turnId": "t-abc123"
  }
}
```

`initDlpAudit(auditLogger)` injects the logger at boot (`src/boot.ts`).

### Aggregation

`getDlpStats(days: number)` in `src/audit/dlp-stats.ts`:

1. Stream NDJSON, filter `type === "dlp"` and `ts >= now - days*86400s`
2. Accumulate `totalHits`, `byKind` map, `byDay` array (for sparkline), `topPatterns`

IPC: `lvis:dlp:stats` (days param) → `DlpStats`.

---

## 5. Operator Workflow

### Release Checklist Integration

See `docs/references/production-release-checklist.md`. Observability items to verify before each release:

- [ ] `audit.ndjson` rotation logic tested with >50 MB file
- [ ] Plugin perf tab loads without error when no plugins installed
- [ ] Cost monitor shows $0.00 (not NaN) when usage range has no entries
- [ ] DLP stats panel shows "0 hits" (not blank) when no DLP events in range
- [ ] CSV export produces valid UTF-8 with correct column headers

### Diagnosing High DLP Hit Rate

1. Open Settings → 개인정보 탭 → check `topPatterns`
2. Identify pattern causing false positives
3. Adjust regex in `src/audit/dlp-filter.ts` pattern list
4. Re-run `bun run test:vitest -- run src/audit` to confirm no regressions

### Diagnosing Plugin Slowness

1. Open Settings → 플러그인 성능 탭
2. Identify plugin with high `avgMs` or red error rate
3. Check plugin's `src/` for unbounded sync operations in tool handlers
4. Use `startupMs` to distinguish load-time vs call-time cost
