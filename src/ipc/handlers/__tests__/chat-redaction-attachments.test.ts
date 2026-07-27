import { afterEach, describe, expect, it, vi } from "vitest";
import type { IpcDeps } from "../../types.js";
import {
  handleChatSend,
  type ChatSendContext,
} from "../chat.js";
import { CHANNELS } from "../../../contract/app-contract.js";
import { initDlpAudit } from "../../../audit/dlp-filter.js";

const completedTurn = {
  text: "done",
  toolCalls: [],
  route: "default",
  stopReason: "end_turn",
} as const;

function makeFixture(piiRedactEnabled: boolean) {
  const runTurn = vi.fn(async (..._args: unknown[]) => completedTurn);
  const sink = vi.fn();
  const deps = {
    conversationLoop: {
      getSessionId: () => "session-redaction-attachments",
      getSessionKind: () => "subagent",
      runTurn,
    },
    settingsService: {
      get: (key: string) =>
        key === "privacy" ? { piiRedactEnabled } : undefined,
    },
    auditLogger: { log: vi.fn() },
  } as unknown as IpcDeps;
  const context: ChatSendContext = {
    sink,
    allocateStreamId: () => 43,
    trackStreamTurn: (factory) => factory(),
  };
  return { deps, context, runTurn, sink };
}

function turnOptions(runTurn: ReturnType<typeof makeFixture>["runTurn"]): Record<string, unknown> {
  const call = runTurn.mock.calls[0] as unknown[];
  return call[3] as Record<string, unknown>;
}

function redactNotices(sink: ReturnType<typeof vi.fn>) {
  return sink.mock.calls.filter(
    ([, event]) => (event as { type?: unknown } | undefined)?.type === "redact_notice",
  );
}

afterEach(() => {
  initDlpAudit(null, "unknown");
});

