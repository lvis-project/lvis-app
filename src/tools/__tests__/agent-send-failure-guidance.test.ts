/**
 * A refused `agent_send` has to say what to do instead.
 *
 * Sends are refused for real reasons — the recipient is idle, finished, or not
 * addressable from here — and the refusal is explicit rather than silent. But
 * the result was a bare `{"error":"recipient-unavailable"}`, which tells the
 * model that something failed and nothing about the alternative. That is how a
 * refusal turns into a guess: re-sending in a loop, or asking for a replacement
 * sub-agent when the existing one is merely idle.
 *
 * `agent_guide` and `agent_spawn` both attach guidance to their failures. These
 * tests pin the same for the one A2A tool that lacked it, and — more usefully —
 * pin that the guidance stays exhaustive as reasons are added.
 */
import { describe, expect, it } from "vitest";

import {
  SEND_FAILURE_GUIDANCE,
  type AgentSendFailureReason,
} from "../agent-send.js";

const REASONS = Object.keys(SEND_FAILURE_GUIDANCE) as AgentSendFailureReason[];

describe("agent_send failure guidance", () => {
  it("covers every declared refusal reason", () => {
    // The union is the contract; this asserts the map has not drifted from it.
    // TypeScript already refuses a missing key, so this guards the runtime
    // shape (e.g. an entry emptied out during an edit).
    expect(REASONS.length).toBeGreaterThan(0);
    for (const reason of REASONS) {
      expect(SEND_FAILURE_GUIDANCE[reason].trim().length).toBeGreaterThan(0);
    }
  });

  it("tells a parent which tools DO work from a parent", () => {
    // The steering-critical case. A parent that reaches for agent_send must be
    // pointed at agent_guide / agent_spawn, or it falls back to spawning a
    // duplicate sub-agent — the behaviour this whole change exists to stop.
    const guidance = SEND_FAILURE_GUIDANCE["unknown-sender"];
    expect(guidance).toContain("agent_guide");
    expect(guidance).toContain("agent_spawn");
  });

  it("does not tell the model to retry a permanent refusal", () => {
    // "terminal-recipient" and "message-bus-unavailable" can never succeed
    // later; guidance that invites a retry would produce exactly the loop this
    // is meant to prevent.
    expect(SEND_FAILURE_GUIDANCE["terminal-recipient"]).toMatch(/never|already/i);
    expect(SEND_FAILURE_GUIDANCE["message-bus-unavailable"]).toMatch(/not retry|do not retry/i);
  });

  it("marks an idle recipient as a timing miss, not a failure to route around", () => {
    const guidance = SEND_FAILURE_GUIDANCE["recipient-unavailable"];
    expect(guidance).toMatch(/timing/i);
    // The specific wrong move this reason used to invite.
    expect(guidance).toMatch(/replacement agent|NOT re-send/i);
  });

  it("points a bad id at where the real id comes from", () => {
    const guidance = SEND_FAILURE_GUIDANCE["unknown-recipient"];
    expect(guidance).toMatch(/agent_list|agent_status/);
    // Agent names being mistaken for addresses is the actual failure mode here.
    expect(guidance).toMatch(/names are not addresses/i);
  });

  it("does not auto-retry after a deliberate stop", () => {
    expect(SEND_FAILURE_GUIDANCE.aborted).toMatch(/deliberate/i);
  });
});
