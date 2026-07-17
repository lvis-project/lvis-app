import { describe, expect, it } from "vitest";
import {
  RATIONALE_APPROVAL_DISPLAY_KIND,
  RATIONALE_APPROVAL_DISPLAY_VERSION,
  createRationaleApprovalDisplay,
  normalizeRationaleApprovalDisplayText,
  parseRationaleApprovalDisplay,
} from "../rationale-approval-display.js";

function readyDisplay() {
  return {
    contractVersion: RATIONALE_APPROVAL_DISPLAY_VERSION,
    display: RATIONALE_APPROVAL_DISPLAY_KIND,
    toolName: "bash",
    canonicalTargets: ["workspace/build"],
    requestedEffects: ["delete-files"],
    affectedResources: ["workspace/build"],
    requiredAuthority: "shell",
    effectiveVerdict: { level: "medium" as const, reason: "Deletes one build directory." },
    scopeAlignment: "aligned" as const,
    scopeReasons: ["The target is inside the requested workspace."],
    rationaleStatus: "ready" as const,
    suggestion: "This deletes only the generated build output.",
    modalFallbackRequired: false,
  };
}

describe("rationale approval display", () => {
  it("accepts and freezes a narrow ready display", () => {
    const parsed = parseRationaleApprovalDisplay(readyDisplay());

    expect(parsed).not.toBeNull();
    expect(parsed).toMatchObject({
      contractVersion: 1,
      display: "rationale-approval-display",
      rationaleStatus: "ready",
    });
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed!.canonicalTargets)).toBe(true);
    expect(Object.isFrozen(parsed!.effectiveVerdict)).toBe(true);
  });

  it("enforces the failed-fallback invariants", () => {
    const failed = {
      ...readyDisplay(),
      rationaleStatus: "failed" as const,
      scopeAlignment: "unknown" as const,
      suggestion: null,
      modalFallbackRequired: true,
    };

    expect(parseRationaleApprovalDisplay(failed)).toMatchObject({
      rationaleStatus: "failed",
      suggestion: null,
    });
    expect(parseRationaleApprovalDisplay({ ...failed, modalFallbackRequired: false })).toBeNull();
    expect(parseRationaleApprovalDisplay({ ...failed, scopeAlignment: "aligned" })).toBeNull();
    expect(parseRationaleApprovalDisplay({ ...failed, suggestion: "untrusted" })).toBeNull();
  });

  it("rejects broad, unsafe, and malformed renderer data", () => {
    const valid = readyDisplay();

    expect(parseRationaleApprovalDisplay({ ...valid, ticketId: "ticket-secret" })).toBeNull();
    expect(parseRationaleApprovalDisplay({
      ...valid,
      suggestion: "<img src=x onerror=alert(1)>",
    })).toBeNull();
    expect(parseRationaleApprovalDisplay({
      ...valid,
      canonicalTargets: ["workspace\u0000/build"],
    })).toBeNull();
    expect(parseRationaleApprovalDisplay({ ...valid, effectiveVerdict: { level: "critical", reason: "no" } })).toBeNull();
    expect(parseRationaleApprovalDisplay({ ...valid, suggestion: null })).toBeNull();
  });

  it("normalizes invisible Unicode only in the host projection path", () => {
    expect(
      normalizeRationaleApprovalDisplayText(
        "한국어\u202E 경로\u2066 와 C1\u0085 제어문자",
      ),
    ).toBe("한국어 경로 와 C1 제어문자");
    expect(
      normalizeRationaleApprovalDisplayText("생성된 빌드 출력만 삭제합니다."),
    ).toBe("생성된 빌드 출력만 삭제합니다.");
  });

  it("rejects bidi, isolate, and C1 characters in a raw renderer payload", () => {
    const valid = readyDisplay();

    expect(parseRationaleApprovalDisplay({
      ...valid,
      suggestion: "안전한 설명\u202E거짓 대상",
    })).toBeNull();
    expect(parseRationaleApprovalDisplay({
      ...valid,
      scopeReasons: ["요청 범위\u2066 외부"],
    })).toBeNull();
    expect(parseRationaleApprovalDisplay({
      ...valid,
      canonicalTargets: ["작업 공간\u0085빌드"],
    })).toBeNull();
  });

  it("accepts ordinary Korean display text", () => {
    const korean = {
      ...readyDisplay(),
      toolName: "파일 정리",
      canonicalTargets: ["작업 공간/빌드"],
      requestedEffects: ["생성물 삭제"],
      affectedResources: ["생성된 빌드 출력"],
      requiredAuthority: "셸 실행",
      effectiveVerdict: {
        level: "medium" as const,
        reason: "생성된 출력만 삭제합니다.",
      },
      scopeReasons: ["대상이 요청한 작업 공간 안에 있습니다."],
      suggestion: "빌드 산출물만 한 번 삭제하는 것이 적절합니다.",
    };

    expect(parseRationaleApprovalDisplay(korean)).toMatchObject({
      toolName: "파일 정리",
      suggestion: "빌드 산출물만 한 번 삭제하는 것이 적절합니다.",
    });
  });

  it("throws rather than widening invalid host input", () => {
    expect(() => createRationaleApprovalDisplay({
      ...readyDisplay(),
      suggestion: null,
    })).toThrow("invalid rationale approval display");
  });
});
