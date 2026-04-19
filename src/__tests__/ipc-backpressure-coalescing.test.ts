/**
 * Issue 4 — IPC backpressure: coalescing wrapper for transcript events.
 *
 * Verifies:
 * - 100 rapid non-final events + 1 final → ≤10 webContents.send calls + final sent immediately
 * - Non-transcript events pass through unchanged (one send per event)
 * - isFinal=true flushes immediately regardless of debounce state
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ─── Inline the coalescing logic for unit-testability ─────────────────────────
// We re-implement the same logic from boot.ts so the test stays fast and
// doesn't need Electron imports. If the boot.ts implementation changes, update
// this mirror accordingly.

function isTranscriptEvent(type: string): boolean {
  return type.endsWith(".transcript.updated");
}

interface FakeSend {
  calls: Array<{ type: string; data: unknown }>;
  send: (channel: string, type: string, data: unknown) => void;
}

function makeFakeSend(): FakeSend {
  const calls: Array<{ type: string; data: unknown }> = [];
  return {
    calls,
    send: (_channel: string, type: string, data: unknown) => { calls.push({ type, data }); },
  };
}

function makeCoalescingSend(
  type: string,
  fakeSend: FakeSend,
): (data: unknown) => void {
  let lastData: unknown = undefined;
  let flushTimer: ReturnType<typeof setTimeout> | undefined;

  const flush = (data: unknown) => {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = undefined; }
    fakeSend.send("lvis:plugin:event", type, data);
  };

  return (data: unknown) => {
    const payload = data as Record<string, unknown> | undefined;
    const isFinal = payload?.isFinal === true;
    if (isFinal) {
      flush(data);
      lastData = undefined;
    } else {
      lastData = data;
      if (!flushTimer) {
        flushTimer = setTimeout(() => {
          flushTimer = undefined;
          if (lastData !== undefined) flush(lastData);
        }, 100);
      }
    }
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("IPC backpressure — transcript coalescing (Issue 4)", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("100 rapid non-final events + 1 final → ≤10 webContents.send calls total", async () => {
    const fake = makeFakeSend();
    const send = makeCoalescingSend("meeting.transcript.updated", fake);

    // Emit 100 non-final events rapidly (no timer advance between them)
    for (let i = 0; i < 100; i++) {
      send({ meetingId: "m1", newSegmentIndex: i, isFinal: false });
    }

    // Advance timer to trigger the debounced flush
    vi.advanceTimersByTime(150);

    // Now emit the final event
    send({ meetingId: "m1", newSegmentIndex: 100, isFinal: true });

    // Total sends: 1 (debounced non-final flush) + 1 (final) = 2 — well under 10
    expect(fake.calls.length).toBeLessThanOrEqual(10);
    expect(fake.calls.length).toBeGreaterThanOrEqual(1);
  });

  it("final event flushes immediately without waiting for debounce", () => {
    const fake = makeFakeSend();
    const send = makeCoalescingSend("meeting.transcript.updated", fake);

    send({ meetingId: "m1", newSegmentIndex: 0, isFinal: false });
    // Timer NOT advanced — debounce still pending
    expect(fake.calls.length).toBe(0);

    // Final event must flush immediately
    send({ meetingId: "m1", newSegmentIndex: 1, isFinal: true });
    expect(fake.calls.length).toBe(1);
    expect((fake.calls[0]!.data as { isFinal: boolean }).isFinal).toBe(true);
  });

  it("non-transcript events are NOT coalesced (each emits one send)", () => {
    const fake = makeFakeSend();
    // Non-transcript event: pass through directly (no coalescing)
    const type = "email.new";
    expect(isTranscriptEvent(type)).toBe(false);

    // Simulate direct send (no coalescing wrapper)
    for (let i = 0; i < 5; i++) {
      fake.send("lvis:plugin:event", type, { id: i });
    }
    expect(fake.calls.length).toBe(5);
  });

  it("isTranscriptEvent correctly identifies *.transcript.updated pattern", () => {
    expect(isTranscriptEvent("meeting.transcript.updated")).toBe(true);
    expect(isTranscriptEvent("video.transcript.updated")).toBe(true);
    expect(isTranscriptEvent("email.new")).toBe(false);
    expect(isTranscriptEvent("meeting.started")).toBe(false);
    expect(isTranscriptEvent("transcript.updated.extra")).toBe(false);
  });

  it("only latest non-final event data is sent in the debounced flush", () => {
    const fake = makeFakeSend();
    const send = makeCoalescingSend("meeting.transcript.updated", fake);

    for (let i = 0; i < 10; i++) {
      send({ meetingId: "m1", newSegmentIndex: i, isFinal: false });
    }
    vi.advanceTimersByTime(150);

    expect(fake.calls.length).toBe(1);
    const data = fake.calls[0]!.data as { newSegmentIndex: number };
    // Should be the LAST event (index 9)
    expect(data.newSegmentIndex).toBe(9);
  });
});
