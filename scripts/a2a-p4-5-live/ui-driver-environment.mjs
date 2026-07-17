export const PACKAGED_UI_ENV_KEYS = Object.freeze([
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL",
  "TMPDIR", "TEMP", "TMP", "USERPROFILE", "SystemRoot", "WINDIR",
  "ComSpec", "PATHEXT", "APPDATA", "LOCALAPPDATA",
  "DISPLAY", "WAYLAND_DISPLAY", "XAUTHORITY", "XDG_RUNTIME_DIR",
  "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME",
  "DBUS_SESSION_BUS_ADDRESS", "LVIS_A2A_EVIDENCE_PUBLIC_KEY_FILE",
  "LVIS_A2A_EVIDENCE_SIGNER_SHA256",
]);

export function buildPackagedUiEnvironment(source = process.env) {
  return Object.fromEntries(PACKAGED_UI_ENV_KEYS
    .filter((key) => typeof source[key] === "string")
    .map((key) => [key, source[key]]));
}
