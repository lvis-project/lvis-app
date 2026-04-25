#!/usr/bin/env node
/**
 * check-tool-namespace.mjs — Tool namespace collision detector
 *
 * Scans all packaged plugin.json files under plugins/installed/ and verifies:
 *   1. Every tool name matches ^[a-zA-Z0-9_-]+$ (no dots)
 *   2. No tool name appears in more than one plugin (collision)
 *
 * Usage:
 *   node scripts/check-tool-namespace.mjs
 *
 * Exit code 0 = OK, 1 = violations found.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const PLUGINS_DIR = resolve(process.cwd(), "plugins", "installed");
const TOOL_NAME_RE = /^[a-zA-Z0-9_-]+$/;

/** Recursively find all plugin.json files under a directory. */
function findPluginManifests(dir) {
  const results = [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return results;
  }
  for (const entry of entries) {
    const p = join(dir, entry);
    let s;
    try {
      s = statSync(p);
    } catch {
      continue;
    }
    if (s.isDirectory()) {
      results.push(...findPluginManifests(p));
    } else if (entry === "plugin.json") {
      results.push(p);
    }
  }
  return results;
}

let failed = false;

/** @type {Map<string, string>} toolName -> pluginId */
const seen = new Map();

const manifests = findPluginManifests(PLUGINS_DIR);

if (manifests.length === 0) {
  console.warn(
    `[tool-namespace] WARNING: no plugin.json files found under ${PLUGINS_DIR}. ` +
      `Run 'bun run prepare:plugins' first if checking packaged plugins.`
  );
  process.exit(0);
}

for (const manifestPath of manifests) {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (e) {
    console.error(`[tool-namespace] FAIL — cannot parse ${manifestPath}: ${e.message}`);
    failed = true;
    continue;
  }

  const pluginId = manifest.id ?? manifestPath;
  const tools = manifest.tools ?? [];

  for (const tool of tools) {
    // tool entries may be plain strings or objects with a .name field
    const name = typeof tool === "string" ? tool : tool?.name;
    if (!name) continue;

    // Rule 1: character set validation
    if (!TOOL_NAME_RE.test(name)) {
      console.error(
        `[tool-namespace] FAIL — plugin '${pluginId}' tool '${name}' ` +
          `contains invalid characters (must match ^[a-zA-Z0-9_-]+$, dots are forbidden)`
      );
      failed = true;
    }

    // Rule 2: duplicate detection
    if (seen.has(name)) {
      const firstOwner = seen.get(name);
      console.error(
        `[tool-namespace] FAIL — tool name collision: '${name}' is declared by ` +
          `both '${firstOwner}' and '${pluginId}'`
      );
      failed = true;
    } else {
      seen.set(name, pluginId);
    }
  }
}

if (failed) {
  console.error(
    `[tool-namespace] FAIL — violations detected. Fix plugin.json files before merging.`
  );
  process.exit(1);
}

console.log(
  `[tool-namespace] OK — ${seen.size} tool(s) across ${manifests.length} plugin(s), no collisions.`
);
