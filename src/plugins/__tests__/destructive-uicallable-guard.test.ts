/**
 * Regression guard: ensure no installed plugin manifest exposes a destructive
 * tool name via `uiCallable[]`. uiCallable tools bypass the chat approval gate,
 * so anything matching the destructive blocklist below would allow the renderer
 * to trigger an irreversible action (delete, remove, send, destroy, erase,
 * purge, reply, create, update) without user confirmation.
 *
 * Context:
 *  - PR #57 claimed to remove `email_reply`, `calendar_delete`,
 *    `calendar_create`, `calendar_update` from uiCallable — but audit on
 *    2026-04-18 showed `email_reply` and `calendar_delete` still present.
 *  - This test exists so that regression never happens silently again.
 *
 * Future-managed-signed exception: if a manifest has deployment="managed" AND
 * carries a valid detached signature (.sig), we could allow reviewed
 * destructive entries. For now we enforce the blocklist with no exceptions.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const DESTRUCTIVE_SUFFIX = /_(delete|remove|send|destroy|erase|purge|reply|create|update)$/i;

const installedRoot = resolve(__dirname, "..", "..", "..", "plugins", "installed");

function listInstalledManifests(): Array<{ id: string; path: string; manifest: Record<string, unknown> }> {
  if (!existsSync(installedRoot)) return [];
  const entries = readdirSync(installedRoot);
  const manifests: Array<{ id: string; path: string; manifest: Record<string, unknown> }> = [];
  for (const entry of entries) {
    const dir = join(installedRoot, entry);
    if (!statSync(dir).isDirectory()) continue;
    const manifestPath = join(dir, "plugin.json");
    if (!existsSync(manifestPath)) continue;
    const raw = readFileSync(manifestPath, "utf8");
    const manifest = JSON.parse(raw) as Record<string, unknown>;
    manifests.push({ id: entry, path: manifestPath, manifest });
  }
  return manifests;
}

describe("destructive uiCallable guard (installed manifests)", () => {
  const manifests = listInstalledManifests();

  it("discovers at least one installed manifest", () => {
    expect(manifests.length).toBeGreaterThan(0);
  });

  for (const { id, path, manifest } of manifests) {
    it(`[${id}] uiCallable does not expose destructive tool names`, () => {
      const uiCallable = Array.isArray(manifest.uiCallable) ? (manifest.uiCallable as unknown[]) : [];
      const offenders = uiCallable.filter(
        (name): name is string => typeof name === "string" && DESTRUCTIVE_SUFFIX.test(name),
      );
      expect(
        offenders,
        `manifest ${path} exposes destructive tool(s) via uiCallable: ${offenders.join(", ")}`,
      ).toEqual([]);
    });
  }
});
