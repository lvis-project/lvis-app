/**
 * Issue #749 — FileEditDiff
 *
 * Renders a write_file tool result. When the diff is truncated (either side
 * exceeds WRITE_DIFF_PREVIEW_LIMIT) and a sidecar exists, shows a
 * "전체 diff 보기" button that fetches and renders the full before/after via IPC.
 *
 * States:
 *   truncated  — truncated badge + "전체 diff 보기" button (sidecar available)
 *   loading    — spinner, button disabled
 *   expanded   — full before/after diff hunks
 *   error      — inline error message with retry button
 *   normal     — no truncation, renders result block directly (pass-through)
 *
 * IPC channel: lvis:chat:get-write-diff → { before, after } | null
 * Mirrors CompactedToolResult's lazy-fetch pattern.
 */

import { useState, useEffect, useRef } from "react";
import { getApi } from "../api-client.js";

// ─── Diff helpers ─────────────────────────────────────────────────────────────

/** Split content into lines (no trailing newline artifact). */
function lines(text: string): string[] {
  if (text === "") return [];
  const ls = text.split("\n");
  // If last char is \n, split gives empty trailing element — drop it.
  if (ls[ls.length - 1] === "") ls.pop();
  return ls;
}

type DiffHunk =
  | { type: "context"; line: string }
  | { type: "removed"; line: string }
  | { type: "added"; line: string };

/**
 * Minimal Myers-style unified diff — for display only.
 * Produces `removed` / `added` / `context` hunks.
 * Context window: 3 lines around each changed line.
 */
function buildDiffHunks(before: string, after: string): DiffHunk[] {
  const bLines = lines(before);
  const aLines = lines(after);

  // LCS-based diff via DP (O(m*n) — acceptable for display sized inputs).
  const m = bLines.length;
  const n = aLines.length;
  // dp[i][j] = LCS length for bLines[0..i), aLines[0..j)
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      if (bLines[i] === aLines[j]) {
        dp[i][j] = 1 + dp[i + 1][j + 1];
      } else {
        dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
  }

  // Walk the LCS to build flat removed/added/context sequence.
  const raw: DiffHunk[] = [];
  let i = 0;
  let j = 0;
  while (i < m || j < n) {
    if (i < m && j < n && bLines[i] === aLines[j]) {
      raw.push({ type: "context", line: bLines[i] });
      i++;
      j++;
    } else if (j < n && (i >= m || dp[i + 1][j] <= dp[i][j + 1])) {
      raw.push({ type: "added", line: aLines[j] });
      j++;
    } else {
      raw.push({ type: "removed", line: bLines[i] });
      i++;
    }
  }

  // Collapse context: keep only 3 lines around changes.
  const CONTEXT_LINES = 3;
  const changed = new Set<number>();
  for (let k = 0; k < raw.length; k++) {
    if (raw[k].type !== "context") changed.add(k);
  }
  const keep = new Set<number>();
  for (const k of changed) {
    for (let d = -CONTEXT_LINES; d <= CONTEXT_LINES; d++) {
      const idx = k + d;
      if (idx >= 0 && idx < raw.length) keep.add(idx);
    }
  }

  const result: DiffHunk[] = [];
  let lastKept = -1;
  for (let k = 0; k < raw.length; k++) {
    if (!keep.has(k)) continue;
    if (lastKept >= 0 && k > lastKept + 1) {
      result.push({ type: "context", line: "⋯" });
    }
    result.push(raw[k]);
    lastKept = k;
  }
  return result;
}

// ─── Props ────────────────────────────────────────────────────────────────────

export interface FileEditDiffProps {
  /** Raw JSON string output from WriteFileTool — parsed here for truncated/hasSidecar. */
  resultJson: string;
  /** Active session id for IPC guard. */
  sessionId: string;
  /** tool_use_id for IPC sidecar lookup. */
  toolUseId: string;
  /** Resolved file path (from tool input). */
  filePath?: string;
}

// ─── Parsed result shape from WriteFileTool output ───────────────────────────
interface WriteDiffResult {
  path?: string;
  bytes?: number;
  truncated?: boolean;
  hasSidecar?: boolean;
}

function parseWriteResult(json: string): WriteDiffResult {
  try {
    const parsed = JSON.parse(json) as unknown;
    if (parsed !== null && typeof parsed === "object") {
      return parsed as WriteDiffResult;
    }
  } catch {
    // malformed — treat as non-truncated
  }
  return {};
}

// ─── Component ────────────────────────────────────────────────────────────────

type DiffState = "idle" | "loading" | "expanded" | "error";

