/**
 * RoutineSessionStore — main-process only.
 *
 * Manages per-routine JSONL session files under:
 *   ~/.lvis/routine-sessions/<routineId>/<firedAt-ts>.jsonl
 *
 * Each file is mode 0o600, parent dir mode 0o700, written atomically.
 * Q9 isolation: routine sessions never write to ~/.lvis/sessions/ (main chat).
 */
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const DEFAULT_SESSIONS_ROOT = resolve(homedir(), ".lvis", "routine-sessions");

export interface RoutineSessionRecord {
  routineId: string;
  firedAt: string;
  jsonlPath: string;
}

export class RoutineSessionStore {
  private readonly sessionsRoot: string;

  constructor(sessionsRoot: string = DEFAULT_SESSIONS_ROOT) {
    this.sessionsRoot = sessionsRoot;
  }

  /**
   * Create a new session file for the given routineId fired at firedAt (ISO string).
   * Returns the absolute path to the created JSONL file.
   */
  async createSession(routineId: string, firedAt: string): Promise<string> {
    const dir = join(this.sessionsRoot, sanitizeId(routineId));
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const ts = firedAt.replace(/[:.]/g, "-").replace(/[^a-zA-Z0-9\-_]/g, "");
    const filePath = join(dir, `${ts}.jsonl`);
    // Create empty file with restricted permissions.
    await writeFile(filePath, "", { encoding: "utf-8", mode: 0o600 });
    return filePath;
  }

  /**
   * List recent session records for a routine, newest first.
   * limit defaults to 10.
   */
  async listRecent(routineId: string, limit = 10): Promise<RoutineSessionRecord[]> {
    const dir = join(this.sessionsRoot, sanitizeId(routineId));
    if (!existsSync(dir)) return [];
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return [];
    }
    const jsonlFiles = entries
      .filter((f) => f.endsWith(".jsonl"))
      .sort()
      .reverse()
      .slice(0, limit);
    return jsonlFiles.map((f) => ({
      routineId,
      firedAt: fileNameToFiredAt(f),
      jsonlPath: join(dir, f),
    }));
  }

  /**
   * Delete all JSONL files for a routine (called when routine is removed).
   */
  async purgeRoutine(routineId: string): Promise<void> {
    const dir = join(this.sessionsRoot, sanitizeId(routineId));
    if (!existsSync(dir)) return;
    try {
      await rm(dir, { recursive: true, force: true });
    } catch {
      // Non-fatal — orphan cleanup is best-effort.
    }
  }

  /**
   * Extract a ~200-codepoint summary from a routine session JSONL file.
   *
   * Reads the last assistant message text from the JSONL, collapses
   * newlines to spaces, and caps at 200 codepoints with an ellipsis.
   * Returns an empty string when the file is empty or has no assistant text.
   */
  async extractSummary(jsonlPath: string): Promise<string> {
    let raw: string;
    try {
      raw = await readFile(jsonlPath, { encoding: "utf-8" });
    } catch {
      return "";
    }
    const lines = raw.split("\n").filter((l) => l.trim().length > 0);
    // Scan from tail — last assistant message text wins.
    let lastAssistantText = "";
    for (let i = lines.length - 1; i >= 0; i--) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(lines[i]);
      } catch {
        continue;
      }
      if (
        parsed !== null &&
        typeof parsed === "object" &&
        (parsed as Record<string, unknown>)["role"] === "assistant"
      ) {
        const content = (parsed as Record<string, unknown>)["content"];
        if (typeof content === "string" && content.length > 0) {
          lastAssistantText = content;
          break;
        }
        // Anthropic-style content array: [{type:"text", text:"..."}]
        if (Array.isArray(content)) {
          for (let j = content.length - 1; j >= 0; j--) {
            const block = content[j] as Record<string, unknown>;
            if (block["type"] === "text" && typeof block["text"] === "string" && block["text"].length > 0) {
              lastAssistantText = block["text"] as string;
              break;
            }
          }
          if (lastAssistantText) break;
        }
      }
    }
    if (!lastAssistantText) return "";
    // Collapse newlines → spaces, then cap at 200 codepoints.
    const collapsed = lastAssistantText.replace(/[\r\n]+/g, " ").trim();
    const codepoints = [...collapsed];
    if (codepoints.length <= 200) return collapsed;
    return codepoints.slice(0, 200).join("") + "…";
  }

  /**
   * Validate that a given path is within the sessions root (path traversal guard).
   * Returns true if safe, false if the path escapes the root.
   */
  isPathSafe(filePath: string): boolean {
    const resolved = resolve(filePath);
    const root = resolve(this.sessionsRoot);
    return resolved.startsWith(root + "/") || resolved === root;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Strip characters that are unsafe in directory names. */
function sanitizeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9\-_]/g, "_").slice(0, 128);
}

/** Convert filename like "2026-05-08T09-00-00-000Z.jsonl" back to an ISO-ish string. */
function fileNameToFiredAt(filename: string): string {
  return filename.replace(".jsonl", "").replace(/-(\d{3})Z$/, ".$1Z").replace(/T(\d{2})-(\d{2})-(\d{2})/, "T$1:$2:$3");
}
