import { useState } from "react";
import { ChevronDown, ChevronRight, FilePlus2, FilePenLine } from "lucide-react";
import type { FileEditDiffData, FileEditHunk } from "../utils/file-diff.js";
import { countDiffLines } from "../utils/file-diff.js";

const VERB_BY_TOOL: Record<FileEditDiffData["tool"], string> = {
  edit_file: "Edit",
  apply_patch: "Patch",
  write_file: "Write",
};

export function FileEditDiff({ data }: { data: FileEditDiffData }) {
  const [open, setOpen] = useState(true);
  const totals = computeLineTotals(data.hunks);
  const verb = data.isNewFile ? "Create" : VERB_BY_TOOL[data.tool];
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
        className="flex w-full min-w-0 items-center gap-2 border-b border-border bg-muted/30 px-3 py-1.5 text-[11px] text-foreground/90 hover:bg-muted/50"
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
            <span className="text-success" aria-label={`Added ${totals.added} lines`}>
              +{totals.added}
            </span>
          )}
          {totals.removed > 0 && (
            <span className="text-destructive" aria-label={`Removed ${totals.removed} lines`}>
              −{totals.removed}
            </span>
          )}
          {data.truncated && (
            <span className="text-warning" title="긴 파일은 미리보기가 잘렸습니다">
              truncated
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
              변경된 내용 없음.
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
  const removed = hunk.oldText.length > 0 ? hunk.oldText.split("\n") : [];
  const added = hunk.newText.length > 0 ? hunk.newText.split("\n") : [];
  let line = startLine;
  return (
    <>
      {separator && (
        <div className="border-t border-dashed border-border/60 bg-muted/20 px-3 py-0.5 text-[10px] text-muted-foreground">
          @@ next hunk
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
      ? "bg-success/10 text-success-foreground/90"
      : "bg-destructive/10 text-destructive-foreground/90";
  const accent = kind === "added" ? "text-success" : "text-destructive";
  const sigil = kind === "added" ? "+" : "−";
  return (
    <div className={`${palette} flex min-w-0 gap-2 px-3`}>
      <span className="w-8 shrink-0 select-none text-right text-[10px] opacity-50">
        {lineNo}
      </span>
      <span className={`${accent} shrink-0 select-none`}>{sigil}</span>
      <span className="min-w-0 whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
        {text.length > 0 ? text : " "}
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
