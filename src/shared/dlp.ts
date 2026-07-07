import { t } from "../i18n/index.js";

export interface DlpResult {
  masked: string;
  detections: string[];
}

interface DlpPattern {
  nameKey: string;
  pattern: RegExp;
  replace: (...args: string[]) => string;
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

const DLP_PATTERNS: DlpPattern[] = [
  {
    nameKey: "be_dlp.patternResidentId",
    pattern: /\d{6}-[1-4]\d{6}/g,
    replace: () => "******-*******",
  },
  {
    nameKey: "be_dlp.patternCreditCard",
    pattern: /\d{4}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4}/g,
    replace: (match) => {
      const digits = match.replace(/[-\s]/g, "");
      const last4 = digits.slice(-4);
      return `****-****-****-${last4}`;
    },
  },
  {
    nameKey: "be_dlp.patternPhoneNumber",
    pattern: /010-\d{4}-\d{4}/g,
    replace: () => "010-****-****",
  },
  {
    nameKey: "be_dlp.patternEmail",
    pattern: /[a-zA-Z0-9._%+-]+@([a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g,
    replace: (_match: string, domain: string) => `***@${domain}`,
  },
];

/**
 * 텍스트에서 민감 데이터 패턴을 검사하고 마스킹한다.
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

  for (const { nameKey, pattern, replace } of DLP_PATTERNS) {
    pattern.lastIndex = 0;
    const before = masked;
    masked = masked.replace(pattern, replace);
    if (masked !== before) {
      detections.push(t(nameKey));
    }
  }

  return { masked, detections };
}
