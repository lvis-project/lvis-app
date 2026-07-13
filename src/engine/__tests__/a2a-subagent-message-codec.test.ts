import { describe, expect, it } from "vitest";
import {
  A2A_ROLE_AGENT,
  A2A_ROLE_UNSPECIFIED,
  A2A_ROLE_USER,
  type A2AMessage,
} from "../../shared/a2a.js";
import { canonicalizeInboundA2ASubAgentMessage } from "../a2a-subagent-message-codec.js";
import {
  GUIDE_MAX_CHARS,
  GUIDE_MAX_ENTRIES,
} from "../turn/guidance-limits.js";

function makeMessage(overrides: Partial<A2AMessage> = {}): A2AMessage {
  return {
    messageId: "wire-message-1",
    role: A2A_ROLE_USER,
    parts: [{ text: "Please inspect the workspace." }],
    ...overrides,
  };
}

describe("canonicalizeInboundA2ASubAgentMessage", () => {
  it("DLP-canonicalizes every supported Part and metadata surface before returning", () => {
    const secretToken = "sk-abcdefgh12345678";
    const email = "owner@example.com";
    const phone = "010-1234-5678";
    const bearer = "Bearer wiresecret123";
    const querySecret = "wirequerysecret";
    const result = canonicalizeInboundA2ASubAgentMessage(makeMessage({
      parts: [
        {
          text: "Use " + secretToken,
          metadata: { [email]: phone },
        },
        {
          url: "https://example.test/report?token=" + querySecret,
          filename: email,
          mediaType: "text/plain; owner=" + email,
          metadata: { authorization: bearer },
        },
        {
          data: {
            card: "4111 1111 1111 1111",
            nested: { apiKey: secretToken },
          },
          metadata: { contact: email },
        },
      ],
      metadata: {
        audit: { authorization: bearer },
        contact: email,
      },
      extensions: [secretToken],
      referenceTaskIds: [email],
    }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const serialized = JSON.stringify(result.message);
    for (const secret of [
      secretToken,
      email,
      phone,
      bearer,
      querySecret,
      "4111 1111 1111 1111",
    ]) {
      expect(serialized).not.toContain(secret);
      expect(result.prompt).not.toContain(secret);
    }
    expect(serialized).toContain("[REDACTED:TOKEN]");
    expect(serialized).toContain("***@example.com");
    expect(serialized).toContain("010-****-****");
    expect(result.prompt).toContain("[file] ***@example.com:");
    expect(result.detectionCount).toBeGreaterThan(0);
  });

  it("keeps remote control-looking fields inert and never returns runner options", () => {
    const result = canonicalizeInboundA2ASubAgentMessage(makeMessage({
      parts: [{ text: "Perform the requested analysis." }],
      metadata: {
        origin: "remote-origin",
        title: "remote-title",
        cwd: "C:\\remote",
        tools: ["shell"],
        approvalReasonPrefix: "remote-prefix",
      },
    }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.prompt).toBe("Perform the requested analysis.");
    expect(Object.keys(result).sort()).toEqual([
      "detectionCount",
      "message",
      "ok",
      "prompt",
    ]);
    for (const value of [
      "remote-origin",
      "remote-title",
      "C:\\remote",
      "shell",
      "remote-prefix",
    ]) {
      expect(result.prompt).not.toContain(value);
    }
    expect(result).not.toHaveProperty("origin");
    expect(result).not.toHaveProperty("title");
    expect(result).not.toHaveProperty("cwd");
    expect(result).not.toHaveProperty("tools");
    expect(result).not.toHaveProperty("approvalReasonPrefix");
  });

  it("rejects non-user roles and top-level runner-control fields", () => {
    for (const role of [A2A_ROLE_AGENT, A2A_ROLE_UNSPECIFIED]) {
      expect(canonicalizeInboundA2ASubAgentMessage(makeMessage({ role }))).toEqual({
        ok: false,
        reason: "unsupported-role",
      });
    }

    for (const field of [
      "origin",
      "title",
      "cwd",
      "tools",
      "approvalReasonPrefix",
    ]) {
      expect(canonicalizeInboundA2ASubAgentMessage({
        ...makeMessage(),
        [field]: "remote-choice",
      })).toEqual({
        ok: false,
        reason: "invalid-message",
      });
    }
  });

  it("rejects raw, malformed, cyclic, and unsupported values without throwing", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const sparseExtensions = new Array<string>(1);

    const cases: Array<{
      message: unknown;
      reason: "invalid-message" | "unsupported-part";
    }> = [
      {
        message: makeMessage({ parts: [{ raw: "base64" }] }),
        reason: "unsupported-part",
      },
      {
        message: {
          ...makeMessage(),
          parts: [{ text: "one", data: { two: true } }],
        },
        reason: "invalid-message",
      },
      {
        message: {
          ...makeMessage(),
          parts: [{ text: "one", unexpected: true }],
        },
        reason: "invalid-message",
      },
      {
        message: makeMessage({ parts: [{ text: "one", metadata: [] as never }] }),
        reason: "invalid-message",
      },
      {
        message: makeMessage({ metadata: [] as never }),
        reason: "invalid-message",
      },
      {
        message: makeMessage({ parts: [{ data: cyclic as never }] }),
        reason: "invalid-message",
      },
      {
        message: makeMessage({ parts: [{ data: { missing: undefined } as never }] }),
        reason: "invalid-message",
      },
      {
        message: makeMessage({ extensions: sparseExtensions }),
        reason: "invalid-message",
      },
      {
        message: makeMessage({ parts: [{ text: "   " }] }),
        reason: "invalid-message",
      },
    ];

    for (const testCase of cases) {
      expect(() => canonicalizeInboundA2ASubAgentMessage(testCase.message)).not.toThrow();
      expect(canonicalizeInboundA2ASubAgentMessage(testCase.message)).toEqual({
        ok: false,
        reason: testCase.reason,
      });
    }

    const hostile = new Proxy({}, {
      ownKeys: () => {
        throw new Error("hostile proxy");
      },
    });
    expect(canonicalizeInboundA2ASubAgentMessage(hostile)).toEqual({
      ok: false,
      reason: "invalid-message",
    });
  });

  it("enforces shared prompt, serialized-message, and Part-count bounds", () => {
    const nearLimit = "x".repeat(GUIDE_MAX_CHARS - 200);
    const accepted = canonicalizeInboundA2ASubAgentMessage(makeMessage({
      parts: [{ text: nearLimit }],
    }));
    expect(accepted.ok).toBe(true);
    if (accepted.ok) {
      expect(accepted.prompt).toBe(nearLimit);
      expect(accepted.prompt.length).toBeLessThanOrEqual(GUIDE_MAX_CHARS);
    }

    expect(canonicalizeInboundA2ASubAgentMessage(makeMessage({
      parts: [{ text: "x".repeat(GUIDE_MAX_CHARS + 1) }],
    }))).toEqual({
      ok: false,
      reason: "message-too-long",
    });

    expect(canonicalizeInboundA2ASubAgentMessage(makeMessage({
      metadata: { padding: "x".repeat(GUIDE_MAX_CHARS) },
    }))).toEqual({
      ok: false,
      reason: "message-too-long",
    });

    expect(canonicalizeInboundA2ASubAgentMessage(makeMessage({
      parts: Array.from(
        { length: GUIDE_MAX_ENTRIES + 1 },
        (_, index) => ({ text: String(index) }),
      ) as A2AMessage["parts"],
    }))).toEqual({
      ok: false,
      reason: "invalid-message",
    });
  });
});