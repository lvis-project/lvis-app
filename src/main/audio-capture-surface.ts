/**
 * The Electron half of {@link AudioCaptureSurface}: a hidden window, the
 * loopback wiring, and the conversion of what it sends into what a caller gets.
 *
 * Separate from `audio-capture.ts` because that file's whole value is being
 * testable without a renderer — it decides what may be asked for and what
 * happens to the one capture slot, and neither question needs Electron to
 * answer. This file is the part that does.
 */
import { BrowserWindow, ipcMain, session as electronSession } from "electron";
import { randomUUID } from "node:crypto";
import { runtimeAssetPath } from "./main-paths.js";
import {
  AudioCaptureError,
  type AudioCaptureDevice,
  type AudioCaptureEnd,
  type AudioCaptureFrame,
  type AudioCaptureSurface,
  type validateAudioCaptureRequest,
} from "./audio-capture.js";

type ValidatedRequest = ReturnType<typeof validateAudioCaptureRequest>;

/**
 * Float samples in [-1, 1] → little-endian int16.
 *
 * THE ASYMMETRY IS THE POINT. int16 runs to -32768 but only to +32767, so
 * scaling both directions by 32768 wraps the loudest positive sample round to
 * the quietest negative one. That is inaudible on ordinary audio and a hard
 * click on exactly the loudest moment of a recording — the failure that gets
 * reported as "it glitches sometimes" and never reproduces on a test tone.
 */
export function floatToInt16LittleEndian(samples: Float32Array): Uint8Array {
  const out = new Uint8Array(samples.length * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < samples.length; i += 1) {
    const sample = samples[i] ?? 0;
    const clamped = sample > 1 ? 1 : sample < -1 ? -1 : sample;
    view.setInt16(i * 2, Math.round(clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff), true);
  }
  return out;
}

/** Channel names, in one place so the preload and this file cannot drift. */
const CHANNEL = {
  getRequest: "lvis-audio-capture:get-request",
  ready: "lvis-audio-capture:ready",
  frame: "lvis-audio-capture:frame",
  ended: "lvis-audio-capture:ended",
  listDevices: "lvis-audio-capture:list-devices",
  devices: "lvis-audio-capture:devices",
} as const;

/**
 * The capture window's own session.
 *
 * Its own, because `initMain` installs a display-media request handler on
 * whichever session it is given, and that handler is what turns the next
 * `getDisplayMedia` into a system-audio capture. Installed on the default
 * session it would apply to every renderer in the application; scoped to a
 * partition only this window loads, it applies to exactly the window that
 * asked for it.
 */
const CAPTURE_PARTITION = "lvis-audio-capture";

/**
 * Wire the loopback handlers, once per process.
 *
 * Lazy rather than at boot, so an installation that never records never
 * installs a display-media handler at all. `initMain` registers global
 * `ipcMain.handle` channels and throws if called twice.
 */
let loopbackWired = false;
async function ensureLoopbackWired(): Promise<void> {
  if (loopbackWired) return;
  loopbackWired = true;
  // Imported here rather than at module scope: the wrapper's main entry does a
  // top-level `require("electron")`, which would run in any Node-only context
  // that merely imports this file.
  const mod = (await import("electron-audio-loopback")) as {
    initMain?: (opts?: { sessionOverride?: unknown; forceCoreAudioTap?: boolean }) => void;
  };
  if (typeof mod.initMain !== "function") {
    loopbackWired = false;
    throw new AudioCaptureError(
      "electron-audio-loopback did not export initMain — system audio cannot be captured",
    );
  }
  mod.initMain({
    sessionOverride: electronSession.fromPartition(CAPTURE_PARTITION),
    // macOS captures system audio through a CoreAudio tap; without this the
    // request falls back to a path that returns video and no audio.
    forceCoreAudioTap: true,
  });
}

/** How long the window gets to report that capture is running. */
const READY_TIMEOUT_MS = 30_000;
/** How long it gets to answer a device enumeration. */
const DEVICES_TIMEOUT_MS = 10_000;

interface ReadyReport {
  readonly opened: { readonly microphone: boolean; readonly systemAudio: boolean };
  readonly error?: string;
}

/**
 * Owns at most one hidden window.
 *
 * The window is torn down on close rather than kept warm. A window holding an
 * open microphone is a live recording as far as the operating system's
 * indicator is concerned, and keeping one around between captures would leave
 * that indicator on with nothing recording — the single most alarming thing
 * this subsystem could do.
 */
export class ElectronAudioCaptureSurface implements AudioCaptureSurface {
  #window: BrowserWindow | null = null;
  #wired = false;
  #request: ValidatedRequest | null = null;
  #onFrame: ((frame: AudioCaptureFrame) => void) | null = null;
  #onEnd: ((end: AudioCaptureEnd) => void) | null = null;
  #ready: ((report: ReadyReport) => void) | null = null;
  #devices = new Map<string, (result: { devices?: readonly AudioCaptureDevice[]; error?: string }) => void>();

