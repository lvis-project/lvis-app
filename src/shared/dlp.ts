import { t } from "../i18n/index.js";

export interface DlpResult {
  masked: string;
  detections: string[];
}

/**
 * Short, scrubbed form for an error surface — a log line, a status string, a
 * message handed to the model. Credential-scrubbed by {@link scrubSecretsForLLM}
 * and hard-capped, because the text is usually authored by something the host does
 * not control (an MCP server's JSON-RPC error, a transport failure) and neither
 * its length nor its content is bounded at the source.
 *
 * Lives HERE, beside the scrubber it wraps, rather than in one consumer: a caller
 * needing a bounded error string should not have to import a transport module to
 * get one.
 */
export function scrubShortError(text: string): string {
  return scrubSecretsForLLM(text).slice(0, 120);
}

/**
 * Slice-free credential scrubber shared by diagnostics bundles, log-tail IPC,
 * audit/display masking, and MCP error surfacing.
 *
 * This covers credential-shaped spans that the PII patterns below intentionally
 * do not model: bearer tokens, API-key fields, JWTs, vendor-prefixed tokens,
 * and context-labeled cloud secrets. It stays prefix/context driven rather than
 * redacting every high-entropy blob, because diagnostics often contain commit
 * SHAs and artifact hashes.
 */
