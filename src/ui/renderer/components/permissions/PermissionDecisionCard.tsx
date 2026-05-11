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

export function ReviewRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid min-w-0 grid-cols-[88px_minmax(0,1fr)] gap-3 border-b px-3 py-2 last:border-b-0">
      <b className="text-xs">{label}</b>
      <div className="min-w-0 break-words text-xs leading-relaxed">
        {children}
      </div>
    </div>
  );
}

export function levelBadgeClass(level: RiskLevel) {
  if (level === "high") return "border-red-500 text-red-700 dark:text-red-400";
  if (level === "medium") return "border-amber-500 text-amber-700 dark:text-amber-300";
  return "border-primary text-primary";
}

export function reviewBoxClass(level: RiskLevel) {
  if (level === "high") return "border-red-500/50 bg-red-500/5";
  if (level === "medium") return "border-amber-500/50 bg-amber-500/5";
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
  return `payload class 는 입력 요약 기준으로 확인 · ${summary.length}자`;
}
