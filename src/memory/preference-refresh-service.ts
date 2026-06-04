import type { IdleSchedulerService } from "../main/idle-scheduler.js";
import { createLogger } from "../lib/logger.js";
import type { MemoryManager } from "./memory-manager.js";

const log = createLogger("preference-refresh");

export type GenerateText = (
  prompt: string,
  opts?: { maxTokens?: number; systemPrompt?: string },
) => Promise<string>;

export interface PreferenceRefreshResult {
  content: string;
  refreshedAt: string;
  sources: string[];
}

export interface PreferenceRefreshOptions {
  reason: "manual" | "idle";
}

interface PreferenceSource {
  label: string;
  content: string;
  link: string;
}

export class PreferenceRefreshService {
  private running: Promise<PreferenceRefreshResult> | null = null;
  private lastIdleRefreshAt = 0;
  private lastIdleFailureAt = 0;
  private disposeIdleListener: (() => void) | null = null;

  constructor(private readonly deps: {
    memoryManager: MemoryManager;
    generateText: GenerateText;
    idleScheduler?: IdleSchedulerService;
    isIdleRefreshEnabled?: () => boolean;
    minIdleRefreshIntervalMs?: number;
    minIdleFailureBackoffMs?: number;
  }) {}

  start(): void {
    if (this.disposeIdleListener || !this.deps.idleScheduler) return;
    this.disposeIdleListener = this.deps.idleScheduler.addStateChangeListener((state) => {
      if (state !== "IDLE_SCAN") return;
      void this.refreshOnIdle();
    });
  }

  stop(): void {
    this.disposeIdleListener?.();
    this.disposeIdleListener = null;
  }

  async refresh(options: PreferenceRefreshOptions): Promise<PreferenceRefreshResult> {
    if (this.running) return this.running;
    this.running = this.refreshInternal(options).finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async refreshOnIdle(): Promise<void> {
    if (!this.deps.isIdleRefreshEnabled?.()) return;
    const minInterval = this.deps.minIdleRefreshIntervalMs ?? 60 * 60 * 1000;
    const failureBackoff = this.deps.minIdleFailureBackoffMs ?? 60 * 1000;
    const now = Date.now();
    if (now - this.lastIdleRefreshAt < minInterval) return;
    if (now - this.lastIdleFailureAt < failureBackoff) return;
    try {
      await this.refresh({ reason: "idle" });
      this.lastIdleRefreshAt = Date.now();
    } catch (err) {
      this.lastIdleFailureAt = Date.now();
      log.warn("idle preference refresh failed: %s", (err as Error).message);
    }
  }

  private async refreshInternal(_options: PreferenceRefreshOptions): Promise<PreferenceRefreshResult> {
    const userPreferencesBefore = this.deps.memoryManager.getUserPreferences();
    const sources = collectPreferenceSources(this.deps.memoryManager, userPreferencesBefore);
    const prompt = buildPreferencePrompt(sources);
    const raw = await this.deps.generateText(prompt, {
      maxTokens: 1600,
      systemPrompt:
        "You maintain LVIS user preferences. Extract durable, user-level preferences only. Do not invent facts.",
    });
    const content = stripNonPreferenceSections(sanitizeMarkdown(raw));
    const didUpdate = await this.deps.memoryManager.updateUserPreferencesIfUnchanged(userPreferencesBefore, content);
    if (!didUpdate) {
      throw new Error("user-preferences-changed-during-refresh");
    }

    return {
      content,
      refreshedAt: new Date().toISOString(),
      sources: sources.map((source) => source.link),
    };
  }
}

function collectPreferenceSources(
  memoryManager: MemoryManager,
  userPreferences: string,
): PreferenceSource[] {
  const memoryEntries = memoryManager
    .listMemoryEntries()
    .slice()
    .sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")))
    .slice(0, 12);

  return [
    { label: "AGENTS.md", content: memoryManager.getAgentsMd(), link: "~/.lvis/AGENTS.md" },
    { label: "Existing user-preferences.md", content: userPreferences, link: "~/.lvis/user-preferences.md" },
    { label: "memories/MEMORY.md", content: memoryManager.getMemoryIndex(), link: "~/.lvis/memories/MEMORY.md" },
    ...memoryEntries.map((entry) => ({
      label: `memory:${entry.title}`,
      content: entry.content,
      link: `~/.lvis/memories/${entry.filename}`,
    })),
  ].filter((source) => source.content.trim().length > 0);
}

function buildPreferencePrompt(sources: PreferenceSource[]): string {
  const sourceBlocks = sources
    .map((source, index) => (
      `<source id="${index + 1}" label="${escapeAttribute(source.label)}" link="${escapeAttribute(source.link)}">\n` +
      `${clip(source.content, 6000)}\n` +
      `</source>`
    ))
    .join("\n\n");

  return `Update ~/.lvis/user-preferences.md from the sources below.

Rules:
- Keep AGENTS.md as project/org/agent operating context, not personal preference.
- Keep MEMORY.md and memories/*.md as detailed episodic memory sources, not the compact profile itself.
- user-preferences.md must be a compact user profile: durable preferences, communication style, workflows, constraints, and dislikes.
- Do not include urgent memory, detailed memories, source links, references, or factual recollections; those belong in memories/*.md and memories/MEMORY.md.
- Do not include secrets, credentials, raw private data, or unsupported claims.
- If evidence conflicts, keep the newer or more explicit user-authored source and note uncertainty briefly.
- Return Markdown only. Do not wrap the answer in a code fence.

Required structure:
# User Preferences
## Summary
## Communication Style
## Workflow Preferences
## Standing Constraints

Sources:
${sourceBlocks}`;
}

function sanitizeMarkdown(raw: string): string {
  const trimmed = raw.trim();
  const fenceMatch = trimmed.match(/^```(?:markdown|md)?\s*([\s\S]*?)\s*```$/i);
  return (fenceMatch ? fenceMatch[1] : trimmed).trim();
}

function stripNonPreferenceSections(markdown: string): string {
  const lines = markdown.split(/\r?\n/);
  const kept: string[] = [];
  let skipping = false;
  for (const line of lines) {
    const heading = line.trim().match(/^##\s+(.+?)\s*$/);
    if (heading) {
      skipping = isNonPreferenceHeading(heading[1]);
    }
    if (!skipping) kept.push(line);
  }
  return `${kept.join("\n").replace(/\n{3,}/g, "\n\n").trim()}\n`;
}

function isNonPreferenceHeading(heading: string): boolean {
  const normalized = heading.trim().replace(/[:：]+$/, "").toLowerCase();
  return [
    "urgent memory",
    "source links",
    "sources",
    "references",
    "links",
    "memory",
    "detailed memory",
    "긴급 기억",
    "급히 기억할 내용",
    "출처",
    "레퍼런스",
    "링크",
    "메모리",
    "상세 기억",
  ].includes(normalized);
}

function clip(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars - 1).trimEnd()}...`;
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}
