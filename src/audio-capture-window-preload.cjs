/*
 * Preload for the host's hidden audio capture window.
 *
 * The narrowest bridge that can work: three calls out, one call in, and no
 * general-purpose channel. This window is first-party host code, so the bridge
 * is not a trust boundary the way a plugin's would be — it is kept narrow
 * anyway, because a permissive surface here is one a later change can reach
 * for without noticing it is doing so.
 */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("__lvisCapture", {
  /** Pull the request once the module has finished evaluating. */
  getRequest: () => ipcRenderer.invoke("lvis-audio-capture:get-request"),
  /** Flip the session into "the next getDisplayMedia returns system audio". */
  enableLoopback: () => ipcRenderer.invoke("enable-loopback-audio"),
  /** ...and back, whether or not the request succeeded. */
  disableLoopback: () => ipcRenderer.invoke("disable-loopback-audio"),
  /** Report which sources opened, or why none did. */
  ready: (payload) => ipcRenderer.invoke("lvis-audio-capture:ready", payload),
  /** One frame of PCM. Structured-clone, so no JSON round trip. */
  frame: (payload) => ipcRenderer.send("lvis-audio-capture:frame", payload),
  /** Capture stopped on its own. */
  ended: (payload) => ipcRenderer.send("lvis-audio-capture:ended", payload),
  /** Enumerate microphones for a caller that wants to offer a choice. */
  onListDevices: (handler) => {
    ipcRenderer.on("lvis-audio-capture:list-devices", async (_event, requestId) => {
      let devices = [];
      let error = null;
      try {
        devices = await handler();
      } catch (err) {
        error = err && err.message ? err.message : String(err);
      }
      ipcRenderer.send("lvis-audio-capture:devices", { requestId, devices, error });
    });
  },
});
