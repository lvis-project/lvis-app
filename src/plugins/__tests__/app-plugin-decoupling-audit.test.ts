import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
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
    needle: "work-assistant",
    reason: "Overlay trigger implementation names must stay plugin-owned and capability-driven.",
  },
  {
    needle: "work_assistant",
    reason: "Overlay trigger tool/event names must stay plugin-owned and manifest-driven.",
  },
  {
    needle: "lvis-plugin-work-assistant",
    reason: "Host runtime must not depend on a concrete overlay-trigger plugin repository.",
  },
] as const;

/**
 * Directories where literal plugin-id references are by-design allowed:
 *   - `onboarding/` — discovery cards, tour scenarios, plugin-recommendation
 *     matrices. The whole purpose of these files is to *recommend specific
 *     plugins* to a fresh user; that recommendation list MUST mention
 *     concrete plugin ids. The rule the host-runtime decoupling test
 *     guards (host does not *invoke* a plugin by hardcoded id) is a
 *     different concern from onboarding's recommendation data tables.
 *   - `i18n/` — the translation catalog (seed + generated fragments). These
 *     are pure display copy: onboarding tour / recommendation strings that
 *     were extracted out of `onboarding/` during the i18n migration legitimately
 *     name plugins (e.g. "select agents from the agent-hub plugin"). Naming a
 *     plugin in UI copy is the same allowed concern as onboarding above — never
 *     a runtime invocation of a plugin by hardcoded id.
 */
const ALLOWED_DIRS = new Set(["onboarding", "i18n"]);

/**
 * The one file that must name a plugin id, and the only needles it may name.
 *
 * `plugins/isolation/out-of-process-plugins.ts` is the routing SOT for the
 * process boundary (`docs/blueprints/plugin-process-isolation.md` §9): it
 * records which plugins the host loads in a confined child process instead of
 * importing into main. That decision cannot live anywhere else, and the design
 * says so explicitly — not an environment variable (the boundary could change
 * under a user with no record of it), not a settings key, and above all not a
 * manifest field, because the plugin is the one party that must not get a say
 * in whether it is isolated. A reviewed commit adding an id to a frozen set is
 * the mechanism, which means the id is source and shows up in a diff.
 *
 * That is a DIFFERENT concern from the one this audit exists for. The rule here
 * is that the host must never INVOKE a plugin by a hard-coded id or tool name —
 * and that rule still holds in this file, which is why the exemption lists only
 * plugin-id needles. The tool-name needles (`work_assistant`, `msgraph_`,
 * `agent_hub`) stay forbidden everywhere, this file included.
 */
const ALLOWED_FILE_LITERALS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["plugins/isolation/out-of-process-plugins.ts", new Set(["work-assistant"])],
]);

function listSourceFiles(dir: string): string[] {
  const entries = readdirSync(dir);
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      if (entry === "__tests__") continue;
      if (ALLOWED_DIRS.has(entry)) continue;
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
      const allowed = ALLOWED_FILE_LITERALS.get(
        relative(SRC_ROOT, file).split(sep).join("/"),
      );
      for (const forbidden of FORBIDDEN_LIVE_APP_LITERALS) {
        if (allowed?.has(forbidden.needle)) continue;
        if (content.includes(forbidden.needle)) {
          violations.push(`${relative(SRC_ROOT, file)} contains '${forbidden.needle}' — ${forbidden.reason}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
