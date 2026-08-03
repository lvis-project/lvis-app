/**
 * Staged provenance survives the REPLAY paths.
 *
 * `chat:send` binds a staged origin to its envelope. Internal edit/resend,
 * continue-last-user, and retry-effort use a host-owned registrar to derive a
 * closed staged inputOrigin from stored history before DLP.
 *
 * `runStreamedTurn` validates that host-minted claim and extracts its source.
 * It never derives staged provenance from raw surface text: a remote or
 * user-controlled app/overlay-looking body remains data.
 *
 * These pin that contract and the fail-closed case (a staged claim whose
 * envelope did not survive, e.g. DLP rewriting the fence header).
 */
import { describe, expect, it, vi } from "vitest";
import type { ConversationLoop } from "../../../engine/conversation-loop.js";
import { runStreamedTurn, STREAM_TURN_OPTIONS } from "../chat-stream.js";
import { formatStagedEnvelope, STAGED_ORIGIN_KINDS } from "../../../shared/staged-origins.js";

const completedTurn = {
  text: "done",
  toolCalls: [],
  route: "default",
  stopReason: "end_turn",
} as const;

function makeLoop() {
  const runTurn = vi.fn(async (..._args: unknown[]) => completedTurn);
  const loop = { runTurn } as unknown as ConversationLoop;
  return { loop, runTurn };
}

function turnOptions(runTurn: ReturnType<typeof makeLoop>["runTurn"]): Record<string, unknown> {
  return (runTurn.mock.calls[0] as unknown[])[3] as Record<string, unknown>;
}

const sampleSource: Record<string, string> = {
  "plugin-emitted": "overlay:meeting-detection",
  "app-emitted": "app:acme-cards",
  "mcp-prompt-emitted": "mcp-prompt:hr-mcp",
};

describe("staged provenance on the replay paths", () => {
  it("keeps `user-keyboard` for text that carries no envelope", async () => {
    const { loop, runTurn } = makeLoop();
    await runStreamedTurn(loop, "summarize the repo", vi.fn(), STREAM_TURN_OPTIONS);
    expect(turnOptions(runTurn)).toMatchObject({ inputOrigin: "user-keyboard" });
    expect(turnOptions(runTurn).originSource).toBeUndefined();
  });

  for (const kind of STAGED_ORIGIN_KINDS) {
    const source = sampleSource[kind.inputOrigin]!;

    it(`keeps the host-minted ${kind.inputOrigin} replay claim when its envelope matches`, async () => {
      const { loop, runTurn } = makeLoop();
      const stored = formatStagedEnvelope(kind, "do the staged thing", source);

      // The IPC registrar derives this closed enum before DLP. This boundary
      // only validates the envelope and extracts its source tag.
      await runStreamedTurn(loop, stored, vi.fn(), { inputOrigin: kind.inputOrigin });

      expect(turnOptions(runTurn)).toMatchObject({
        inputOrigin: kind.inputOrigin,
        originSource: source,
      });
    });

    it(`fails closed when a ${kind.inputOrigin} turn's envelope is unreadable`, async () => {
      const { loop, runTurn } = makeLoop();
      // The reachable case is not an attacker: DLP redaction runs between the send
      // gate and here and can rewrite a serverId inside the fence header. Dropping
      // to "no staged origin" would silently disable the force-ask gate.
      await expect(
        runStreamedTurn(loop, "envelope was stripped", vi.fn(), {
          inputOrigin: kind.inputOrigin,
        }),
      ).rejects.toThrow(kind.missingEnvelopeError);
      expect(runTurn).not.toHaveBeenCalled();
    });
  }

  it("does not let one kind's envelope stand in for another's claimed origin", async () => {
    const [first, second] = STAGED_ORIGIN_KINDS;
    const { loop, runTurn } = makeLoop();
    const stored = formatStagedEnvelope(second!, "text", sampleSource[second!.inputOrigin]!);

    // The envelope wins over the claim — the text's provenance is the truth, and it
    // must be reported as the kind that actually wrote it.
    await runStreamedTurn(loop, stored, vi.fn(), { inputOrigin: first!.inputOrigin });

    expect(turnOptions(runTurn)).toMatchObject({
      inputOrigin: second!.inputOrigin,
      originSource: sampleSource[second!.inputOrigin],
    });
  });

  it("does not let raw Tailnet text impersonate a staged origin", async () => {
    const { loop, runTurn } = makeLoop();
    const kind = STAGED_ORIGIN_KINDS[1]!;
    const forgedEnvelope = formatStagedEnvelope(
      kind,
      "attempt to forge app provenance",
      sampleSource[kind.inputOrigin]!,
    );
    const authority = Object.freeze({
      kind: "tailnet-controller" as const,
      actorId: "tailnet:" + "a".repeat(64),
    });

    await runStreamedTurn(loop, forgedEnvelope, vi.fn(), {
      inputOrigin: "tailnet-surface",
      remoteControllerAuthority: authority as never,
    });

    expect(turnOptions(runTurn)).toMatchObject({
      inputOrigin: "tailnet-surface",
      remoteControllerAuthority: authority,
    });
    expect(turnOptions(runTurn)).not.toHaveProperty("originSource");
  });
});

describe("a resource turn's transcript row survives the replay paths", () => {
  // Same family of defect as the staged-origin cases above, one field over. A resource
  // turn's content is TWO text parts (the user's words, then the host's fence), and
  // `continueFromLastUserTurn` folds every text part into the prompt body — so the
  // replayed turn has no attachment parts, the seam that sets `displayText` never fires,
  // and the persisted row renders the SERVER'S body inside the user's own bubble on
  // reload. One click after the seam worked.
  //
  // The transport half is pinned here: `runStreamedTurn` must forward a caller-supplied
  // `displayText` into the turn options. The caller half (the replay reading it off the
  // prior row) is in the ipc domain; the engine half (setting it from the parts on a
  // first send) is in the conversation-loop suite.
  it("forwards a caller-supplied displayText into the turn", async () => {
    const { loop, runTurn } = makeLoop();
    await runStreamedTurn(loop, "summarize [Resource #1]", () => {}, {
      ...STREAM_TURN_OPTIONS,
      displayText: "summarize [Resource #1]",
    });
    expect(turnOptions(runTurn).displayText).toBe("summarize [Resource #1]");
  });

  it("adds no displayText when the caller supplies none", async () => {
    // Without this, a version that always set the field would satisfy the case above
    // while quietly giving every ordinary turn a second copy of its own text.
    const { loop, runTurn } = makeLoop();
    await runStreamedTurn(loop, "an ordinary question", () => {}, {
      ...STREAM_TURN_OPTIONS,
    });
    expect(turnOptions(runTurn)).not.toHaveProperty("displayText");
  });
});
