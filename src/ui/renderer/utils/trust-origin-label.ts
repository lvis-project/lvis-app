export function trustOriginLabel(origin: string | undefined): string {
  switch (origin) {
    case "user-keyboard":
      return "사용자 직접 입력";
    case "plugin-emitted":
      return "플러그인 생성";
    case "llm-tool-arg":
      return "모델 생성 인자";
    case "file-content":
      return "파일 내용 기반";
    case undefined:
      return "출처 미확인";
    default:
      return origin;
  }
}

export function isNonUserTrustOrigin(origin: string | undefined): boolean {
  return origin !== "user-keyboard";
}
