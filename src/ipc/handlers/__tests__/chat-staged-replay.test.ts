/**
 * Staged provenance survives the REPLAY paths.
 *
 * `chat:send` binds a staged origin to its envelope, but three internal paths
 * re-send text that is already in history — edit-resend, continue-last-user, and
 * retry-effort — and they all go through `runStreamedTurn` with
 * `STREAM_TURN_OPTIONS` (`inputOrigin: "user-keyboard"`), never through the send
 * gate. A staged turn's stored user message IS its envelope, so if the origin were
 * taken from that claim, one click on "continue" would re-run server- or
 * plugin-authored text as a genuine user turn: force-ask off, no untrusted framing
 * for the model, and a normal user bubble in the transcript.
 *
 * These pin the derivation (from the TEXT) and the fail-closed case (a staged claim
 * whose envelope did not survive, e.g. DLP rewriting the fence header).
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
    await runStreamedTurn(loop, "summarize the repo", vi.fn(), 1, STREAM_TURN_OPTIONS);
    expect(turnOptions(runTurn)).toMatchObject({ inputOrigin: "user-keyboard" });
    expect(turnOptions(runTurn).originSource).toBeUndefined();
  });

  for (const kind of STAGED_ORIGIN_KINDS) {
    const source = sampleSource[kind.inputOrigin]!;

    it(`re-derives ${kind.inputOrigin} from the envelope when the replay claims user-keyboard`, async () => {
      const { loop, runTurn } = makeLoop();
      const stored = formatStagedEnvelope(kind, "do the staged thing", source);

      // Exactly what continue-last-user / retry-effort do: the stored history text,
      // under the host's default keyboard claim.
      await runStreamedTurn(loop, stored, vi.fn(), 1, STREAM_TURN_OPTIONS);

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
        runStreamedTurn(loop, "envelope was stripped", vi.fn(), 1, {
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
    await runStreamedTurn(loop, stored, vi.fn(), 1, { inputOrigin: first!.inputOrigin });

    expect(turnOptions(runTurn)).toMatchObject({
      inputOrigin: second!.inputOrigin,
      originSource: sampleSource[second!.inputOrigin],
    });
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
    await runStreamedTurn(loop, "summarize [Resource #1]", () => {}, 1, {
      ...STREAM_TURN_OPTIONS,
      displayText: "summarize [Resource #1]",
    });
    expect(turnOptions(runTurn).displayText).toBe("summarize [Resource #1]");
  });

  it("adds no displayText when the caller supplies none", async () => {
    // Without this, a version that always set the field would satisfy the case above
    // while quietly giving every ordinary turn a second copy of its own text.
    const { loop, runTurn } = makeLoop();
    await runStreamedTurn(loop, "an ordinary question", () => {}, 1, {
      ...STREAM_TURN_OPTIONS,
    });
    expect(turnOptions(runTurn)).not.toHaveProperty("displayText");
  });
});
