/**
 * Remote-approval coordinator tests, driven through a REAL ApprovalGate.
 *
 * The point of the design under test is that a Telegram button press resolves
 * a parked approval through the SAME `ApprovalGate.resolve` chokepoint the
 * desktop dock's IPC handler calls — so these tests compose a real gate (mock
 * renderer, short timeout) with the coordinator and a fake Bot API client, and
 * assert on what the gate's `requestAndWait` promise actually resolved to.
 */
import { describe, expect, it, vi } from "vitest";
import {
  ApprovalGate,
  isHostApprovalTimeoutDecision,
} from "../../permissions/approval-gate.js";
import type {
  ApprovalDecision,
  ApprovalRequest,
  ApprovalRequestInput,
} from "../../permissions/approval-gate.js";
import { auditRowTexts } from "../../permissions/__tests__/test-helpers.js";
import {
  createTelegramRemoteApprovalCoordinator,
  type CreateTelegramRemoteApprovalCoordinatorOptions,
} from "../telegram-remote-approval.js";
import type { TelegramCallbackQueryEnvelope } from "../telegram-platform-adapter.js";

const OWNER_ID = "123456789";
const STRANGER_ID = "987654321";
const SHARED_CONVERSATION = "shared-conversation";
const TOOL_IDENTIFIER = "builtin:list_files";

/** Renderer stand-in that records the dock payloads the gate sends. */
function deskDock() {
  const sent: ApprovalRequest[] = [];
  return {
    sent,
    webContents: {
      send: (_channel: string, request: ApprovalRequest) => {
        sent.push(request);
      },
      isDestroyed: () => false,
    },
  };
}

function approvalAsk(overrides: Partial<ApprovalRequestInput> = {}): ApprovalRequestInput {
  return {
    id: "remote-req-1",
    category: "tool",
    toolName: "list_files",
    source: "builtin",
    args: { path: "." },
    reason: "state-changing tool",
    createdAt: Date.now(),
    sessionId: SHARED_CONVERSATION,
    ...overrides,
  };
}

function fakeDecisionCardClient() {
  return {
    sendDecisionCard: vi.fn(async () => ({
      ok: true as const,
      value: { messageId: 42 },
    })),
    editMessageText: vi.fn(async () => ({ ok: true as const, value: true as const })),
    answerCallbackQuery: vi.fn(async () => ({ ok: true as const, value: true as const })),
  };
}

function remoteApprovalHarness(options: {
  timeoutMs?: number;
  coordinator?: Partial<CreateTelegramRemoteApprovalCoordinatorOptions>;
} = {}) {
  const dock = deskDock();
  const auditLogger = { log: vi.fn() };
  const gate = new ApprovalGate(
    dock.webContents as never,
    undefined,
    options.timeoutMs ?? 2_000,
    auditLogger as never,
  );
  const client = fakeDecisionCardClient();
  const coordinator = createTelegramRemoteApprovalCoordinator({
    client,
    gate,
    routeChatIdForConversation: (conversationId) =>
      conversationId === SHARED_CONVERSATION ? OWNER_ID : null,
    isPairedOwner: (senderId) => senderId === OWNER_ID,
    ...options.coordinator,
  });
  return { dock, auditLogger, gate, client, coordinator };
}

function press(data: string, senderId: string = OWNER_ID): TelegramCallbackQueryEnvelope {
  return { provider: "telegram", callbackQueryId: "press-1", senderId, data };
}

/** The two opaque tokens minted for the first card the fake client sent. */
async function sentCardTokens(client: ReturnType<typeof fakeDecisionCardClient>): Promise<{
  approveToken: string;
  denyToken: string;
}> {
  await vi.waitFor(() => expect(client.sendDecisionCard).toHaveBeenCalled());
  const call = client.sendDecisionCard.mock.calls[0] as unknown as [
    string,
    string,
    readonly { label: string; callbackData: string }[],
  ];
  const [approve, deny] = call[2];
  return { approveToken: approve!.callbackData, denyToken: deny!.callbackData };
}

