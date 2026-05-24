/**
 * PersonaPromptStore — user-editable main-agent persona prompts.
 *
 * Personas live under `~/.lvis/prompts/` as markdown files with frontmatter.
 * The main composer can select one persona per turn. Agent profiles and skills
 * are intentionally not part of this store: agents belong to `agent_spawn`,
 * while skills are loaded by `skill_load` after the normal approval path.
 */
import { readFile, readdir, realpath, rm } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { createLogger } from "../lib/logger.js";
import { openFeatureNamespace, writeFileAtomicAtPath } from "./storage/feature-namespace.js";

const log = createLogger("lvis");

export const PERSONA_PROMPT_ID_ALLOWLIST = /^[a-zA-Z0-9_-]+$/;
const PERSONA_PROMPT_MAX_BODY_BYTES = 8 * 1024;
const USER_PROMPTS_NAMESPACE = openFeatureNamespace("prompts");

export interface PersonaPromptFrontmatter {
  id: string;
  name: string;
  description?: string;
}

export interface PersonaPrompt {
  id: string;
  name: string;
  description: string;
  systemPromptAdd: string;
  filePath: string;
}

export interface PersonaPromptStoreOptions {
  userDir?: string;
}

export function parsePersonaPromptFrontmatter(raw: string): {
  fm: PersonaPromptFrontmatter;
  body: string;
} {
  const fmRegex = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?/;
  const match = raw.match(fmRegex);
  if (!match) {
    return { fm: { id: "", name: "" }, body: raw };
  }
  const [full, block] = match;
  const body = raw.slice(full.length);
  const fm: PersonaPromptFrontmatter = { id: "", name: "" };
  for (const line of block.split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    const val = m[2].trim().replace(/^["']|["']$/g, "");
    if (key === "id") fm.id = val;
    else if (key === "name") fm.name = val;
    else if (key === "description") fm.description = val;
  }
  return { fm, body };
}

export function renderPersonaPromptFile(prompt: Pick<PersonaPrompt, "id" | "name" | "description" | "systemPromptAdd">): string {
  const lines = [
    "---",
    `id: ${prompt.id}`,
    `name: ${prompt.name}`,
  ];
  if (prompt.description.trim()) {
    lines.push(`description: ${prompt.description.trim()}`);
  }
  lines.push("---", "", prompt.systemPromptAdd.trim(), "");
  return lines.join("\n");
}

export class PersonaPromptStore {
  private readonly userDir: string;

  constructor(opts: PersonaPromptStoreOptions = {}) {
    this.userDir = opts.userDir ?? USER_PROMPTS_NAMESPACE.dir;
  }

  async list(): Promise<PersonaPrompt[]> {
    let entries: Dirent[];
    try {
      entries = await readdir(this.userDir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }

    let canonicalDir: string;
    try {
      canonicalDir = await realpath(this.userDir);
    } catch {
      canonicalDir = resolve(this.userDir);
    }

    const prompts: PersonaPrompt[] = [];
    for (const entry of entries) {
      const candidate = this.promptCandidate(entry);
      if (!candidate) continue;
      const { baseId, filePath } = candidate;
      if (!PERSONA_PROMPT_ID_ALLOWLIST.test(baseId)) {
        log.warn(`persona prompt scan: rejected non-allowlist entry: ${entry.name}`);
        continue;
      }

      let canonicalFile: string;
      try {
        canonicalFile = await realpath(join(this.userDir, filePath));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
          log.warn(
            `persona prompt scan: realpath failed for ${filePath}: %s`,
            (err as Error).message,
          );
        }
        continue;
      }
      const rel = relative(canonicalDir, canonicalFile);
      if (rel.startsWith("..") || isAbsolute(rel)) {
        log.warn(
          `persona prompt scan: rejected traversal — ${filePath} -> ${canonicalFile} escapes ${canonicalDir}`,
        );
        continue;
      }

      try {
        const raw = await readFile(canonicalFile, "utf-8");
        const { fm, body } = parsePersonaPromptFrontmatter(raw);
        const id = fm.id || baseId;
        if (!PERSONA_PROMPT_ID_ALLOWLIST.test(id) || id === "default") {
          log.warn(
            `persona prompt scan: rejected invalid frontmatter id "${id}" in ${canonicalFile}`,
          );
          continue;
        }
        const name = fm.name.trim() || id;
        const trimmedBody = body.trim();
        if (Buffer.byteLength(trimmedBody, "utf-8") > PERSONA_PROMPT_MAX_BODY_BYTES) {
          log.warn(
            `persona prompt scan: rejected oversized body for ${canonicalFile} (>${PERSONA_PROMPT_MAX_BODY_BYTES} bytes)`,
          );
          continue;
        }
        prompts.push({
          id,
          name: sanitizePersonaName(name),
          description: fm.description?.trim() ?? "",
          systemPromptAdd: trimmedBody,
          filePath: canonicalFile,
        });
      } catch (err) {
        log.warn(
          `persona prompt load failed for ${canonicalFile}: %s`,
          (err as Error).message,
        );
      }
    }

    const byId = new Map<string, PersonaPrompt>();
    for (const prompt of prompts) byId.set(prompt.id, prompt);
    return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  async get(id: string): Promise<PersonaPrompt | null> {
    const trimmed = id.trim();
    if (!PERSONA_PROMPT_ID_ALLOWLIST.test(trimmed) || trimmed === "default") {
      throw new Error("invalid persona prompt id");
    }
    return (await this.list()).find((prompt) => prompt.id === trimmed) ?? null;
  }

  async save(input: {
    id: string;
    name: string;
    description?: string;
    systemPromptAdd: string;
  }): Promise<PersonaPrompt> {
    const id = input.id.trim();
    if (!PERSONA_PROMPT_ID_ALLOWLIST.test(id) || id === "default") {
      throw new Error("invalid persona prompt id");
    }
    const name = sanitizePersonaName(input.name);
    const systemPromptAdd = input.systemPromptAdd.trim();
    if (!name) throw new Error("persona prompt name is required");
    if (!systemPromptAdd) throw new Error("persona prompt body is required");
    if (Buffer.byteLength(systemPromptAdd, "utf-8") > PERSONA_PROMPT_MAX_BODY_BYTES) {
      throw new Error(`persona prompt body exceeds ${PERSONA_PROMPT_MAX_BODY_BYTES} bytes`);
    }

    const filePath = join(this.userDir, `${id}.md`);
    const prompt: PersonaPrompt = {
      id,
      name,
      description: input.description?.trim() ?? "",
      systemPromptAdd,
      filePath,
    };
    await writeFileAtomicAtPath(filePath, renderPersonaPromptFile(prompt));
    return prompt;
  }

  async delete(id: string): Promise<boolean> {
    const trimmed = id.trim();
    if (!PERSONA_PROMPT_ID_ALLOWLIST.test(trimmed) || trimmed === "default") {
      throw new Error("invalid persona prompt id");
    }
    const prompt = (await this.list()).find((item) => item.id === trimmed);
    if (!prompt) return false;
    await rm(prompt.filePath);
    return true;
  }

  private promptCandidate(entry: Dirent): { baseId: string; filePath: string } | null {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".md")) return null;
    return {
      baseId: entry.name.replace(/\.md$/i, ""),
      filePath: entry.name,
    };
  }
}

function sanitizePersonaName(value: string): string {
  return value.replace(/[\r\n"\\<>]/g, " ").slice(0, 80).trim();
}
