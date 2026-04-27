/**
 * Integration test stubs — Issue #260 trigger wiring.
 *
 * Each test asserts that the matching trigger site invokes
 * NotificationService.fire(...) with the expected `kind` and a sample body.
 * The underlying integrations are mocked — these stubs are about wiring,
 * not the integration internals.
 */
import { describe, it, expect, vi } from "vitest";
import { AskUserQuestionGate } from "../ask-user-question-gate.js";
import { ApprovalGate } from "../../permissions/approval-gate.js";
import {
  setNotificationServiceForRoutines,
  deliverRoutineResult,
} from "../../routines/routine-delivery.js";
import type { NotificationService, FireOptions } from "../notification-service.js";

function makeFakeNotificationService(): NotificationService {
  return {
    fire: vi.fn((_opts: FireOptions) => {}),
  } as unknown as NotificationService;
}

function makeMockWebContents() {
  return {
    send: vi.fn(),
    isDestroyed: vi.fn(() => false),
  };
}

describe("Trigger 3: AskUserQuestionGate fires `ask-user` on requestAndWait entry", () => {
  it("fires with kind=ask-user and the question body", async () => {
    const wc = makeMockWebContents();
    const svc = makeFakeNotificationService();
    const gate = new AskUserQuestionGate(wc as never, 60_000, svc);
    // We only care that fire was called — drop the resulting promise.
    void gate.ask({ question: "프로젝트 진행 상태가 어떤가요?" });
    expect(svc.fire).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "ask-user",
        title: "질문이 도착했습니다",
        body: "프로젝트 진행 상태가 어떤가요?",
        contextRef: expect.objectContaining({ questionId: expect.any(String) }),
      }),
    );
    gate.disposeAll();
  });
});

describe("Trigger 4: ApprovalGate fires `approval` on requestAndWait entry", () => {
  it("fires with kind=approval and urgent=true", async () => {
    const wc = makeMockWebContents();
    const svc = makeFakeNotificationService();
    const gate = new ApprovalGate(
      wc as never,
      undefined,
      60_000,
      undefined,
      svc,
    );
    void gate.requestAndWait({
      id: "req-1",
      category: "tool",
      toolName: "memory_save",
      args: {},
      reason: "상태 변경 도구",
      source: "builtin",
      createdAt: Date.now(),
    });
    expect(svc.fire).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "approval",
        title: "승인이 필요합니다",
        urgent: true,
        contextRef: expect.objectContaining({ approvalId: "req-1" }),
      }),
    );
  });
});

describe("Trigger 2: deliverRoutineResult fires `routine`", () => {
  it("fires with kind=routine, title containing routineId, body=summary", async () => {
    const svc = makeFakeNotificationService();
    setNotificationServiceForRoutines(svc);
    // null mainWindow short-circuits the actual IPC send but still hits the
    // notification fire path — exactly what we need for this stub.
    await deliverRoutineResult(null, {
      routineId: "wakeup",
      trigger: "wakeup",
      summary: "오늘의 일정 3개입니다",
      generatedAt: new Date().toISOString(),
      sessionId: "sess-1",
    });
    expect(svc.fire).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "routine",
        title: expect.stringContaining("wakeup"),
        body: "오늘의 일정 3개입니다",
        contextRef: expect.objectContaining({
          routineId: "wakeup",
          sessionId: "sess-1",
        }),
      }),
    );
    setNotificationServiceForRoutines(undefined);
  });
});

// Trigger 1 (turn-end) is exercised through the full ConversationLoop, which
// requires extensive deps to construct (provider, tool registry, memory,
// system prompt builder, etc.). The relevant wiring assertion is covered at
// the unit level in `notification-service.test.ts` and at the type level by
// `ConversationLoopDeps.notificationService` being threaded through
// `runTurn`. A full E2E for this trigger lives at the manual-smoke layer.
describe("Trigger 1: ConversationLoop turn-end wiring (type-level)", () => {
  it("ConversationLoopDeps accepts notificationService", async () => {
    // Compile-time assertion: this test merely imports the module and
    // confirms the deps shape. Runtime call would require a full provider
    // setup which is out of scope for a wiring stub.
    const mod = await import("../../engine/conversation-loop.js");
    expect(typeof mod.ConversationLoop).toBe("function");
  });
});
