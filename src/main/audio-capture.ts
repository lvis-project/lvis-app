/**
 * Host-owned audio capture.
 *
 * WHY THIS IS HOST CODE AND NOT A PLUGIN'S. Capturing audio needs
 * `getUserMedia`, `getDisplayMedia`, an `AudioContext` and an `AudioWorklet` —
 * four things that exist only in a renderer. A plugin that wants them has to
 * ship its own renderer and load it outside the sandbox, which is not a
 * boundary a host API can mediate: mediating it would mean the host running
 * plugin code in a privileged context, and that does not move the boundary, it
 * removes it.
 *
 * So the capture surface becomes first-party. The host owns the renderer, the
 * worklet and the loopback wiring; the plugin owns the meeting, the
 * transcription and the summary. What crosses between them is PCM and numbers.
 *
 * THE SHAPE THE PLUGIN SEES IS DATA, BOTH WAYS. Going in: a sample rate, a
 * frame length in milliseconds, two booleans and an optional device id. Coming
 * back: interleaved little-endian int16 mono samples and a peak amplitude.
 * Nothing here accepts a command, a script or a function body — the same test
 * every other member of this host's plugin surface has to pass.
 *
 * WHAT IS DELIBERATELY *NOT* HERE. No silence detection, no chunk-cutting at
 * speech boundaries, no mixing policy beyond summing the sources the caller
 * asked for. Those are decisions about a MEETING, and a meeting is the
 * plugin's subject, not the host's. The host emits frames at the cadence it
 * was asked for and the caller decides what a useful chunk is; putting a
 * voice-activity threshold in here would be the host having an opinion about
 * a domain it cannot see.
 */
import { randomUUID } from "node:crypto";
// The plugin-facing contract is the SOT for these shapes; this file conforms
// to it rather than declaring a second copy that could drift from what the
// SDK mirrors.
import type {
  AudioCaptureDevice,
  AudioCaptureEnd,
  AudioCaptureFrame,
  AudioCaptureHandle,
  AudioCaptureRequest,
} from "../plugins/public-contract.js";
import { errorMessage } from "../shared/error-message.js";

export type { AudioCaptureDevice, AudioCaptureEnd, AudioCaptureFrame, AudioCaptureHandle, AudioCaptureRequest };

/** Sample rates a capture may ask for. */
const MIN_SAMPLE_RATE = 8_000;
const MAX_SAMPLE_RATE = 48_000;
/**
 * Frame cadence bounds. The floor is the worklet's own quantum rounded up —
 * asking for less would not produce more frames, only the illusion of them.
 * The ceiling keeps a stop() from having to wait a second for its last frame.
 */
const MIN_FRAME_MS = 20;
const MAX_FRAME_MS = 1_000;







/** Raised when a request could not be honoured as written. */
export class AudioCaptureError extends Error {
  constructor(message: string) {
    super(`[audio-capture] ${message}`);
    this.name = "AudioCaptureError";
  }
}

/**
 * Normalize and validate a request, or refuse it.
 *
 * Refusing rather than clamping. A caller that asks for a 96 kHz capture and
 * silently receives 48 kHz will write 96 kHz into its own file headers and
 * produce audio that plays at half speed — the error is far easier to act on
 * than the artifact.
 */
export function validateAudioCaptureRequest(
  request: AudioCaptureRequest,
): Required<Omit<AudioCaptureRequest, "microphoneDeviceId">> & {
  readonly microphoneDeviceId: string | null;
} {
  const { sampleRate, frameMs, microphone, systemAudio } = request;
  if (!Number.isInteger(sampleRate) || sampleRate < MIN_SAMPLE_RATE || sampleRate > MAX_SAMPLE_RATE) {
    throw new AudioCaptureError(
      `sampleRate must be an integer in [${MIN_SAMPLE_RATE}, ${MAX_SAMPLE_RATE}], got ${String(sampleRate)}`,
    );
  }
  if (!Number.isInteger(frameMs) || frameMs < MIN_FRAME_MS || frameMs > MAX_FRAME_MS) {
    throw new AudioCaptureError(
      `frameMs must be an integer in [${MIN_FRAME_MS}, ${MAX_FRAME_MS}], got ${String(frameMs)}`,
    );
  }
  if (!microphone && !systemAudio) {
    // A capture with no source is not a quiet capture, it is a mistake that
    // would otherwise present as a recording of silence.
    throw new AudioCaptureError("a capture must ask for the microphone, system audio, or both");
  }
  const deviceId = request.microphoneDeviceId;
  if (deviceId !== undefined && (typeof deviceId !== "string" || deviceId.length === 0)) {
    throw new AudioCaptureError("microphoneDeviceId, when given, must be a non-empty string");
  }
  if (deviceId !== undefined && !microphone) {
    // Naming a microphone while not asking for one is a contradiction, and the
    // reading that "it will be used if the mic is on" is exactly the kind of
    // guess that ships a recording nobody asked for.
    throw new AudioCaptureError("microphoneDeviceId was given but microphone is false");
  }
  return { sampleRate, frameMs, microphone, systemAudio, microphoneDeviceId: deviceId ?? null };
}