/** Desk echo material for the newest dock payload, to answer locally. */
function deskEcho(dock: ReturnType<typeof deskDock>, choice: ApprovalDecision["choice"]): ApprovalDecision {
  const request = dock.sent[dock.sent.length - 1]!;
  return {
    requestId: request.id,
    choice,
    nonce: request.nonce as string,
    hmac: request.hmac as string,
  };
}

describe("telegram remote approval", () => {
  it("resolves the waiting turn as allow-once when the owner presses approve", async () => {
    const { auditLogger, gate, client, coordinator } = remoteApprovalHarness();
    const waiting = gate.requestAndWait(approvalAsk());
    const { approveToken } = await sentCardTokens(client);

    // The card carries only the coarse tool identifier and fixed host text.
    expect(client.sendDecisionCard).toHaveBeenCalledWith(
      OWNER_ID,
      `LVIS: tool ${TOOL_IDENTIFIER} is waiting for approval. This decides this run only.`,
      [
        { label: "Approve once", callbackData: approveToken },
        expect.objectContaining({ label: "Deny" }),
      ],
    );
    // Opaque token only: no request id, tool name, or conversation id inside.
    expect(approveToken).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    expect(approveToken).not.toContain("remote-req-1");
    expect(approveToken).not.toContain(SHARED_CONVERSATION);

    await coordinator.handleCallbackQuery(press(approveToken));

    const decision = await waiting;
    expect(decision.choice).toBe("allow-once");
    expect(isHostApprovalTimeoutDecision(decision)).toBe(false);
    expect(client.answerCallbackQuery).toHaveBeenCalledWith("press-1", "Approved for this run");
    await vi.waitFor(() => expect(client.editMessageText).toHaveBeenCalledWith(
      OWNER_ID,
      42,
      `LVIS: tool ${TOOL_IDENTIFIER} approved for this run`,
    ));

    // The gate's own audit chokepoint recorded the remote answerer.
    const decided = auditRowTexts(auditLogger).find((row) => row.includes("[approval:decided]"));
    expect(decided).toContain("answeredBy=platform-bridge");
    expect(decided).toContain("choice=allow-once");
  });

  it("denies the tool when the owner presses deny", async () => {
    const { gate, client, coordinator } = remoteApprovalHarness();
    const waiting = gate.requestAndWait(approvalAsk());
    const { denyToken } = await sentCardTokens(client);

    await coordinator.handleCallbackQuery(press(denyToken));

    const decision = await waiting;
    expect(decision.choice).toBe("deny-once");
    expect(client.answerCallbackQuery).toHaveBeenCalledWith("press-1", "Denied");
    await vi.waitFor(() => expect(client.editMessageText).toHaveBeenCalledWith(
      OWNER_ID,
      42,
      `LVIS: tool ${TOOL_IDENTIFIER} denied`,
    ));
  });

  it("only acknowledges a press from anyone but the paired owner", async () => {
    const { gate, client, coordinator } = remoteApprovalHarness();
    const waiting = gate.requestAndWait(approvalAsk());
    const { approveToken } = await sentCardTokens(client);

    await coordinator.handleCallbackQuery(press(approveToken, STRANGER_ID));

    // Acknowledged without text — a reply would confirm a live desktop — and
    // nothing resolved: the approval is still pending for the owner.
    expect(client.answerCallbackQuery).toHaveBeenCalledWith("press-1", undefined);
    expect(client.editMessageText).not.toHaveBeenCalled();

    await coordinator.handleCallbackQuery(press(approveToken));
    await expect(waiting).resolves.toMatchObject({ choice: "allow-once" });
  });

  it("expires the card with the gate timeout and answers a late press as stale", async () => {
    const { gate, client, coordinator } = remoteApprovalHarness({ timeoutMs: 40 });
    const waiting = gate.requestAndWait(approvalAsk());
    const { approveToken } = await sentCardTokens(client);

    const decision = await waiting;
    expect(isHostApprovalTimeoutDecision(decision)).toBe(true);
    expect(decision.choice).toBe("deny-once");
    await vi.waitFor(() => expect(client.editMessageText).toHaveBeenCalledWith(
      OWNER_ID,
      42,
      `LVIS: the approval for tool ${TOOL_IDENTIFIER} is no longer active`,
    ));

    // The token died with the card: a late press can no longer decide anything.
    await coordinator.handleCallbackQuery(press(approveToken));
    expect(client.answerCallbackQuery)
      .toHaveBeenCalledWith("press-1", "This approval is no longer active");
  });

  it("keeps a local desk decision and answers the late remote press as stale", async () => {
    const { dock, gate, client, coordinator } = remoteApprovalHarness();
    const waiting = gate.requestAndWait(approvalAsk());
    const { approveToken } = await sentCardTokens(client);

    // The desk answers first, through the same chokepoint the dock IPC uses.
    gate.resolve("remote-req-1", deskEcho(dock, "deny-once"));
    await expect(waiting).resolves.toMatchObject({ choice: "deny-once" });
    await vi.waitFor(() => expect(client.editMessageText).toHaveBeenCalledWith(
      OWNER_ID,
      42,
      `LVIS: tool ${TOOL_IDENTIFIER} denied`,
    ));

    // The remote press arrives late: harmlessly ignored, and the desk's
    // decision — a DENY — is not flipped by the approve button.
    await coordinator.handleCallbackQuery(press(approveToken));
    expect(client.answerCallbackQuery)
      .toHaveBeenCalledWith("press-1", "This approval is no longer active");
  });

  it("ignores the desk's late answer after the remote decision settled first", async () => {
    const { dock, gate, client, coordinator } = remoteApprovalHarness();
    const waiting = gate.requestAndWait(approvalAsk());
    const { approveToken } = await sentCardTokens(client);
    const lateDeskAnswer = deskEcho(dock, "deny-once");

    await coordinator.handleCallbackQuery(press(approveToken));
    await expect(waiting).resolves.toMatchObject({ choice: "allow-once" });

    // The dock click lands after the remote press: nothing left to resolve.
    expect(gate.resolve("remote-req-1", lateDeskAnswer)).toBeNull();
  });

  it("offers no card outside the single policy chokepoint's terms", async () => {
    const excluded: readonly [string, Partial<ApprovalRequestInput>][] = [
      ["no conversation attribution", { sessionId: undefined }],
      ["conversation not currently routed", { sessionId: "some-other-conversation" }],
      ["request refuses a one-shot choice", { allowedChoices: ["allow-once", "allow-always"] }],
      ["tool identifier outside the shared grammar", { toolName: "bad tool name" }],
    ];
    for (const [name, overrides] of excluded) {
      const { dock, gate, client } = remoteApprovalHarness();
      const waiting = gate.requestAndWait(approvalAsk(overrides));
      await vi.waitFor(() => expect(dock.sent.length, name).toBeGreaterThan(0));

      // The desk was asked; the phone was not.
      expect(client.sendDecisionCard, name).not.toHaveBeenCalled();
      gate.resolve("remote-req-1", deskEcho(dock, "deny-once"));
      await waiting;
    }
  });

  it("retires live cards on dispose and only acknowledges presses after it", async () => {
    const { dock, gate, client, coordinator } = remoteApprovalHarness();
    const waiting = gate.requestAndWait(approvalAsk());
    const { approveToken } = await sentCardTokens(client);

    coordinator.dispose();

    // Buttons that can no longer reach a handler stop looking pressable.
    await vi.waitFor(() => expect(client.editMessageText).toHaveBeenCalledWith(
      OWNER_ID,
      42,
      `LVIS: the approval for tool ${TOOL_IDENTIFIER} is no longer active`,
    ));
    await coordinator.handleCallbackQuery(press(approveToken));
    expect(client.answerCallbackQuery).toHaveBeenCalledWith("press-1", undefined);

    // The approval itself is untouched: the desk still owns the decision.
    gate.resolve("remote-req-1", deskEcho(dock, "allow-once"));
    await expect(waiting).resolves.toMatchObject({ choice: "allow-once" });
  });
});
