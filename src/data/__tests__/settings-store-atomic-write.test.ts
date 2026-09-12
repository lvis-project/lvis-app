import { closeSync, lstatSync, mkdtempSync, openSync, readFileSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { unavailableSecretEncryption } from "../../__tests__/support/host-runtime.js";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { SettingsService, settingsFilePath } from "../settings-store.js";

let root: string;
let service: SettingsService;
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "lvis-settings-atomic-"));
  service = new SettingsService({ userDataPath: root, encryption: unavailableSecretEncryption });
  await service.patch({ system: { ...service.get("system"), hardwareAcceleration: false } });
});
afterEach(async () => cleanupTmpDir(root));

describe("settings persistence", () => {
  it("lets an existing reader finish the previous complete settings while publishing the next version", async () => {
    const path = settingsFilePath(root);
    const before = readFileSync(path, "utf8");
    const fd = openSync(path, "r");
    try {
      await service.patch({ system: { ...service.get("system"), hardwareAcceleration: true } });
      expect(readFileSync(fd, "utf8")).toBe(before);
      expect(JSON.parse(readFileSync(path, "utf8")).system.hardwareAcceleration).toBe(true);
      const reloaded = new SettingsService({ userDataPath: root, encryption: unavailableSecretEncryption });
      expect(reloaded.get("system").hardwareAcceleration).toBe(true);
      if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
    } finally {
      closeSync(fd);
    }
  });

  it.skipIf(process.platform === "win32")("replaces a settings symlink without overwriting its target", async () => {
    const path = settingsFilePath(root);
    const outside = join(root, "separate-document.json");
    const original = "{\"keep\":true}\n";
    writeFileSync(outside, original);
    unlinkSync(path);
    symlinkSync(outside, path);

    await service.patch({ system: { ...service.get("system"), hardwareAcceleration: true } });

    expect(readFileSync(outside, "utf8")).toBe(original);
    expect(lstatSync(path).isSymbolicLink()).toBe(false);
    expect(JSON.parse(readFileSync(path, "utf8")).system.hardwareAcceleration).toBe(true);
  });
});