  async open(options: {
    readonly request: ValidatedRequest;
    readonly onFrame: (frame: AudioCaptureFrame) => void;
    readonly onEnd: (end: AudioCaptureEnd) => void;
  }): Promise<{ readonly microphone: boolean; readonly systemAudio: boolean }> {
    if (this.#window) throw new AudioCaptureError("a capture surface is already open");
    this.#request = options.request;
    this.#onFrame = options.onFrame;
    this.#onEnd = options.onEnd;

    const report = await new Promise<ReadyReport>((settle, fail) => {
      const timer = setTimeout(() => {
        this.#ready = null;
        fail(new AudioCaptureError(`capture did not start within ${READY_TIMEOUT_MS}ms`));
      }, READY_TIMEOUT_MS);
      this.#ready = (value) => {
        clearTimeout(timer);
        this.#ready = null;
        settle(value);
      };
      this.#spawnWindow().catch((err: unknown) => {
        clearTimeout(timer);
        this.#ready = null;
        fail(err);
      });
    }).catch(async (err: unknown) => {
      // Whatever went wrong, the window does not outlive the failure — a
      // hidden window with a half-open microphone is precisely the leak the
      // teardown-on-close rule exists to prevent.
      await this.close();
      throw err;
    });

    if (report.error !== undefined) {
      await this.close();
      throw new AudioCaptureError(report.error);
    }
    return report.opened;
  }

  async close(): Promise<void> {
    const window = this.#window;
    this.#window = null;
    this.#request = null;
    this.#onFrame = null;
    this.#onEnd = null;
    if (!window) return;
    if (!window.isDestroyed()) window.destroy();
  }

  async listInputDevices(): Promise<readonly AudioCaptureDevice[]> {
    // Reuses the running window when there is one. Opening a second would trip
    // the "already open" guard above for a question that needs no capture at
    // all.
    const owned = this.#window === null;
    if (owned) await this.#spawnWindow();
    try {
      const requestId = randomUUID();
      const answer = await new Promise<{ devices?: readonly AudioCaptureDevice[]; error?: string }>(
        (settle, fail) => {
          const timer = setTimeout(() => {
            this.#devices.delete(requestId);
            fail(new AudioCaptureError(`device enumeration timed out after ${DEVICES_TIMEOUT_MS}ms`));
          }, DEVICES_TIMEOUT_MS);
          this.#devices.set(requestId, (result) => {
            clearTimeout(timer);
            this.#devices.delete(requestId);
            settle(result);
          });
          this.#window?.webContents.send(CHANNEL.listDevices, requestId);
        },
      );
      if (answer.error !== undefined) throw new AudioCaptureError(answer.error);
      return answer.devices ?? [];
    } finally {
      if (owned) await this.close();
    }
  }

  /** Register the channel handlers once for the lifetime of the process. */
  #wire(): void {
    if (this.#wired) return;
    this.#wired = true;

    ipcMain.handle(CHANNEL.getRequest, (event) => (this.#owns(event) ? this.#request : null));
    ipcMain.handle(CHANNEL.ready, (event, payload: unknown) => {
      if (!this.#owns(event)) return;
      this.#ready?.(payload as ReadyReport);
    });
    ipcMain.on(CHANNEL.frame, (event, payload: unknown) => {
      if (!this.#owns(event)) return;
      const frame = payload as { seq: number; samples: Float32Array; peak: number };
      this.#onFrame?.({
        seq: frame.seq,
        pcm: floatToInt16LittleEndian(frame.samples),
        peak: frame.peak,
      });
    });
    ipcMain.on(CHANNEL.ended, (event, payload: unknown) => {
      if (!this.#owns(event)) return;
      this.#onEnd?.(payload as AudioCaptureEnd);
    });
    ipcMain.on(CHANNEL.devices, (event, payload: unknown) => {
      if (!this.#owns(event)) return;
      const answer = payload as { requestId: string; devices?: AudioCaptureDevice[]; error?: string | null };
      this.#devices.get(answer.requestId)?.({
        devices: answer.devices,
        ...(answer.error ? { error: answer.error } : {}),
      });
    });
  }

  /**
   * Is this message from the window we opened?
   *
   * Every handler asks, because `ipcMain` is process-wide: without it any
   * renderer in the application — including a plugin's own UI card — could
   * answer `get-request` or push frames into a recording it has nothing to do
   * with.
   */
  #owns(event: { sender: Electron.WebContents }): boolean {
    return this.#window !== null
      && !this.#window.isDestroyed()
      && event.sender.id === this.#window.webContents.id;
  }

  async #spawnWindow(): Promise<void> {
    this.#wire();
    await ensureLoopbackWired();
    const window = new BrowserWindow({
      show: false,
      webPreferences: {
        preload: runtimeAssetPath("audio-capture-window-preload.cjs"),
        partition: CAPTURE_PARTITION,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    });
    this.#window = window;
    window.on("closed", () => {
      if (this.#window !== window) return;
      this.#window = null;
      // The window going away while a capture was running is a lost surface,
      // not a clean stop. `AudioCaptureService` collapses whichever end
      // arrives first, so reporting it here cannot produce a duplicate.
      this.#onEnd?.({ reason: "surface-lost", detail: "capture window closed" });
    });
    await window.loadFile(runtimeAssetPath("audio-capture-window.html"));
  }
}
