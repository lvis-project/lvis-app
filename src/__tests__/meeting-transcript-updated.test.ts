/**
 * §35 STT transcript.updated per-chunk — host-side event bus + renderer bridge test.
 *
 * Verifies:
 *  1. meeting.transcript.updated is in the public event namespace (classifySubscription = "public")
 *  2. meeting plugin with "meeting-recorder" capability can emit meeting.transcript.updated
 *  3. Three simulated chunk events are received by an onEvent subscriber in order
 *  4. The webContents.send forwarding logic (§35 boot.ts wiring) is exercised end-to-end
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { emitEvent, onEvent, offEvent } from "../boot/types.js";
import { requiredCapabilityForEmit, classifySubscription } from "../plugins/capabilities.js";

/** Minimal capability-gated emitEvent stub (mirrors boot.ts §createHostApi) */
function makeStubEmitEvent(pluginId: string, capabilities: string[]) {
  return (type: string, data?: Record<string, unknown>) => {
    const requiredCap = requiredCapabilityForEmit(type);
    if (requiredCap && !capabilities.includes(requiredCap)) {
      return; // dropped — capability missing
    }
    emitEvent(type, { pluginId, ...(data ?? {}) });
  };
}

describe("meeting.transcript.updated — namespace + capability", () => {
  it("classifies meeting.transcript.updated as public", () => {
    expect(classifySubscription("meeting.transcript.updated")).toBe("public");
  });

  it("requires meeting-recorder capability to emit meeting.transcript.updated", () => {
    const requiredCap = requiredCapabilityForEmit("meeting.transcript.updated");
    expect(requiredCap).toBe("meeting-recorder");
  });
});

describe("meeting.transcript.updated — event bus delivery (3 chunks)", () => {
  const received: unknown[] = [];
  let unsubscribe: (() => void) | undefined;

  beforeEach(() => {
    received.length = 0;
    unsubscribe = onEvent("meeting.transcript.updated", (data) => {
      received.push(data);
    });
  });

  afterEach(() => {
    unsubscribe?.();
  });

  it("delivers 3 chunk events with increasing chunkIndex", () => {
    const emit = makeStubEmitEvent("meeting", ["meeting-recorder"]);

    for (let i = 0; i < 3; i++) {
      emit("meeting.transcript.updated", {
        meetingId: "sess-test",
        newSegmentIndex: i,
        newSegment: { original: `Chunk ${i} text`, isFinal: true },
        isFinal: false,
      });
    }

    expect(received.length).toBe(3);
    for (let i = 0; i < 3; i++) {
      const d = received[i] as { newSegmentIndex: number; isFinal: boolean; meetingId: string };
      expect(d.newSegmentIndex).toBe(i);
      expect(d.isFinal).toBe(false);
      expect(d.meetingId).toBe("sess-test");
    }
  });

  it("delivers isFinal: true event on stop", () => {
    const emit = makeStubEmitEvent("meeting", ["meeting-recorder"]);

    emit("meeting.transcript.updated", {
      meetingId: "sess-final",
      newSegmentIndex: 1,
      newSegment: { original: "Last chunk", isFinal: true },
      isFinal: true,
    });

    expect(received.length).toBe(1);
    const d = received[0] as { isFinal: boolean };
    expect(d.isFinal).toBe(true);
  });

  it("drops meeting.transcript.updated if plugin lacks meeting-recorder capability", () => {
    const emit = makeStubEmitEvent("rogue-plugin", []); // no capabilities

    emit("meeting.transcript.updated", {
      meetingId: "sess-rogue",
      newSegmentIndex: 0,
      newSegment: { original: "Should not arrive", isFinal: false },
      isFinal: false,
    });

    expect(received.length).toBe(0);
  });
});

describe("meeting.transcript.updated — webContents.send forwarding simulation", () => {
  it("subscriber receives event and would forward to renderer", () => {
    // Simulate what boot.ts §35 does: subscribe onEvent → call webContents.send
    const sentMessages: Array<{ channel: string; type: string; data: unknown }> = [];
    const mockWebContents = {
      isDestroyed: () => false,
      send: vi.fn((channel: string, type: string, data: unknown) => {
        sentMessages.push({ channel, type, data });
      }),
    };

    const unsub = onEvent("meeting.transcript.updated", (data) => {
      if (!mockWebContents.isDestroyed()) {
        mockWebContents.send("lvis:plugin:event", "meeting.transcript.updated", data);
      }
    });

    const emit = makeStubEmitEvent("meeting", ["meeting-recorder"]);
    emit("meeting.transcript.updated", { meetingId: "sess-ipc", newSegmentIndex: 0, newSegment: { original: "Hello" }, isFinal: false });
    emit("meeting.transcript.updated", { meetingId: "sess-ipc", newSegmentIndex: 1, newSegment: { original: "World" }, isFinal: false });
    emit("meeting.transcript.updated", { meetingId: "sess-ipc", newSegmentIndex: 2, newSegment: { original: "Final" }, isFinal: true });

    unsub();

    expect(mockWebContents.send).toHaveBeenCalledTimes(3);
    expect(sentMessages[0]!.channel).toBe("lvis:plugin:event");
    expect(sentMessages[0]!.type).toBe("meeting.transcript.updated");
    const d0 = sentMessages[0]!.data as { newSegmentIndex: number; newSegment: { original: string } };
    expect(d0.newSegmentIndex).toBe(0);
    expect(d0.newSegment.original).toBe("Hello");
    const d2 = sentMessages[2]!.data as { isFinal: boolean };
    expect(d2.isFinal).toBe(true);
  });
});
