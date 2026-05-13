import type { ReactNode } from "react";

export type RiskLevel = "low" | "medium" | "high";
export type PermissionDecisionCategory = "read" | "write" | "shell" | "network" | "meta";

export type ReviewBasisRow = {
  label: string;
  value: string;
  monospace?: boolean;
  testId?: string;
};

export type ParsedSummary = Record<string, unknown>;

export function SummaryTile({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0 rounded-md border bg-muted/20 px-3 py-2">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className="mt-1 break-words text-xs font-medium leading-relaxed">
        {children}
      </div>
    </div>
  );
}

export function ReviewRow({
  label,
  children,
  testId,
}: {
  label: string;
  children: ReactNode;
  // Round-3 UX MAJOR — allow the row wrapper itself to carry a
  // data-testid so prose rows (non-monospace) can be selected without
  // forcing them into the `<pre>` branch (which mis-renders human-
  // readable sentences as terminal output).
  testId?: string;
}) {
  return (
    <div
      className="grid min-w-0 grid-cols-1 gap-1 border-b px-3 py-2 last:border-b-0 sm:grid-cols-[112px_minmax(0,1fr)] sm:gap-3"
      data-testid={testId}
    >
      <b className="text-xs">{label}</b>
      <div className="min-w-0 break-words text-xs leading-relaxed">
        {children}
      </div>
    </div>
  );
}

/**
 * Round-7 architect MAJOR — canonical Korean label for a {@link RiskLevel}.
 * Centralized here so every risk-display site (ToolApprovalDialog
 * badge / reviewer-verdict row, DeferredQueuePanel header + review
 * row, future surfaces) reads the same translation. Round-6 partial
 * fix translated only the primary badge; the two remaining
 * `level.toUpperCase()` callers leaked raw English to users.
 */
export function riskLevelKoLabel(level: RiskLevel): string {
  if (level === "high") return "높은 위험";
  if (level === "medium") return "중간 위험";
  return "낮은 위험";
}

export function levelBadgeClass(level: RiskLevel) {
  if (level === "high") return "border-destructive text-destructive";
  if (level === "medium") return "border-warning text-warning";
  return "border-primary text-primary";
}

export function reviewBoxClass(level: RiskLevel) {
  if (level === "high") return "border-destructive/50 bg-destructive/10";
  if (level === "medium") return "border-warning/50 bg-warning/10";
  return "border-primary/40 bg-primary/5";
}

export function reviewTitleForCategory(category: PermissionDecisionCategory) {
  if (category === "read") return "읽기 판단근거";
  if (category === "network") return "네트워크 영향범위";
  if (category === "shell") return "명령 영향범위";
  return "작업 영향범위";
}

export function categoryLabel(category: PermissionDecisionCategory) {
  if (category === "network") return "외부 전송";
  if (category === "shell") return "명령 실행";
  if (category === "write") return "변경";
  if (category === "read") return "읽기";
  return "정책";
}

export function parseInputSummary(summary: string): ParsedSummary | null {
  try {
    const parsed = JSON.parse(summary) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as ParsedSummary;
  } catch {
    return null;
  }
}

export function pickSummary(parsed: ParsedSummary | null, keys: string[], emptyText: string): string {
  if (!parsed) return emptyText;
  for (const key of keys) {
    const value = parsed[key];
    if (value === undefined || value === null || value === "") continue;
    return formatSummaryValue(value);
  }
  return emptyText;
}

export function formatSummaryValue(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

export function scopeLabel(parsed: ParsedSummary | null): string {
  const scope = pickSummary(parsed, ["scope", "pathScope", "allowedDir", "allowedDirectories"], "");
  return scope || "scope 정보는 입력 요약 기준";
}

export function sensitivityLabel(parsed: ParsedSummary | null): string {
  const explicit = pickSummary(parsed, ["sensitivity", "dataClass", "classification"], "");
  return explicit || "소스 코드, 설정, 토큰, 개인/업무 데이터 포함 가능성";
}

export function inputVolumeLabel(summary: string): string {
  return `입력 요약 ${summary.length}자`;
}

export function payloadLabel(summary: string): string {
  return `전송 내용 분류는 입력 요약 기준으로 확인 · ${summary.length}자`;
}
