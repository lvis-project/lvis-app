import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SRC_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx"]);

const FORBIDDEN_LIVE_APP_LITERALS = [
  {
    needle: "agent_hub",
    reason: "Agent Hub tool names must stay plugin-owned and manifest-driven.",
  },
  {
    needle: "agent-hub",
    reason: "Agent Hub routes or plugin ids must not be hard-coded in app runtime.",
  },
  {
    needle: "plugin:agent-hub",
    reason: "Plugin view keys must be derived from manifest runtime state.",
  },
  {
    needle: 'route: "agent-hub"',
    reason: "Route choices must stay generic and manifest/capability driven.",
  },
  {
    needle: "msgraph_",
    reason: "Microsoft Graph tool names must stay plugin-owned and manifest-driven.",
  },
  {
    needle: "work-proactive",
    reason: "Overlay trigger implementation names must stay plugin-owned and capability-driven.",
  },
  {
    needle: "work_proactive",
    reason: "Overlay trigger tool/event names must stay plugin-owned and manifest-driven.",
  },
  {
    needle: "lvis-plugin-work-proactive",
    reason: "Host runtime must not depend on a concrete overlay-trigger plugin repository.",
  },
] as const;

function listSourceFiles(dir: string): string[] {
  const entries = readdirSync(dir);
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      if (entry === "__tests__") continue;
      files.push(...listSourceFiles(fullPath));
      continue;
    }
    if (stat.isFile() && SOURCE_EXTENSIONS.has(extname(entry))) {
      files.push(fullPath);
    }
  }
  return files;
}

describe("app runtime stays decoupled from plugin-specific tool names", () => {
  it("does not hard-code Agent Hub or MS Graph plugin tool literals in live app source", () => {
    const violations: string[] = [];
    for (const file of listSourceFiles(SRC_ROOT)) {
      const content = readFileSync(file, "utf-8");
      for (const forbidden of FORBIDDEN_LIVE_APP_LITERALS) {
        if (content.includes(forbidden.needle)) {
          violations.push(`${relative(SRC_ROOT, file)} contains '${forbidden.needle}' — ${forbidden.reason}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
