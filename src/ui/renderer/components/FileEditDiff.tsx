




import { useState, useEffect, useRef } from "react";
import { ChevronDown, ChevronRight, FilePlus2, FilePenLine } from "lucide-react";
import type { FileEditDiffData, FileEditHunk } from "../utils/file-diff.js";
import { countDiffLines } from "../utils/file-diff.js";
import { getApi } from "../api-client.js";
import { useTranslation } from "../../../i18n/react.js";

// ─── Main inline diff component (edit_file / apply_patch / write_file inline) ─

const VERB_KEY_BY_TOOL: Record<FileEditDiffData["tool"], string> = {
  edit_file: "fileEditDiff.verbEdit",
  apply_patch: "fileEditDiff.verbPatch",
  write_file: "fileEditDiff.verbWrite",
};

export function FileEditDiff({ data }: { data: FileEditDiffData }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(true);
  const totals = computeLineTotals(data.hunks);
  const verb = t(data.isNewFile ? "fileEditDiff.verbCreate" : VERB_KEY_BY_TOOL[data.tool]);
  const Icon = data.isNewFile ? FilePlus2 : FilePenLine;

  return (
    <div
      className="overflow-hidden rounded border border-border bg-background"
      data-testid="file-edit-diff"
      data-tool={data.tool}
      data-new-file={data.isNewFile ? "true" : "false"}
      data-truncated={data.truncated ? "true" : "false"}
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full min-w-0 items-center gap-2 border-b border-border bg-muted/(--opacity-muted) px-3 py-1.5 text-[11px] text-foreground/(--opacity-near) hover:bg-muted/(--opacity-half)"
        aria-expanded={open}
      >
        {open ? (
          <ChevronDown className="h-3 w-3 shrink-0 opacity-70" />
        ) : (
          <ChevronRight className="h-3 w-3 shrink-0 opacity-70" />
        )}
        <Icon className="h-3 w-3 shrink-0 opacity-70" />
        <span className="min-w-0 truncate text-left">
          <span className="font-medium">{verb}</span>
          <span className="opacity-60">(</span>
          <span className="font-mono">{data.path}</span>
          <span className="opacity-60">)</span>
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-2 text-[10px] text-muted-foreground">
          {totals.added > 0 && (
            <span
              className="text-success"
              aria-label={t("fileEditDiff.addedLinesAriaLabel", {
                count: String(totals.added),
              })}
            >
              +{totals.added}
            </span>
          )}
          {totals.removed > 0 && (
            <span
              className="text-destructive"
              aria-label={t("fileEditDiff.removedLinesAriaLabel", {
                count: String(totals.removed),
              })}
            >
              −{totals.removed}
            </span>
          )}
          {data.truncated && (
            <span className="text-warning" title={t("fileEditDiff.truncatedTitle")}>
              {t("fileEditDiff.truncatedLabel")}
            </span>
          )}
        </span>
      </button>
      {open && (
        <div className="font-mono text-[11px] leading-[1.55]">
          {data.hunks.map((hunk, i) => (
            <DiffHunk
              key={i}
              hunk={hunk}
              startLine={hunkStartLine(data.hunks, i)}
              separator={data.hunks.length > 1 && i > 0}
            />
          ))}
          {totals.added === 0 && totals.removed === 0 && (
            <div className="px-3 py-2 text-[10px] text-muted-foreground">
              {t("fileEditDiff.noChanges")}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function DiffHunk({
  hunk,
  startLine,
  separator,
}: {
  hunk: FileEditHunk;
  startLine: number;
  separator: boolean;
}) {
  const { t } = useTranslation();
  const removed = hunk.oldText.length > 0 ? hunk.oldText.split("\n") : [];
  const added = hunk.newText.length > 0 ? hunk.newText.split("\n") : [];
  let line = startLine;
  return (
    <>
      {separator && (
        <div className="border-t border-dashed border-border/(--opacity-strong) bg-muted/(--opacity-light) px-3 py-0.5 text-[10px] text-muted-foreground">
          @@ {t("fileEditDiff.nextHunk")}
        </div>
      )}
      {removed.map((text, i) => {
        const n = line++;
        return <DiffLine key={`r-${i}`} kind="removed" lineNo={n} text={text} />;
      })}
      {added.map((text, i) => {
        const n = line++;
        return <DiffLine key={`a-${i}`} kind="added" lineNo={n} text={text} />;
      })}
    </>
  );
}

function DiffLine({
  kind,
  lineNo,
  text,
}: {
  kind: "added" | "removed";
  lineNo: number;
  text: string;
}) {
  // Theme-adaptive backgrounds — `success` / `destructive` tokens both have
  // dark + light variants defined in styles.css and adjust automatically.
  const palette =
    kind === "added"
      ? "bg-success/(--opacity-subtle) text-success-foreground/(--opacity-near)"
      : "bg-destructive/(--opacity-subtle) text-destructive-foreground/(--opacity-near)";
  const accent = kind === "added" ? "text-success" : "text-destructive";
  const sigil = kind === "added" ? "+" : "−";
  return (
    <div className={`${palette} flex min-w-0 gap-2 px-3`}>
      <span className="w-8 shrink-0 select-none text-right text-[10px] opacity-50">
        {lineNo}
      </span>
      <span className={`${accent} shrink-0 select-none`}>{sigil}</span>
      <span className="min-w-0 whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
        {text.length > 0 ? text : " "}
      </span>
    </div>
  );
}

function computeLineTotals(hunks: FileEditHunk[]): { added: number; removed: number } {
  return hunks.reduce(
    (acc, h) => ({
      added: acc.added + countDiffLines(h.newText),
      removed: acc.removed + countDiffLines(h.oldText),
    }),
    { added: 0, removed: 0 },
  );
}

function hunkStartLine(hunks: FileEditHunk[], idx: number): number {
  let n = 1;
  for (let i = 0; i < idx; i++) {
    const h = hunks[i];
    if (!h) continue;
    n += countDiffLines(h.oldText) + countDiffLines(h.newText);
  }
  return n;
}

// ─── Sidecar IPC diff component (write_file truncated+hasSidecar) ─────────────

/** Split content into lines (no trailing newline artifact). */
function sidecarLines(text: string): string[] {
  if (text === "") return [];
  const ls = text.split("\n");
  if (ls[ls.length - 1] === "") ls.pop();
  return ls;
}

type SidecarDiffHunk =
  | { type: "context"; line: string }
  | { type: "removed"; line: string }
  | { type: "added"; line: string };

/**
 * Minimal Myers-style unified diff — for display only.
 * Produces `removed` / `added` / `context` hunks.
 * Context window: 3 lines around each changed line.
 */
function buildDiffHunks(before: string, after: string): SidecarDiffHunk[] {
  const bLines = sidecarLines(before);
  const aLines = sidecarLines(after);

  const m = bLines.length;
  const n = aLines.length;
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

  const raw: SidecarDiffHunk[] = [];
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

  const result: SidecarDiffHunk[] = [];
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

export interface WriteFileSidecarDiffProps {
  /** Raw JSON string output from WriteFileTool — parsed here for truncated/hasSidecar. */
  resultJson: string;
  /** Active session id for IPC guard. */
  sessionId: string;
  /** tool_use_id for IPC sidecar lookup. */
  toolUseId: string;
  /** Resolved file path (from tool input). */
  filePath?: string;
}

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

type SidecarDiffState = "idle" | "loading" | "expanded" | "error";

export function WriteFileSidecarDiff({
  resultJson,
  sessionId,
  toolUseId,
  filePath,
}: WriteFileSidecarDiffProps) {
  const { t } = useTranslation();
  const parsed = parseWriteResult(resultJson);
  const [diffState, setDiffState] = useState<SidecarDiffState>("idle");
  const [diffData, setDiffData] = useState<{ before: string; after: string } | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const isMountedRef = useRef(true);
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  // If not truncated or no sidecar, render a plain summary.
  if (!parsed.truncated || !parsed.hasSidecar) {
    const path = filePath ?? parsed.path ?? "";
    const bytes = parsed.bytes !== undefined ? `${parsed.bytes.toLocaleString()} bytes` : "";
    return (
      <div className="rounded px-2 py-1 font-mono text-[10px] text-muted-foreground bg-muted/(--opacity-muted)">
        {path ? <span className="text-primary/(--opacity-intense)">{path}</span> : null}
        {bytes ? <span className="ml-2 text-muted-foreground/(--opacity-strong)">{bytes}</span> : null}
      </div>
    );
  }

  async function handleExpand() {
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
        setErrorMsg(t("fileEditDiff.diffFileLost"));
        setDiffState("error");
      } else {
        setDiffData(result);
        setDiffState("expanded");
      }
    } catch (err) {
      if (!isMountedRef.current) return;
      setErrorMsg((err as Error).message ?? t("fileEditDiff.ipcError"));
      setDiffState("error");
    }
  }

  function handleRetry() {
    setDiffState("idle");
    setErrorMsg(null);
  }

  const path = filePath ?? parsed.path ?? "";
  const bytes = parsed.bytes !== undefined ? `${parsed.bytes.toLocaleString()} bytes` : "";

  // ── Expanded — full diff ─────────────────────────────────────────────────────
  if (diffState === "expanded" && diffData) {
    const hunks = buildDiffHunks(diffData.before, diffData.after);
    return (
      <div className="min-w-0 w-full max-w-full rounded-md text-[11px]">
        <div
          className="flex items-center gap-2 px-3 py-1.5 rounded-t-md border-b"
          style={{ backgroundColor: "hsl(var(--muted) / 0.5)" }}
        >
          <span className="font-medium text-primary/(--opacity-intense) truncate min-w-0">{path}</span>
          {bytes && <span className="shrink-0 text-muted-foreground/(--opacity-strong) text-[10px]">{bytes}</span>}
          <button
            type="button"
            className="ml-auto shrink-0 text-[10px] text-primary hover:underline"
            onClick={() => setDiffState("idle")}
          >
            {t("fileEditDiff.collapse")}
          </button>
        </div>
        <div
          className="max-h-[24rem] overflow-y-auto font-mono text-[10px] leading-[1.5] rounded-b-md px-0 py-1"
          style={{ backgroundColor: "hsl(var(--code-bg))", color: "hsl(var(--code-fg))" }}
        >
          {hunks.length === 0 ? (
            <div className="px-3 py-1 text-muted-foreground/(--opacity-strong) italic">{t("fileEditDiff.noChangesShort")}</div>
          ) : (
            hunks.map((h, i) => (
              <div
                key={i}
                className="flex px-2 py-0"
                style={{
                  backgroundColor:
                    h.type === "added"
                      ? "var(--diff-add)"
                      : h.type === "removed"
                        ? "var(--diff-remove)"
                        : "transparent",
                }}
              >
                <span
                  className="shrink-0 select-none w-4 text-muted-foreground/(--opacity-half)"
                  style={{
                    color:
                      h.type === "added"
                        ? "var(--diff-add-fg)"
                        : h.type === "removed"
                          ? "var(--diff-remove-fg)"
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

  // ── Error state ──────────────────────────────────────────────────────────────
  if (diffState === "error") {
    return (
      <div className="rounded-md px-3 py-1.5 text-[11px] text-destructive/(--opacity-intense) bg-destructive/(--opacity-subtle) flex items-center gap-2">
        <span className="truncate min-w-0">{errorMsg}</span>
        <button
          type="button"
          className="shrink-0 text-[10px] text-primary hover:underline"
          onClick={handleRetry}
        >
          {t("fileEditDiff.retry")}
        </button>
      </div>
    );
  }

  // ── Idle / Loading — truncated preview with expand button ────────────────────
  const isLoading = diffState === "loading";
  return (
    <div
      className="min-w-0 w-full max-w-full rounded-md text-[11px]"
      style={{ backgroundColor: "hsl(var(--muted) / 0.4)" }}
    >
      <div className="flex items-center gap-2 px-3 py-1.5">
        <span className="font-medium text-primary/(--opacity-intense) truncate min-w-0">{path}</span>
        {bytes && <span className="shrink-0 text-muted-foreground/(--opacity-strong) text-[10px]">{bytes}</span>}
        <span className="shrink-0 text-[10px] text-warning/(--opacity-intense) ml-1">· {t("fileEditDiff.previewLimit")}</span>
        <button
          type="button"
          disabled={isLoading}
          className="ml-auto shrink-0 text-[10px] text-primary hover:underline disabled:opacity-50 disabled:cursor-not-allowed"
          onClick={() => {
            void handleExpand();
          }}
        >
          {isLoading ? t("fileEditDiff.loading") : t("fileEditDiff.viewFullDiff")}
        </button>
      </div>
    </div>
  );
}
