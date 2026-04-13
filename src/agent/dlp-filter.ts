/**
 * DLP Filter — tool-governance.md §11 데이터 흐름 보안
 *
 * PostHook Step 7에서 도구 실행 결과의 민감 데이터를 검사하고 마스킹.
 * 탐지된 패턴 목록은 감사 로그에 기록됨.
 */

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
