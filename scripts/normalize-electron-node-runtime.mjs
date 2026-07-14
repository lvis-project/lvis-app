function removeRuntimeMarker(target, key) {
  if (Reflect.deleteProperty(target, key)) return;
  throw new Error(
    `[electron-node-normalization-failed] could not remove process.${String(key)}`,
  );
}

export function normalizeElectronNodeRuntime(target = process) {
  if (target.env?.ELECTRON_RUN_AS_NODE !== "1") return false;
  if (target.versions && typeof target.versions === "object") {
    removeRuntimeMarker(target.versions, "electron");
    removeRuntimeMarker(target.versions, "chrome");
  }
  removeRuntimeMarker(target, "resourcesPath");
  removeRuntimeMarker(target, "helperExecPath");
  return true;
}

normalizeElectronNodeRuntime();