/**
 * The renderer-backed half, injected so the service is testable without an
 * Electron window and so a platform that cannot capture can say so rather than
 * pretend.
 */
export interface AudioCaptureSurface {
  /**
   * Bring up the capture surface and begin delivering frames.
   *
   * Resolves once capture is RUNNING, with the sources that actually opened.
   * Rejecting means nothing was started, so the service does not have to
   * unwind a half-open session.
   */
  open(options: {
    readonly request: ReturnType<typeof validateAudioCaptureRequest>;
    readonly onFrame: (frame: AudioCaptureFrame) => void;
    readonly onEnd: (end: AudioCaptureEnd) => void;
  }): Promise<{ readonly microphone: boolean; readonly systemAudio: boolean }>;
  /** Tear the surface down. Must not deliver frames after it resolves. */
  close(): Promise<void>;
  /** The microphones the user could pick, as the renderer sees them. */
  listInputDevices(): Promise<readonly AudioCaptureDevice[]>;
}

/**
 * Owns the one capture at a time this host runs.
 *
 * ONE, not a pool. The microphone and the system mixer are single physical
 * things; a second concurrent capture would either fail deep inside Chromium
 * or quietly produce two recordings of the same audio. Refusing here says so
 * where the caller can read it.
 */
export class AudioCaptureService {
  #surface: AudioCaptureSurface;
  #active: { readonly captureId: string } | null = null;

  constructor(surface: AudioCaptureSurface) {
    this.#surface = surface;
  }

  /** Whether a capture is running right now. */
  get busy(): boolean {
    return this.#active !== null;
  }

  async listInputDevices(): Promise<readonly AudioCaptureDevice[]> {
    return await this.#surface.listInputDevices();
  }

  async start(request: AudioCaptureRequest): Promise<AudioCaptureHandle> {
    const validated = validateAudioCaptureRequest(request);
    if (this.#active) {
      throw new AudioCaptureError(
        `a capture (${this.#active.captureId}) is already running; stop it before starting another`,
      );
    }
    const captureId = `capture-${randomUUID()}`;
    // Claimed BEFORE the await, so two starts racing cannot both find the slot
    // empty. The catch below is what gives it back if the open fails.
    this.#active = { captureId };

    const frameListeners = new Set<(frame: AudioCaptureFrame) => void>();
    const endListeners = new Set<(end: AudioCaptureEnd) => void>();
    let ended = false;
    const emitEnd = (end: AudioCaptureEnd): void => {
      // Once. A surface that reports both "sources lost" and "closed" would
      // otherwise deliver two ends for one capture, and a caller that finalises
      // its file on the first would corrupt it on the second.
      if (ended) return;
      ended = true;
      if (this.#active?.captureId === captureId) this.#active = null;
      for (const listener of endListeners) {
        try { listener(end); } catch { /* a bad listener does not break the rest */ }
      }
    };

    let opened: { microphone: boolean; systemAudio: boolean };
    try {
      opened = await this.#surface.open({
        request: validated,
        onFrame: (frame) => {
          if (ended) return;
          for (const listener of frameListeners) {
            try { listener(frame); } catch { /* as above */ }
          }
        },
        onEnd: emitEnd,
      });
    } catch (err) {
      this.#active = null;
      throw err instanceof AudioCaptureError
        ? err
        : new AudioCaptureError(`could not start capture: ${errorMessage(err)}`);
    }

    if (!opened.microphone && !opened.systemAudio) {
      // The surface came up and captured nothing. Closing here rather than
      // handing back a session that will only ever deliver silence.
      await this.#surface.close().catch(() => { /* already failing */ });
      this.#active = null;
      throw new AudioCaptureError("no audio source could be opened");
    }

    const session: AudioCaptureHandle = {
      captureId,
      opened: { microphone: opened.microphone, systemAudio: opened.systemAudio },
      onFrame: (listener) => {
        frameListeners.add(listener);
        return () => frameListeners.delete(listener);
      },
      onEnd: (listener) => {
        endListeners.add(listener);
        return () => endListeners.delete(listener);
      },
      stop: async () => {
        if (ended) return;
        await this.#surface.close();
        emitEnd({ reason: "stopped" });
      },
    };
    return session;
  }
}