export function scrubSecretsForLLM(text: string): string {
  return text
    .replace(
      /(authorization\s*:\s*)digest\s+[A-Za-z][A-Za-z0-9_-]*=(?:\\"[^"]*\\"|"[^"]*"|[^,\s"]+)(?:,\s*[A-Za-z][A-Za-z0-9_-]*=(?:\\"[^"]*\\"|"[^"]*"|[^,\s"]+))*/gi,
      "$1[REDACTED:TOKEN]",
    )
    .replace(
      /(authorization\s*:\s*)(?:basic|bearer|digest|negotiate|token)\s+[A-Za-z0-9._\-~+/=]+/gi,
      "$1[REDACTED:TOKEN]",
    )
    .replace(
      /(authorization\s*:\s*)(?!(?:basic|bearer|digest|negotiate|token)\s)[A-Za-z0-9._\-~+/=]+/gi,
      "$1[REDACTED:TOKEN]",
    )
    .replace(
      /((?:x-api-key|x-auth-token)\s*:\s*)[A-Za-z0-9._\-~+/=]+/gi,
      "$1[REDACTED:TOKEN]",
    )
    .replace(/\bbearer\s+[A-Za-z0-9._\-~+/=]+/gi, "Bearer [REDACTED:TOKEN]")
    .replace(
      /([?&](?:api[_-]?key|token|access[_-]?token|refresh[_-]?token))=([^&\s]+)/gi,
      "$1=[REDACTED:TOKEN]",
    )
    .replace(
      /(["'](?:api[_-]?key|token|access[_-]?token|refresh[_-]?token|authorization|x-api-key|x-auth-token|aws[_-]?secret[_-]?access[_-]?key)["']\s*:\s*["'])[^"']+(["'])/gi,
      "$1[REDACTED:TOKEN]$2",
    )
    // JSON Web Tokens: three base64url segments separated by dots (header.payload.sig).
    .replace(/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g, "[REDACTED:JWT]")
    // AWS access-key + adjacent 40-char secret pair. Do this before the
    // standalone AKIA pass so the paired secret does not remain visible.
    .replace(
      /\bAKIA[0-9A-Z]{16}([\s:=,]+)[A-Za-z0-9/+=]{40}(?=$|[^A-Za-z0-9/+=])/gi,
      "[REDACTED:TOKEN]$1[REDACTED:TOKEN]",
    )
    .replace(/\b(AWS_SECRET_ACCESS_KEY\s*[:=]\s*["']?)[A-Za-z0-9/+=]{40}(["']?)/gi, "$1[REDACTED:TOKEN]$2")
    // Vendor-prefixed tokens observed in diagnostics probes (#1511).
    .replace(/\bgh[opsru]_[A-Za-z0-9_]{20,}\b/gi, "[REDACTED:TOKEN]")
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/gi, "[REDACTED:TOKEN]")
    .replace(/\bxox[bp]-[A-Za-z0-9-]{10,}\b/gi, "[REDACTED:TOKEN]")
    .replace(/\bxapp-[A-Za-z0-9-]{10,}\b/gi, "[REDACTED:TOKEN]")
    .replace(/\bAKIA[0-9A-Z]{16}\b/gi, "[REDACTED:TOKEN]")
    .replace(/\bAIza[0-9A-Za-z_-]{20,}\b/gi, "[REDACTED:TOKEN]")
    // Prefixed API keys: sk-/pk-/rk-/proj-/test-/live- followed by >=8 key chars.
    .replace(/\b(?:sk|pk|rk|proj|test|live)-[A-Za-z0-9_-]{8,}\b/gi, "[REDACTED:TOKEN]");
}

/**
 * Luhn checksum gate for credit-card candidates. This is part of DETECTION, not
 * replacement: a digit run that fails Luhn is not treated as a card by either
 * consumer, so a 16-digit order or ticket number is left intact rather than
 * masked. Lives here in the leaf module so the display masker and the
 * LLM-egress redactor apply the identical card test rather than diverging.
 */
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

type PiiKind = "SSN_KR" | "EMAIL" | "PHONE_KR" | "PHONE_US" | "CREDIT_CARD";

/**
 * One shared PII detector. DETECTION (the pattern plus an optional validity
 * gate) is the single converged set that both entry points consume; REPLACEMENT
 * is deliberately per-consumer: {@link PiiPattern.maskShape} preserves the
 * display silhouette (prefix, length, separators) for audit/display surfaces,
 * while {@link PiiPattern.redactToken} fully removes the span for text bound to
 * a model. Neither consumer re-implements detection.
 */
export interface PiiPattern {
  kind: PiiKind;
  /** i18n key for the human-facing detection label used by {@link maskSensitiveData}. */
  nameKey: string;
  /** Shared, global detection pattern. */
  pattern: RegExp;
  /**
   * Extra detection gate (Luhn for cards). A span the gate rejects is left
   * intact by BOTH consumers — it is decided not to be PII, not merely styled
   * differently.
   */
  valid?: (match: string) => boolean;
  /** Display-shape-preserving replacement (audit / display / agent-egress masking). */
  maskShape: (match: string, ...groups: string[]) => string;
  /** Full-redaction token (text handed to a model). */
  redactToken: string;
}

/**
 * The single converged detection set — the union of what each former copy
 * caught correctly, not a whole-file pick:
 *  - IDs are anchored on word boundaries, so a six-then-seven digit run sitting
 *    inside a longer digit string is not misread as a resident-registration
 *    number;
 *  - both the dashed and the dashless mobile form are matched, across the wider
 *    carrier-prefix range, plus the US phone shape;
 *  - card candidates span the wider digit-length range and are gated by Luhn, so
 *    a non-card digit run of card length is left intact.
 *
 * Order is significant and identical for both consumers: an address-shaped span
 * is claimed as an email before the phone or card patterns can see its digits,
 * and an ID is claimed before the card candidate can absorb its digits.
 */
export const PII_PATTERNS: PiiPattern[] = [
  {
    kind: "SSN_KR",
    nameKey: "be_dlp.patternResidentId",
    pattern: /\b\d{6}-[1-4]\d{6}\b/g,
    maskShape: (m) => m.replace(/\d/g, "*"),
    redactToken: "[REDACTED:SSN]",
  },
  {
    kind: "EMAIL",
    nameKey: "be_dlp.patternEmail",
    pattern: /[a-zA-Z0-9._%+-]+@([\w.-]+\.\w+)/g,
    maskShape: (_m, domain) => `***@${domain}`,
    redactToken: "[REDACTED:EMAIL]",
  },
  {
    kind: "PHONE_KR",
    nameKey: "be_dlp.patternPhoneNumber",
    pattern: /01[016789]-?\d{3,4}-?\d{4}/g,
    // Keep the carrier prefix visible, mask every remaining digit, and keep any
    // separators so the silhouette (e.g. 010-****-****, or a dashless run) survives.
    maskShape: (m) => m.slice(0, 3) + m.slice(3).replace(/\d/g, "*"),
    redactToken: "[REDACTED:PHONE]",
  },
  {
    kind: "PHONE_US",
    nameKey: "be_dlp.patternPhoneNumber",
    pattern: /(?:\(\d{3}\)\s?|\b\d{3}[-.])\d{3}[-.\s]\d{4}\b/g,
    maskShape: (m) => m.replace(/\d/g, "*"),
    redactToken: "[REDACTED:PHONE]",
  },
  {
    kind: "CREDIT_CARD",
    nameKey: "be_dlp.patternCreditCard",
    pattern: /\b(?:\d[ -]?){12,18}\d\b/g,
    valid: luhnValid,
    // Reveal the last four digits, mask the rest, and keep the original
    // separators so a 15- or 16-digit card keeps its grouping.
    maskShape: (m) => {
      const total = (m.match(/\d/g) ?? []).length;
      let seen = 0;
      return m.replace(/\d/g, (d) => (++seen > total - 4 ? d : "*"));
    },
    redactToken: "[REDACTED:CC]",
  },
];

/**
 * 텍스트에서 민감 데이터 패턴을 검사하고 마스킹한다. Detection is the shared
 * {@link PII_PATTERNS} set; this entry point applies the display-shape-preserving
 * replacement. The credential scrubber runs first, then each PII pattern in the
 * shared order.
 *
 * @param text 검사할 원본 텍스트
 * @returns masked: 마스킹된 텍스트, detections: 탐지된 패턴명 목록
 */
export function maskSensitiveData(text: string): DlpResult {
  const detections: string[] = [];
  let masked = scrubSecretsForLLM(text);
  if (masked !== text) {
    detections.push(t("be_dlp.patternCredential"));
  }

  for (const spec of PII_PATTERNS) {
    spec.pattern.lastIndex = 0;
    const before = masked;
    masked = masked.replace(spec.pattern, (match: string, ...rest: unknown[]): string => {
      if (spec.valid && !spec.valid(match)) return match;
      // In a replace callback the capture groups precede the numeric offset;
      // slice them off so maskShape receives only the string groups it declares.
      const offsetIdx = rest.findIndex((a) => typeof a === "number");
      const groups = (offsetIdx === -1 ? [] : rest.slice(0, offsetIdx)) as string[];
      return spec.maskShape(match, ...groups);
    });
    if (masked !== before) {
      const label = t(spec.nameKey);
      if (!detections.includes(label)) detections.push(label);
    }
  }

  return { masked, detections };
}
