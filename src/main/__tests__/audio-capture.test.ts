/**
 * The host's audio capture service.
 *
 * The surface is stubbed rather than real, because what is under test is the
 * CONTRACT — what a caller may ask for, what it is told when it asked for
 * something impossible, and what happens to the one capture slot when a start
 * fails. A real microphone would prove Chromium works and nothing about any
 * of that.
 */
import { describe, expect, it, vi } from "vitest";
import {
  AudioCaptureError,
  AudioCaptureService,
  validateAudioCaptureRequest,
  type AudioCaptureEnd,
  type AudioCaptureFrame,
  type AudioCaptureSurface,
} from "../audio-capture.js";

const GOOD = { sampleRate: 16_000, frameMs: 200, microphone: true, systemAudio: true } as const;

/** A surface whose open/close outcomes the test decides. */
function stubSurface(
  opened: { microphone: boolean; systemAudio: boolean } = { microphone: true, systemAudio: true },
) {
  let emitFrame: ((frame: AudioCaptureFrame) => void) | null = null;
  let emitEnd: ((end: AudioCaptureEnd) => void) | null = null;
  const surface: AudioCaptureSurface & {
    frame: (frame: AudioCaptureFrame) => void;
    end: (end: AudioCaptureEnd) => void;
  } = {
    open: vi.fn(async ({ onFrame, onEnd }) => {
      emitFrame = onFrame;
      emitEnd = onEnd;
      return opened;
    }),
    close: vi.fn(async () => {}),
    listInputDevices: vi.fn(async () => [{ deviceId: "d1", label: "Built-in" }]),
    frame: (frame) => emitFrame?.(frame),
    end: (end) => emitEnd?.(end),
  };
  return surface;
}

const frameOf = (seq: number): AudioCaptureFrame => ({ seq, pcm: new Uint8Array([1, 2]), peak: 0.5 });

describe("validateAudioCaptureRequest", () => {
  it.each([
    [{ ...GOOD, sampleRate: 96_000 }, /sampleRate/u],
    [{ ...GOOD, sampleRate: 16_000.5 }, /sampleRate/u],
    [{ ...GOOD, frameMs: 5 }, /frameMs/u],
    [{ ...GOOD, frameMs: 5_000 }, /frameMs/u],
    [{ ...GOOD, microphone: false, systemAudio: false }, /microphone, system audio, or both/u],
    [{ ...GOOD, microphoneDeviceId: "" }, /non-empty string/u],
    [{ ...GOOD, microphone: false, microphoneDeviceId: "d1" }, /microphone is false/u],
  ])("refuses %o", (request, message) => {
    // Refused, not clamped. A caller handed a quietly-adjusted sample rate
    // writes the rate it ASKED for into its own headers and produces audio
    // that plays at the wrong speed.
    expect(() => validateAudioCaptureRequest(request)).toThrow(message);
  });

  it("normalizes an absent device id to null rather than leaving it undefined", () => {
    // So every downstream reader sees one shape for "the OS default" instead
    // of two that compare differently.
    expect(validateAudioCaptureRequest(GOOD).microphoneDeviceId).toBeNull();
  });
});

describe("AudioCaptureService", () => {
  it("delivers frames to every subscriber and stops after an unsubscribe", async () => {
    const surface = stubSurface();
    const session = await new AudioCaptureService(surface).start(GOOD);
    const a: number[] = [];
    const b: number[] = [];
    session.onFrame((f) => a.push(f.seq));
    const off = session.onFrame((f) => b.push(f.seq));

    surface.frame(frameOf(0));
    off();
    surface.frame(frameOf(1));

    expect(a).toEqual([0, 1]);
    expect(b).toEqual([0]);
  });

  it("reports which sources actually opened, not which were asked for", async () => {
    const session = await new AudioCaptureService(
      stubSurface({ microphone: true, systemAudio: false }),
    ).start(GOOD);

    // Asked for both, got one. A caller that cannot see this labels a mic-only
    // recording as a full one.
    expect(session.opened).toEqual({ microphone: true, systemAudio: false });
  });

  it("refuses a second capture while one is running", async () => {
    const service = new AudioCaptureService(stubSurface());
    const first = await service.start(GOOD);

    await expect(service.start(GOOD)).rejects.toBeInstanceOf(AudioCaptureError);

    // ...and the slot is released by stopping, not by the failed attempt.
    await first.stop();
    await expect(service.start(GOOD)).resolves.toBeDefined();
  });

  it("frees the slot when the surface fails to open", async () => {
    const surface = stubSurface();
    surface.open = vi.fn(async () => { throw new Error("no permission"); });
    const service = new AudioCaptureService(surface);

    await expect(service.start(GOOD)).rejects.toThrow(/no permission/u);

    // The control, and the reason the slot is claimed before the await rather
    // than after: a failed start that kept the slot would lock capture out for
    // the rest of the session with nothing to show for it.
    expect(service.busy).toBe(false);
  });

  it("refuses a surface that came up with nothing, and closes it", async () => {
    const surface = stubSurface({ microphone: false, systemAudio: false });
    const service = new AudioCaptureService(surface);

    await expect(service.start(GOOD)).rejects.toThrow(/no audio source/u);

    // Not left running. A session that will only ever deliver silence is worse
    // than a refusal, because it looks like it is working.
    expect(surface.close).toHaveBeenCalled();
    expect(service.busy).toBe(false);
  });

  it("ends exactly once, no matter how many times the surface says so", async () => {
    const surface = stubSurface();
    const service = new AudioCaptureService(surface);
    const session = await service.start(GOOD);
    const ends: AudioCaptureEnd[] = [];
    session.onEnd((end) => ends.push(end));

    surface.end({ reason: "sources-lost", detail: "mic unplugged" });
    surface.end({ reason: "surface-lost" });
    await session.stop();

    // A caller that finalises its recording on the first end would corrupt it
    // on the second.
    expect(ends).toEqual([{ reason: "sources-lost", detail: "mic unplugged" }]);
    expect(service.busy).toBe(false);
  });

  it("drops frames that arrive after the end", async () => {
    const surface = stubSurface();
    const session = await new AudioCaptureService(surface).start(GOOD);
    const seen: number[] = [];
    session.onFrame((f) => seen.push(f.seq));

    surface.frame(frameOf(0));
    surface.end({ reason: "sources-lost" });
    surface.frame(frameOf(1));

    // Audio after the end would append to a recording the caller has already
    // written out.
    expect(seen).toEqual([0]);
  });

  it("keeps delivering to the other subscribers when one of them throws", async () => {
    const surface = stubSurface();
    const session = await new AudioCaptureService(surface).start(GOOD);
    const seen: number[] = [];
    session.onFrame(() => { throw new Error("subscriber bug"); });
    session.onFrame((f) => seen.push(f.seq));

    surface.frame(frameOf(0));

    // One caller's bug must not silence the capture for everyone else.
    expect(seen).toEqual([0]);
  });
});
