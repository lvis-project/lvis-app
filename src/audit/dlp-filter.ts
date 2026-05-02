/**
 * DLP Filter — tool-governance.md §11 데이터 흐름 보안
 *
 * PostHook Step 7에서 도구 실행 결과의 민감 데이터를 검사하고 마스킹.
 * 탐지된 패턴 목록은 감사 로그에 기록됨.
 *
 * Also exports `redactFsPath` and `redactAuditPayload` for sanitising
 * filesystem paths before they are written to the audit log (#449).
 */
import os from "node:os";

export interface DlpResult {
  masked: string;
  detections: string[];
}

interface DlpPattern {
  name: string;
  pattern: RegExp;
  replace: (...args: string[]) => string;
}

const DLP_PATTERNS: DlpPattern[] = [
  {
    // 주민등록번호: YYMMDD-[1-4]XXXXXX
    name: "주민등록번호",
    pattern: /\d{6}-[1-4]\d{6}/g,
    replace: () => "******-*******",
  },
  {
    // 신용카드: 16자리 (공백/하이픈 구분자 허용), 마지막 4자리 보존
    name: "신용카드",
    pattern: /\d{4}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4}/g,
    replace: (match) => {
      // 숫자만 추출해 마지막 4자리 보존
      const digits = match.replace(/[-\s]/g, "");
      const last4 = digits.slice(-4);
      return `****-****-****-${last4}`;
    },
  },
  {
    // API 키: sk- 접두어 + 20자 이상 영숫자
    name: "API 키",
    pattern: /sk-[a-zA-Z0-9]{20,}/g,
    replace: () => "sk-****",
  },
  {
    // 전화번호: 010-XXXX-XXXX
    name: "전화번호",
    pattern: /010-\d{4}-\d{4}/g,
    replace: () => "010-****-****",
  },
  {
    // 이메일 주소: MCP 결과에서 외부 유출 시 도메인만 표시
    name: "이메일",
    pattern: /[a-zA-Z0-9._%+-]+@([a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g,
    replace: (_match: string, domain: string) => `***@${domain}`,
  },
];

/**
 * Sprint E §3 — 사용자 draft 를 LLM 으로 보내기 전 PII 를 `[REDACTED:*]` 로
 * 전체 치환한다. maskSensitiveData 와 달리 부분 마스킹이 아닌 완전 제거
 * (카드 뒷 4자리 미보존) — 전송 방지 목적이 우선.
 *
 * 커버:
 *   - EMAIL         : `[\w.+-]+@[\w.-]+\.\w+`
 *   - PHONE (KR)    : `01[016789]-?\d{3,4}-?\d{4}`
 *   - PHONE (US)    : `\b\d{3}-\d{3}-\d{4}\b` / `(xxx) xxx-xxxx`
 *   - CREDIT_CARD   : 13-19 digit 연속열, Luhn 통과 시 치환
 *   - SSN_KR        : `\d{6}-[1-4]\d{6}`
 */
export interface RedactResult {
  redacted: string;
  counts: Record<string, number>;
  totalCount: number;
}

const EMAIL_RE = /[\w.+-]+@[\w.-]+\.\w+/g;
const PHONE_KR_RE = /01[016789]-?\d{3,4}-?\d{4}/g;
const PHONE_US_RE = /(?:\(\d{3}\)\s?|\b\d{3}[-.])\d{3}[-.\s]\d{4}\b/g;
const SSN_KR_RE = /\b\d{6}-[1-4]\d{6}\b/g;
const CC_CAND_RE = /\b(?:\d[ -]?){12,18}\d\b/g;

function luhnValid(num: string): boolean {
  const digits = num.replace(/[^\d]/g, "");
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = Number(digits[i]);
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

/** Optional auditLogger injected at boot to record DLP hits. */
let _auditLogger: { log: (e: { timestamp: string; sessionId: string; type: "dlp"; dlp: { byKind: Record<string, number>; totalRedactions: number; turnId: string } }) => void } | null = null;
let _sessionId = "unknown";

export function initDlpAudit(
  auditLogger: typeof _auditLogger,
  sessionId: string,
): void {
  _auditLogger = auditLogger;
  _sessionId = sessionId;
}

export function redactForLLM(text: string, turnId?: string): RedactResult {
  const counts: Record<string, number> = {};
  const bump = (k: string) => (counts[k] = (counts[k] ?? 0) + 1);

  let out = text;
  // 순서 중요: SSN 은 숫자 구간이 CC 후보와 겹칠 수 있으니 먼저 처리.
  out = out.replace(SSN_KR_RE, () => (bump("SSN_KR"), "[REDACTED:SSN]"));
  out = out.replace(EMAIL_RE, () => (bump("EMAIL"), "[REDACTED:EMAIL]"));
  out = out.replace(PHONE_KR_RE, () => (bump("PHONE_KR"), "[REDACTED:PHONE]"));
  out = out.replace(PHONE_US_RE, () => (bump("PHONE_US"), "[REDACTED:PHONE]"));
  out = out.replace(CC_CAND_RE, (m) => {
    if (!luhnValid(m)) return m;
    bump("CREDIT_CARD");
    return "[REDACTED:CC]";
  });

  const totalCount = Object.values(counts).reduce((a, b) => a + b, 0);
  if (totalCount > 0 && _auditLogger) {
    _auditLogger.log({
      timestamp: new Date().toISOString(),
      sessionId: _sessionId,
      type: "dlp",
      dlp: {
        byKind: counts,
        totalRedactions: totalCount,
        turnId: turnId ?? `turn-${Date.now()}`,
      },
    });
  }
  return { redacted: out, counts, totalCount };
}

// Resolved once at module load; fallback to empty string in test environments
// where os.homedir() may throw or return unexpected values.
const _homeDir = (() => { try { return os.homedir(); } catch { return ""; } })();

const MAX_AUDIT_PATH = 256;

/**
 * Replace the current user's home directory in a filesystem path or
 * file:// URL with the literal "<home>" so audit logs don't leak
 * /Users/<username>/ (or Windows equivalent). Also caps the result at
 * MAX_AUDIT_PATH characters — defence against a crafted long string
 * bloating the audit log (safeStringify's 1 KB cap applies at the JSON
 * level; this cap applies per-field before serialisation).
 *
 * Safe to call on non-path strings: if no home-dir prefix is found the
 * string is returned unchanged (only the length cap applies).
 */
export function redactFsPath(p: string): string {
  if (!p) return p;
  let out = p;
  if (_homeDir) {
    const fileUrlHome = "file://" + _homeDir;
    if (out === fileUrlHome || out.startsWith(fileUrlHome + "/")) {
      out = "file://<home>" + out.slice(fileUrlHome.length);
    } else if (out === _homeDir || out.startsWith(_homeDir + "/") || out.startsWith(_homeDir + "\\")) {
      out = "<home>" + out.slice(_homeDir.length);
    }
  }
  // Use code-point iteration so a surrogate pair at the boundary is not split.
  const codePoints = [...out];
  return codePoints.length > MAX_AUDIT_PATH ? codePoints.slice(0, MAX_AUDIT_PATH).join("") + "…" : out;
}

/**
 * Path-like fields in audit log payloads that may contain the user's home
 * directory. Shallow: nested objects are not walked.
 */
const AUDIT_PATH_KEYS = new Set([
  "entryUrl", "entryFsPath", "rawInstallRoot", "realEntry", "realRoot", "frameUrl",
]);

/**
 * Redact home-dir paths in all recognised path fields of a flat audit payload
 * object. Non-path fields and non-object payloads are returned unchanged.
 * Exported so IPC domains can share the same sanitisation without duplicating
 * the field list.
 */
export function redactAuditPayload(payload: unknown): unknown {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
  return Object.fromEntries(
    Object.entries(payload as Record<string, unknown>).map(([k, v]) =>
      [k, AUDIT_PATH_KEYS.has(k) && typeof v === "string" ? redactFsPath(v) : v],
    ),
  );
}

/**
 * 텍스트에서 민감 데이터 패턴을 검사하고 마스킹한다.
 *
 * @param text - 검사할 원본 텍스트
 * @returns masked: 마스킹된 텍스트, detections: 탐지된 패턴명 목록
 */
export function maskSensitiveData(text: string): DlpResult {
  const detections: string[] = [];
  let masked = text;

  for (const { name, pattern, replace } of DLP_PATTERNS) {
    // 패턴을 stateful하게 사용하므로 lastIndex 리셋
    pattern.lastIndex = 0;
    const before = masked;
    masked = masked.replace(pattern, replace);
    if (masked !== before) {
      detections.push(name);
    }
  }

  return { masked, detections };
}
