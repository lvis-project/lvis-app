/**
 * Onboarding highlight identity — host cross-field checks.
 *
 * The JSON schema bounds the list and the shape of each `id`; what it cannot
 * express is that two entries must not carry the SAME id. `<pluginId>:<id>` is
 * the key the user's answer is stored under, so a duplicate would let one
 * card's "never" silence a card the user was never shown. The count is
 * re-checked here for the reason `hostSecrets` re-checks its own bounds: a
 * plugin shipped against a stale SDK schema must not widen what it declares.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parsePluginJson } from "../manifest-validation.js";
import { MAX_PLUGIN_ONBOARDING_HIGHLIGHTS } from "../../public-contract.js";
import {
  permissiveManifestValidatorFactory,
  pluginManifestWriter,
} from "../../__tests__/test-helpers.js";

const highlight = (id: string) => ({
  id,
  copy: {
    en: {
      headline: "Choose a folder to index",
      body: "Name one folder and search it in plain language.",
      actionLabel: "Choose a folder",
    },
  },
  action: { kind: "none" as const },
});

describe("manifest onboarding.highlights cross-field checks", () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "onboarding-highlights-"));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  // Permissive envelope — the host-side cross-field check is what this suite
  // exercises, NOT the vendored JSON schema (covered by the host-SOT suite).
  const makeValidator = permissiveManifestValidatorFactory({
    namespaceProperties: {
      entry: { type: "string" },
      tools: { type: "array" },
      onboarding: { type: "object" },
    },
    namespaceRequired: ["entry", "tools"],
  });

  const writeManifest = pluginManifestWriter(
    { id: "onboarding-highlights-test", name: "Onboarding Highlights Test" },
    () => workDir,
  );

  it("accepts distinct highlight ids", async () => {
    const path = await writeManifest({
      onboarding: { highlights: [highlight("pick-a-folder"), highlight("try-search")] },
    });
    const parsed = await parsePluginJson(path, makeValidator());
    expect(parsed.onboarding?.highlights?.map((h) => h.id)).toEqual([
      "pick-a-folder",
      "try-search",
    ]);
  });

  it("rejects a duplicate highlight id", async () => {
    const path = await writeManifest({
      onboarding: { highlights: [highlight("pick-a-folder"), highlight("pick-a-folder")] },
    });
    await expect(parsePluginJson(path, makeValidator())).rejects.toThrow(/duplicate/i);
  });

  it("rejects more highlights than a plugin may declare", async () => {
    const path = await writeManifest({
      onboarding: {
        highlights: Array.from(
          { length: MAX_PLUGIN_ONBOARDING_HIGHLIGHTS + 1 },
          (_, i) => highlight(`highlight-${i}`),
        ),
      },
    });
    await expect(parsePluginJson(path, makeValidator())).rejects.toThrow(
      new RegExp(`at most ${MAX_PLUGIN_ONBOARDING_HIGHLIGHTS}`),
    );
  });

  it("leaves a manifest without highlights alone", async () => {
    const path = await writeManifest({
      onboarding: {
        firstTask: {
          priority: 10,
          locales: {
            en: {
              headline: "Index a folder?",
              body: "Point at one folder and search it in plain language.",
              actionLabel: "Choose a folder",
              composerPrompt: "Add a folder to index",
            },
          },
        },
      },
    });
    const parsed = await parsePluginJson(path, makeValidator());
    expect(parsed.onboarding?.highlights).toBeUndefined();
    expect(parsed.onboarding?.firstTask?.priority).toBe(10);
  });
});
