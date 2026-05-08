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
    name: "주민등록번호",
    pattern: /\d{6}-[1-4]\d{6}/g,
    replace: () => "******-*******",
  },
  {
    name: "신용카드",
    pattern: /\d{4}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4}/g,
    replace: (match) => {
      const digits = match.replace(/[-\s]/g, "");
      const last4 = digits.slice(-4);
      return `****-****-****-${last4}`;
    },
  },
  {
    name: "API 키",
    pattern: /sk-[a-zA-Z0-9]{20,}/g,
    replace: () => "sk-****",
  },
  {
    name: "전화번호",
    pattern: /010-\d{4}-\d{4}/g,
    replace: () => "010-****-****",
  },
  {
    name: "이메일",
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
  let masked = text;

  for (const { name, pattern, replace } of DLP_PATTERNS) {
    pattern.lastIndex = 0;
    const before = masked;
    masked = masked.replace(pattern, replace);
    if (masked !== before) {
      detections.push(name);
    }
  }

  return { masked, detections };
}