export function FileEditDiff({ resultJson, sessionId, toolUseId, filePath }: FileEditDiffProps) {
  const parsed = parseWriteResult(resultJson);
  const [diffState, setDiffState] = useState<DiffState>("idle");
  const [diffData, setDiffData] = useState<{ before: string; after: string } | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const isMountedRef = useRef(true);
  useEffect(() => {
    isMountedRef.current = true;
    return () => { isMountedRef.current = false; };
  }, []);

  // If not truncated or no sidecar, render a plain summary.
  if (!parsed.truncated || !parsed.hasSidecar) {
    const path = filePath ?? parsed.path ?? "";
    const bytes = parsed.bytes !== undefined ? `${parsed.bytes.toLocaleString()} bytes` : "";
    return (
      <div className="rounded px-2 py-1 font-mono text-[10px] text-muted-foreground bg-muted/30">
        {path ? <span className="text-primary/80">{path}</span> : null}
        {bytes ? <span className="ml-2 text-muted-foreground/60">{bytes}</span> : null}
      </div>
    );
  }

  async function handleExpand() {
    // cache hit
    if (diffData) {
      setDiffState("expanded");
      return;
    }
    setDiffState("loading");
    setErrorMsg(null);
    try {
      const result = await getApi().chatGetWriteDiff(sessionId, toolUseId);
      if (!isMountedRef.current) return;
      if (result === null) {
        setErrorMsg("diff 파일이 소실되었습니다 (세션 재시작 후 불가).");
        setDiffState("error");
      } else {
        setDiffData(result);
        setDiffState("expanded");
      }
    } catch (err) {
      if (!isMountedRef.current) return;
      setErrorMsg((err as Error).message ?? "IPC 오류");
      setDiffState("error");
    }
  }

  function handleRetry() {
    setDiffState("idle");
    setErrorMsg(null);
  }

  const path = filePath ?? parsed.path ?? "";
  const bytes = parsed.bytes !== undefined ? `${parsed.bytes.toLocaleString()} bytes` : "";

  // ── Expanded — full diff ────────────────────────────────────────────────────
  if (diffState === "expanded" && diffData) {
    const hunks = buildDiffHunks(diffData.before, diffData.after);
    return (
      <div className="min-w-0 w-full max-w-full rounded-md text-[11px]">
        {/* header */}
        <div className="flex items-center gap-2 px-3 py-1.5 rounded-t-md border-b"
          style={{ backgroundColor: "hsl(var(--muted) / 0.5)" }}>
          <span className="font-medium text-primary/80 truncate min-w-0">{path}</span>
          {bytes && <span className="shrink-0 text-muted-foreground/60 text-[10px]">{bytes}</span>}
          <button
            type="button"
            className="ml-auto shrink-0 text-[10px] text-primary hover:underline"
            onClick={() => setDiffState("idle")}
          >
            접기
          </button>
        </div>
        {/* diff body */}
        <div
          className="max-h-[24rem] overflow-y-auto font-mono text-[10px] leading-[1.5] rounded-b-md px-0 py-1"
          style={{ backgroundColor: "hsl(var(--code-bg))", color: "hsl(var(--code-fg))" }}
        >
          {hunks.length === 0 ? (
            <div className="px-3 py-1 text-muted-foreground/60 italic">변경 없음</div>
          ) : (
            hunks.map((h, i) => (
              <div
                key={i}
                className="flex px-2 py-0"
                style={{
                  backgroundColor:
                    h.type === "added"
                      ? "hsl(142 60% 40% / 0.15)"
                      : h.type === "removed"
                        ? "hsl(0 60% 50% / 0.15)"
                        : "transparent",
                }}
              >
                <span
                  className="shrink-0 select-none w-4 text-muted-foreground/50"
                  style={{
                    color:
                      h.type === "added"
                        ? "hsl(142 60% 50%)"
                        : h.type === "removed"
                          ? "hsl(0 60% 60%)"
                          : undefined,
                  }}
                >
                  {h.type === "added" ? "+" : h.type === "removed" ? "-" : " "}
                </span>
                <span className="whitespace-pre-wrap break-words [overflow-wrap:anywhere] min-w-0">
                  {h.line}
                </span>
              </div>
            ))
          )}
        </div>
      </div>
    );
  }

  // ── Error state ─────────────────────────────────────────────────────────────
  if (diffState === "error") {
    return (
      <div className="rounded-md px-3 py-1.5 text-[11px] text-destructive/80 bg-destructive/10 flex items-center gap-2">
        <span className="truncate min-w-0">{errorMsg}</span>
        <button
          type="button"
          className="shrink-0 text-[10px] text-primary hover:underline"
          onClick={handleRetry}
        >
          재시도
        </button>
      </div>
    );
  }

  // ── Idle / Loading — truncated preview with expand button ──────────────────
  const isLoading = diffState === "loading";
  return (
    <div className="min-w-0 w-full max-w-full rounded-md text-[11px]"
      style={{ backgroundColor: "hsl(var(--muted) / 0.4)" }}>
      <div className="flex items-center gap-2 px-3 py-1.5">
        <span className="font-medium text-primary/80 truncate min-w-0">{path}</span>
        {bytes && <span className="shrink-0 text-muted-foreground/60 text-[10px]">{bytes}</span>}
        <span className="shrink-0 text-[10px] text-warning/80 ml-1">· 미리보기 제한</span>
        <button
          type="button"
          disabled={isLoading}
          className="ml-auto shrink-0 text-[10px] text-primary hover:underline disabled:opacity-50 disabled:cursor-not-allowed"
          onClick={() => { void handleExpand(); }}
        >
          {isLoading ? "불러오는 중…" : "전체 diff 보기"}
        </button>
      </div>
    </div>
  );
}
