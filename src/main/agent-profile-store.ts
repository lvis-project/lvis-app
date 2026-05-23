/**
 * AgentProfileStore — user-defined sub-agent profile discovery.
 *
 * Profiles live under `~/.lvis/agents/` as markdown files with frontmatter.
 * Supported layouts:
 *   - `~/.lvis/agents/<name>.md`
 *   - `~/.lvis/agents/<name>/AGENTS.md`
 *
 * The body is used as the sub-agent profile prompt when `agent_spawn` is
 * invoked with `agentName`.
 */
import { readFile, readdir, realpath } from "node:fs/promises";
import { resolve, join, relative, isAbsolute } from "node:path";
import type { Dirent } from "node:fs";
import { createLogger } from "../lib/logger.js";
import { lvisHome } from "../shared/lvis-home.js";

const log = createLogger("lvis");

export const AGENT_NAME_ALLOWLIST = /^[a-zA-Z0-9_-]+$/;
const AGENT_PROFILE_MAX_BODY_BYTES = 16 * 1024;

export interface AgentProfileFrontmatter {
  name: string;
  description?: string;
  tools?: string[];
  triggers?: string[];
  model?: string;
  mode?: string;
}

export interface LoadedAgentProfile {
  name: string;
  description: string;
  sourceTools: string[];
  triggers: string[];
  model?: string;
  mode?: string;
  body: string;
  filePath: string;
}

export interface AgentProfileStoreOptions {
  userDir?: string;
}

const USER_AGENTS_DIR = resolve(lvisHome(), "agents");

export function parseAgentFrontmatter(raw: string): {
  fm: AgentProfileFrontmatter;
  body: string;
} {
  const fmRegex = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?/;
  const match = raw.match(fmRegex);
  if (!match) {
    return { fm: { name: "" }, body: raw };
  }
  const [full, block] = match;
  const body = raw.slice(full.length);
  const fm: AgentProfileFrontmatter = { name: "" };
  for (const line of block.split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    const val = m[2].trim().replace(/^["']|["']$/g, "");
    if (key === "name") fm.name = val;
    else if (key === "description") fm.description = val;
    else if (key === "model") fm.model = val;
    else if (key === "mode") fm.mode = val;
    else if (key === "tools") fm.tools = parseStringList(m[2]);
    else if (key === "triggers") fm.triggers = parseStringList(m[2]);
  }
  return { fm, body };
}

function parseStringList(raw: string): string[] {
  const trimmed = raw.trim();
  const inner = trimmed.startsWith("[") && trimmed.endsWith("]")
    ? trimmed.slice(1, -1)
    : trimmed;
  return inner
    .split(",")
    .map((s) => s.trim().replace(/^["']|["']$/g, ""))
    .filter((s) => s.length > 0);
}

export class AgentProfileStore {
  private readonly userDir: string;

  constructor(opts: AgentProfileStoreOptions = {}) {
    this.userDir = opts.userDir ?? USER_AGENTS_DIR;
  }

  async list(): Promise<LoadedAgentProfile[]> {
    let entries: Dirent[];
    try {
      entries = await readdir(this.userDir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }

    let realDir: string;
    try {
      realDir = await realpath(this.userDir);
    } catch {
      realDir = resolve(this.userDir);
    }

    const profiles: LoadedAgentProfile[] = [];
    for (const entry of entries) {
      const candidate = this.agentCandidate(entry);
      if (!candidate) continue;
      const { baseName, filePath } = candidate;
      if (!AGENT_NAME_ALLOWLIST.test(baseName)) {
        log.warn(`agent profile scan: rejected non-allowlist entry: ${entry.name}`);
        continue;
      }

      let realFile: string;
      try {
        realFile = await realpath(join(this.userDir, filePath));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
          log.warn(
            `agent profile scan: realpath failed for ${filePath}: %s`,
            (err as Error).message,
          );
        }
        continue;
      }
      const rel = relative(realDir, realFile);
      if (rel.startsWith("..") || isAbsolute(rel)) {
        log.warn(
          `agent profile scan: rejected traversal — ${filePath} -> ${realFile} escapes ${realDir}`,
        );
        continue;
      }

      try {
        const raw = await readFile(realFile, "utf-8");
        const { fm, body } = parseAgentFrontmatter(raw);
        const name = fm.name || baseName;
        if (!AGENT_NAME_ALLOWLIST.test(name)) {
          log.warn(
            `agent profile scan: rejected non-allowlist frontmatter name "${name}" in ${realFile}`,
          );
          continue;
        }
        const trimmedBody = body.trim();
        if (Buffer.byteLength(trimmedBody, "utf-8") > AGENT_PROFILE_MAX_BODY_BYTES) {
          log.warn(
            `agent profile scan: rejected oversized body for ${realFile} (>${AGENT_PROFILE_MAX_BODY_BYTES} bytes)`,
          );
          continue;
        }
        profiles.push({
          name,
          description: fm.description ?? "",
          sourceTools: fm.tools?.filter((t) => AGENT_NAME_ALLOWLIST.test(t)) ?? [],
          triggers: fm.triggers ?? [],
          model: fm.model,
          mode: fm.mode,
          body: trimmedBody,
          filePath: realFile,
        });
      } catch (err) {
        log.warn(
          `agent profile load failed for ${realFile}: %s`,
          (err as Error).message,
        );
      }
    }

    const byName = new Map<string, LoadedAgentProfile>();
    for (const profile of profiles) byName.set(profile.name, profile);
    return [...byName.values()];
  }

  async load(name: string): Promise<LoadedAgentProfile | null> {
    if (!AGENT_NAME_ALLOWLIST.test(name)) return null;
    const all = await this.list();
    return all.find((a) => a.name === name) ?? null;
  }

  private agentCandidate(entry: Dirent): { baseName: string; filePath: string } | null {
    if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
      return {
        baseName: entry.name.replace(/\.md$/i, ""),
        filePath: entry.name,
      };
    }
    if (entry.isDirectory()) {
      return {
        baseName: entry.name,
        filePath: join(entry.name, "AGENTS.md"),
      };
    }
    return null;
  }
}
