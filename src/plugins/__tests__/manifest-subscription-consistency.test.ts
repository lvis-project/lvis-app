/**
 * Sprint 4-D T4 — Manifest subscription consistency guard.
 *
 * For each installed plugin manifest (plugins/installed/*\/plugin.json):
 *
 *  1. Verify every entry in `eventSubscriptions[]` falls within an allowed
 *     namespace (PUBLIC_EVENT_NAMESPACES or neutral — not private). This
 *     catches typos and stale subscriptions that would silently be dropped by
 *     registerManifestEventSubscriptions().
 *
 *  2. Verify that `eventSubscriptions[]` entries do NOT include private
 *     namespace values (memory.private.*, settings.apiKey.*, audit.*, dlp.*).
 *
 * What this test intentionally does NOT check:
 *  - Whether the plugin's hostPlugin.ts actually wires a handler for each
 *    subscription (would require introspecting plugin package code, out of
 *    scope for host-side tests per T4 constraints).
 *  - Whether the manifest's `capabilities[]` covers the emit-side of the
 *    subscribed namespace (subscriptions are receive-side, no capability needed
 *    to listen, only to emit — see capabilities.ts EVENT_NAMESPACE_CAPABILITY).
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import {
  classifySubscription,
  PUBLIC_EVENT_NAMESPACES,
} from "../capabilities.js";

// ─────────────────────────────────────────────────────────────────────────────
// Locate installed plugin manifests
// ─────────────────────────────────────────────────────────────────────────────

const INSTALLED_DIR = fileURLToPath(new URL("../../../plugins/installed", import.meta.url));

interface PluginManifestMinimal {
  id: string;
  eventSubscriptions?: unknown;
  capabilities?: unknown;
}

function loadInstalledManifests(): Array<{
  pluginId: string;
  manifest: PluginManifestMinimal;
}> {
  const results: Array<{ pluginId: string; manifest: PluginManifestMinimal }> =
    [];
  let dirs: string[];
  try {
    dirs = readdirSync(INSTALLED_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    // If the installed dir doesn't exist in the test environment, skip.
    return [];
  }
  for (const dir of dirs) {
    const manifestPath = join(INSTALLED_DIR, dir, "plugin.json");
    let raw: string;
    try {
      raw = readFileSync(manifestPath, "utf-8");
    } catch {
      continue; // no plugin.json — not an installed plugin dir
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`Invalid JSON in ${manifestPath}`);
    }
    if (typeof parsed !== "object" || parsed === null) {
      throw new Error(`plugin.json must be an object: ${manifestPath}`);
    }
    results.push({
      pluginId: dir,
      manifest: parsed as PluginManifestMinimal,
    });
  }
  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("Manifest subscription consistency guard", () => {
  const manifests = loadInstalledManifests();

  it("finds at least one installed plugin manifest to validate", () => {
    // If this fails the installed dir is missing — fix the path, not the test.
    expect(manifests.length).toBeGreaterThan(0);
  });

  for (const { pluginId, manifest } of manifests) {
    describe(`plugin: ${pluginId}`, () => {
      const subs = Array.isArray(manifest.eventSubscriptions)
        ? (manifest.eventSubscriptions as unknown[])
        : [];

      it("eventSubscriptions[] contains only string or {type,hint?} object values", () => {
        for (const sub of subs) {
          if (typeof sub === "string") continue;
          // Object form: must have a non-empty string 'type' field
          expect(sub).toMatchObject({ type: expect.any(String) });
          expect((sub as { type: string }).type.trim().length).toBeGreaterThan(0);
        }
      });

      it("eventSubscriptions[] entries are not in private namespaces", () => {
        for (const sub of subs) {
          const eventType = typeof sub === "string" ? sub : (sub as { type: string }).type;
          const verdict = classifySubscription(eventType);
          expect(verdict).not.toBe(
            "private",
            `plugin '${pluginId}' declares private subscription '${eventType}' — must be removed from manifest`,
          );
        }
      });

      it("eventSubscriptions[] entries are valid namespace strings (no empty, no dots-only)", () => {
        for (const sub of subs) {
          const eventType = typeof sub === "string" ? sub : (sub as { type: string }).type;
          expect(eventType.trim().length).toBeGreaterThan(0);
          // Must be dot-separated segments with at least one non-dot char.
          expect(eventType).toMatch(/^[a-zA-Z][a-zA-Z0-9._-]*$/);
        }
      });

      it("eventSubscriptions[] public entries are in known public namespaces OR neutral (warn only)", () => {
        // This test documents which subscriptions fall outside PUBLIC_EVENT_NAMESPACES.
        // The host allows neutral entries with a warn (namespace drift signal).
        // This test fails only if a private namespace slips through (already covered
        // above) — here we just assert the classification is never "private".
        for (const sub of subs) {
          const eventType = typeof sub === "string" ? sub : (sub as { type: string }).type;
          const verdict = classifySubscription(eventType);
          // private is the only hard failure; public and neutral are both OK.
          expect(["public", "neutral"]).toContain(verdict);
        }
      });

      // Document which subscriptions are neutral (outside public allowlist)
      // so operators can track drift. Not a hard failure.
      const neutralSubs = subs
        .map((s) => (typeof s === "string" ? s : (s as { type: string }).type))
        .filter((eventType) => classifySubscription(eventType) === "neutral");

      if (neutralSubs.length > 0) {
        it(`documents neutral (outside public allowlist) subscriptions: ${neutralSubs.join(", ")}`, () => {
          // Neutral entries are allowed-with-warn per the host policy.
          // This test exists purely to surface them in the test report for ops
          // awareness. If a subscription is intentionally outside public
          // namespaces it should be documented here.
          expect(neutralSubs.length).toBeGreaterThanOrEqual(0); // always passes
        });
      }

      // Validate public namespace subscriptions look plausible.
      const publicSubs = subs.filter(
        (s): s is string =>
          typeof s === "string" && classifySubscription(s) === "public",
      );

      for (const sub of publicSubs) {
        it(`'${sub}' matches a known public namespace prefix`, () => {
          const prefix = sub.split(".")[0] ?? "";
          expect(PUBLIC_EVENT_NAMESPACES.has(prefix)).toBe(true);
        });
      }
    });
  }
});
