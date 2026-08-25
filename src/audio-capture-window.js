/*
 * The host's audio capture script. First-party, runs in the hidden capture
 * window, and talks only to the main process through the preload bridge.
 *
 * WHAT IT DOES NOT DO. No silence detection, no chunk boundaries, no mixing
 * policy beyond summing the sources that were asked for. Those are decisions
 * about the SUBJECT of a recording, and the subject belongs to whoever asked
 * for the audio. This file produces frames of PCM at a fixed cadence and a
 * peak amplitude per frame, and stops there.
 */

/**
 * The worklet, inline. It is a separate script context whether it lives in a
 * file or a blob, and inline keeps it beside the only code that constructs it
 * — the alternative is a second asset whose parameters have to agree with this
 * one's by convention rather than by construction.
 *
 * Its whole job is to hand back the mono samples it was given, in batches, with
 * the loudest sample in each. Everything else happens on this side.
 */
const WORKLET_SOURCE = `
class PcmCapture extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const channel = input[0];
    if (!channel || channel.length === 0) return true;
    let peak = 0;
    for (let i = 0; i < channel.length; i += 1) {
      const magnitude = channel[i] < 0 ? -channel[i] : channel[i];
      if (magnitude > peak) peak = magnitude;
    }
    // Copied, not referenced: the buffer is reused by the audio thread on the
    // very next quantum, so posting it directly would deliver whatever it
    // holds by the time the other side reads it.
    this.port.postMessage({ samples: new Float32Array(channel), peak });
    return true;
  }
}
registerProcessor("lvis-pcm-capture", PcmCapture);
`;

/** Gains applied when both sources are summed, so two loud inputs do not clip. */
const MIC_GAIN = 0.9;
const SYSTEM_GAIN = 0.7;

const bridge = window.__lvisCapture;

let audioContext = null;
let micStream = null;
let systemStream = null;
let seq = 0;

/**
 * Open system audio through the loopback wiring.
 *
 * The enable/disable pair brackets ONE `getDisplayMedia` call, and the disable
 * runs whether or not the call succeeded — leaving the session in
 * "next capture returns system audio" mode would let an unrelated later
 * request pick up the machine's audio without asking.
 */
async function openSystemAudio() {
  await bridge.enableLoopback();
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    // The video track is an artefact of how loopback capture is requested. It
    // is stopped and removed immediately: keeping it would hold a screen
    // capture open for the length of the recording, which is not what was
    // asked for and not what the OS indicator would be telling the user.
    for (const track of stream.getVideoTracks()) {
      try { track.stop(); } catch { /* already gone */ }
      try { stream.removeTrack(track); } catch { /* already gone */ }
    }
    return stream.getAudioTracks().length > 0 ? stream : null;
  } finally {
    try { await bridge.disableLoopback(); } catch { /* best effort, always attempted */ }
  }
}

async function openMicrophone(deviceId) {
  // `exact`, not a preference. A named device that is gone must fail rather
  // than silently record a different microphone than the user chose.
  const constraint = deviceId ? { deviceId: { exact: deviceId } } : true;
  const stream = await navigator.mediaDevices.getUserMedia({ audio: constraint });
  return stream.getAudioTracks().length > 0 ? stream : null;
}

async function start(request) {
  // The context first, at the requested rate, so both sources arrive already
  // at the rate the caller asked for and nothing downstream has to resample.
  audioContext = new AudioContext({ sampleRate: request.sampleRate });

  let systemError = null;
  if (request.systemAudio) {
    try {
      systemStream = await openSystemAudio();
    } catch (err) {
      systemError = err && err.message ? err.message : String(err);
      systemStream = null;
    }
  }

  let micError = null;
  if (request.microphone) {
    try {
      micStream = await openMicrophone(request.microphoneDeviceId);
    } catch (err) {
      micError = err && err.message ? err.message : String(err);
      micStream = null;
    }
  }

  const opened = { microphone: micStream !== null, systemAudio: systemStream !== null };
  if (!opened.microphone && !opened.systemAudio) {
    // Reported rather than thrown into the void: the main process turns this
    // into the caller's error, and the reasons from both attempts are the only
    // thing that makes it actionable.
    await bridge.ready({
      opened,
      error: [systemError && `system audio: ${systemError}`, micError && `microphone: ${micError}`]
        .filter(Boolean)
        .join("; ") || "no source was requested",
    });
    return;
  }

  const blobUrl = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: "application/javascript" }));
  try {
    await audioContext.audioWorklet.addModule(blobUrl);
  } finally {
    URL.revokeObjectURL(blobUrl);
  }

  const node = new AudioWorkletNode(audioContext, "lvis-pcm-capture", {
    numberOfInputs: 1,
    numberOfOutputs: 0,
    channelCount: 1,
    channelCountMode: "explicit",
    channelInterpretation: "speakers",
  });

  const connect = (stream, gainValue) => {
    const source = audioContext.createMediaStreamSource(stream);
    const gain = audioContext.createGain();
    gain.gain.value = gainValue;
    source.connect(gain).connect(node);
  };
  if (micStream) connect(micStream, MIC_GAIN);
  if (systemStream) connect(systemStream, SYSTEM_GAIN);

  // Accumulate the worklet's quanta up to the cadence the caller asked for.
  const frameSamples = Math.round((request.sampleRate * request.frameMs) / 1000);
  let pending = new Float32Array(frameSamples);
  let filled = 0;
  let framePeak = 0;

  node.port.onmessage = (event) => {
    const { samples, peak } = event.data || {};
    if (!samples) return;
    if (peak > framePeak) framePeak = peak;
    let offset = 0;
    while (offset < samples.length) {
      const take = Math.min(frameSamples - filled, samples.length - offset);
      pending.set(samples.subarray(offset, offset + take), filled);
      filled += take;
      offset += take;
      if (filled === frameSamples) {
        // Float32 across the bridge, int16 on the far side. The conversion
        // has an asymmetry that is easy to get wrong and impossible to notice
        // by ear until the loudest moment of a recording, so it lives in the
        // main process where a test can reach it.
        bridge.frame({ seq, samples: pending, peak: framePeak });
        seq += 1;
        // A fresh buffer per frame. Reusing it would hand the main process a
        // view the next quantum overwrites before the IPC copy is made.
        pending = new Float32Array(frameSamples);
        filled = 0;
        framePeak = 0;
      }
    }
  };

  // A source that disappears mid-recording — an unplugged interface, a shared
  // window that closed — ends the capture rather than leaving it delivering
  // silence that looks like a quiet room.
  const watch = (stream, which) => {
    for (const track of stream.getAudioTracks()) {
      track.addEventListener("ended", () => {
        bridge.ended({ reason: "sources-lost", detail: `${which} track ended` });
      });
    }
  };
  if (micStream) watch(micStream, "microphone");
  if (systemStream) watch(systemStream, "system audio");

  await bridge.ready({ opened });
}

bridge.onListDevices(async () => {
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices
    .filter((device) => device.kind === "audioinput")
    .map((device) => ({ deviceId: device.deviceId, label: device.label }));
});

bridge.getRequest().then((request) => {
  // No request means this window was opened only to enumerate devices.
  if (!request) return;
  start(request).catch(async (err) => {
    await bridge.ready({
      opened: { microphone: false, systemAudio: false },
      error: err && err.message ? err.message : String(err),
    });
  });
});
