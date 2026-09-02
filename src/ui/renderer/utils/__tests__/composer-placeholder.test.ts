import { describe, it, expect } from "vitest";
import { computeComposerPlaceholder } from "../composer-placeholder.js";
import type { SuggestedRepliesSnapshot } from "../../hooks/use-suggested-replies.js";

const EMPTY: SuggestedRepliesSnapshot = {
  text: null,
  isDismissed: false,
};

const ACTIVE: SuggestedRepliesSnapshot = {
  text: "캘린더 직접 열게",
  isDismissed: false,
};

const DISMISSED: SuggestedRepliesSnapshot = {
  text: "캘린더 직접 열게",
  isDismissed: true,
};

describe("computeComposerPlaceholder", () => {
  it("API 키 부재 시 안내 문구가 최우선", () => {
    expect(
      computeComposerPlaceholder({
        hasApiKey: false,
        streaming: false,
        suggestedReplies: ACTIVE,
      }),
    ).toBe("API 키를 먼저 설정해 주세요...");
  });

  it("streaming 중에는 큐 안내가 노출", () => {
    expect(
      computeComposerPlaceholder({
        hasApiKey: true,
        streaming: true,
        suggestedReplies: EMPTY,
      }),
    ).toBe("메시지 큐에 추가됩니다 (즉시 인터럽트는 ⌘⏎)");
  });

  it("suggested-replies 가 활성 (text != null, !dismissed) 이면 placeholder 가 빈 문자열", () => {
    expect(
      computeComposerPlaceholder({
        hasApiKey: true,
        streaming: false,
        suggestedReplies: ACTIVE,
      }),
    ).toBe("");
  });

  it("suggested-replies 가 dismissed 된 경우는 기본 placeholder 복귀", () => {
    expect(
      computeComposerPlaceholder({
        hasApiKey: true,
        streaming: false,
        suggestedReplies: DISMISSED,
      }),
    ).toContain("typing");
  });

  it("suggested-replies 가 비어 있으면 기본 placeholder 노출", () => {
    expect(
      computeComposerPlaceholder({
        hasApiKey: true,
        streaming: false,
        suggestedReplies: EMPTY,
      }),
    ).toBe("typing, ⌘+V, /");
  });

  it("streaming + 활성 chip 이 동시에 있으면 추천 UI 가 placeholder 를 숨김", () => {
    // `suggested_replies` 이벤트가 `done`보다 먼저 도착하므로, streaming
    // placeholder 를 유지하면 ghost/chip 과 같은 textarea 줄에서 겹쳐 보인다.
    expect(
      computeComposerPlaceholder({
        hasApiKey: true,
        streaming: true,
        suggestedReplies: ACTIVE,
      }),
    ).toBe("");
  });
});