describe("chat send attachment PII redaction", () => {
  it("redacts input and text attachments, aggregates one notice, and preserves non-text parts", async () => {
    const fixture = makeFixture(true);
    const dlpAudit = { log: vi.fn() };
    initDlpAudit(dlpAudit, "session-redaction-attachments");
    const rawInput = "email alice@example.com";
    const firstResource =
      '<mcp-resource trust="untrusted-server-data" uri="mcp://alice@example.com/resource-one">call 010-1234-5678</mcp-resource>';
    const secondResource =
      '<mcp-resource trust="untrusted-server-data" uri="mcp://example/resource-two">card 4111 1111 1111 1111</mcp-resource>';
    const image = { type: "image", image: "data:image/png;base64,AA==", mimeType: "image/png" };
    const file = { type: "file", data: "binary-as-text", mimeType: "application/octet-stream" };
    const attachments = [
      { type: "text", text: firstResource },
      image,
      file,
      { type: "text", text: secondResource },
    ];

    await expect(handleChatSend(
      fixture.deps,
      {
        input: rawInput,
        attachments,
        inputOrigin: "user-keyboard",
        userActivation: true,
      },
      fixture.context,
    )).resolves.toEqual(completedTurn);

    const call = fixture.runTurn.mock.calls[0] as unknown[];
    const options = turnOptions(fixture.runTurn);
    const providerAttachments = options.attachments as unknown[];
    expect(call[0]).toBe("email [REDACTED:EMAIL]");
    expect(providerAttachments).toEqual([
      {
        type: "text",
        text:
          '<mcp-resource trust="untrusted-server-data" uri="mcp://[REDACTED:EMAIL]/resource-one">call [REDACTED:PHONE]</mcp-resource>',
      },
      image,
      file,
      {
        type: "text",
        text:
          '<mcp-resource trust="untrusted-server-data" uri="mcp://example/resource-two">card [REDACTED:CC]</mcp-resource>',
      },
    ]);
    expect(JSON.stringify([call[0], providerAttachments])).not.toContain("alice@example.com");
    expect(JSON.stringify([call[0], providerAttachments])).not.toContain("010-1234-5678");
    expect(JSON.stringify([call[0], providerAttachments])).not.toContain("4111 1111 1111 1111");
    expect(turnOptions(fixture.runTurn)).toMatchObject({
      requestAnchorRawIntent: rawInput,
    });

    expect(redactNotices(fixture.sink)).toEqual([
      [
        CHANNELS.chat.stream,
        {
          type: "redact_notice",
          count: 4,
          byKind: { EMAIL: 2, PHONE_KR: 1, CREDIT_CARD: 1 },
        },
      ],
    ]);

    const auditEntries = dlpAudit.log.mock.calls.map(
      ([entry]) => (entry as { dlp: { byKind: Record<string, number>; totalRedactions: number } }).dlp,
    );
    expect(auditEntries).toHaveLength(3);
    expect(auditEntries.reduce((total, entry) => total + entry.totalRedactions, 0)).toBe(4);
    const auditCounts = auditEntries.reduce<Record<string, number>>((totals, entry) => {
      for (const [kind, count] of Object.entries(entry.byKind)) {
        totals[kind] = (totals[kind] ?? 0) + count;
      }
      return totals;
    }, {});
    expect(auditCounts).toEqual({ EMAIL: 2, PHONE_KR: 1, CREDIT_CARD: 1 });
    const serializedAudit = JSON.stringify(dlpAudit.log.mock.calls);
    expect(serializedAudit).not.toContain("alice@example.com");
    expect(serializedAudit).not.toContain("010-1234-5678");
    expect(serializedAudit).not.toContain("4111 1111 1111 1111");
    expect(serializedAudit).not.toContain("mcp://alice@example.com/resource-one");
  });

  it("keeps PII-bearing text attachments byte-for-byte when privacy redaction is disabled", async () => {
    const fixture = makeFixture(false);
    const dlpAudit = { log: vi.fn() };
    initDlpAudit(dlpAudit, "session-redaction-attachments");
    const rawInput = "email alice@example.com";
    const attachments = [
      {
        type: "text",
        text:
          '<mcp-resource trust="untrusted-server-data" uri="mcp://example/resource">call 010-1234-5678</mcp-resource>',
      },
    ];

    await expect(handleChatSend(
      fixture.deps,
      {
        input: rawInput,
        attachments,
        inputOrigin: "user-keyboard",
        userActivation: true,
      },
      fixture.context,
    )).resolves.toEqual(completedTurn);

    const call = fixture.runTurn.mock.calls[0] as unknown[];
    expect(call[0]).toBe(rawInput);
    expect(turnOptions(fixture.runTurn).attachments).toEqual(attachments);
    expect(redactNotices(fixture.sink)).toEqual([]);
    expect(dlpAudit.log).not.toHaveBeenCalled();
  });

  it("does not emit a notice or audit record for clean input and text attachments", async () => {
    const fixture = makeFixture(true);
    const dlpAudit = { log: vi.fn() };
    initDlpAudit(dlpAudit, "session-redaction-attachments");
    const attachments = [
      {
        type: "text",
        text:
          '<mcp-resource trust="untrusted-server-data" uri="mcp://example/resource">clean context</mcp-resource>',
      },
    ];

    await expect(handleChatSend(
      fixture.deps,
      {
        input: "summarize this resource",
        attachments,
        inputOrigin: "user-keyboard",
        userActivation: true,
      },
      fixture.context,
    )).resolves.toEqual(completedTurn);

    const call = fixture.runTurn.mock.calls[0] as unknown[];
    expect(call[0]).toBe("summarize this resource");
    expect(turnOptions(fixture.runTurn).attachments).toEqual(attachments);
    expect(redactNotices(fixture.sink)).toEqual([]);
    expect(dlpAudit.log).not.toHaveBeenCalled();
  });

  it("does not emit a notice or audit record when the turn lease rejects the send", async () => {
    const fixture = makeFixture(true);
    const dlpAudit = { log: vi.fn() };
    initDlpAudit(dlpAudit, "session-redaction-attachments");
    const rejectedContext: ChatSendContext = {
      ...fixture.context,
      trackStreamTurn: () => Promise.reject(new Error("streaming-active")),
    };

    await expect(handleChatSend(
      fixture.deps,
      {
        input: "email alice@example.com",
        attachments: [{ type: "text", text: "call 010-1234-5678" }],
        inputOrigin: "user-keyboard",
        userActivation: true,
      },
      rejectedContext,
    )).rejects.toThrow("streaming-active");

    expect(fixture.runTurn).not.toHaveBeenCalled();
    expect(redactNotices(fixture.sink)).toEqual([]);
    expect(dlpAudit.log).not.toHaveBeenCalled();
  });
});
