import { describe, it, expect } from "vitest";
import {
  formatIpcError,
  COMMON_IPC_ERROR_MESSAGES,
} from "../format-ipc-error.js";
import { t } from "../../../i18n/runtime.js";

describe("formatIpcError (SOT — #830)", () => {
  it("resolves a known common code from the default map", () => {
    // The map now holds translation keys; formatIpcError resolves them via t().
    expect(formatIpcError("invalid-key", undefined)).toBe(
      t(COMMON_IPC_ERROR_MESSAGES["invalid-key"]),
    );
  });

  it("Layer-0 directory denials resolve from the shared table, not a raw code", () => {
    // These used to be known ONLY to two hand-written local renderer tables, so
    // every other surface rendered the kebab-case code — the exact leak the
    // codes were introduced to prevent (ipc/domains/workspace.ts).
    for (const code of ["path-not-allowed", "sensitive-path"]) {
      const message = formatIpcError(code, undefined);
      expect(message).not.toContain(code);
      expect(message).toBe(t("chatPreviewRail.fileErrorNotAllowed"));
    }
  });

  it("renders the SAME string the removed local codeMap overrides produced", () => {
    // The workspaces panel and the file preview both mapped these two codes to
    // `chatPreviewRail.fileErrorNotAllowed`. Their local copies are gone; this
    // pins that dropping them changed no rendered string.
    const previousOverride = t("chatPreviewRail.fileErrorNotAllowed");
    expect(formatIpcError("path-not-allowed", undefined)).toBe(previousOverride);
    expect(formatIpcError("sensitive-path", undefined)).toBe(previousOverride);
  });

  it("codeMap overrides win over the common default", () => {
    expect(
      formatIpcError("invalid-key", undefined, {
        codeMap: { "invalid-key": "유효하지 않은 승인 키입니다." },
      }),
    ).toBe("유효하지 않은 승인 키입니다.");
  });

  it("returns backend message verbatim when code is unknown and no fallbackContext", () => {
    expect(formatIpcError("never-seen-code", "백엔드가 보낸 메시지입니다")).toBe(
      "백엔드가 보낸 메시지입니다",
    );
  });

  it("prefixes backend message with fallbackContext when supplied", () => {
    expect(
      formatIpcError("never-seen-code", "디테일", {
        fallbackContext: "리뷰어 오류",
      }),
    ).toBe("리뷰어 오류: 디테일");
  });

  it("uses raw code with fallbackContext when message is empty", () => {
    expect(
      formatIpcError("never-seen-code", undefined, {
        fallbackContext: "리뷰어 오류",
      }),
    ).toBe("리뷰어 오류: never-seen-code");
  });

  it("returns generic Korean fallback when both code and message are absent", () => {
    expect(formatIpcError(undefined, undefined)).toBe("알 수 없는 오류가 발생했습니다.");
  });

  it("recognizes intent-gate code from cross-cutting PR #826", () => {
    expect(formatIpcError("user-keyboard-required", undefined)).toContain(
      "활성 사용자 입력",
    );
  });

  it("maps reviewer-rewire-failed to the Korean rollback message", () => {
    expect(formatIpcError("reviewer-rewire-failed", undefined)).toContain(
      "권한 검토 모델",
    );
  });
});
