/**
 * Memory Manager — §5 경량 기억 구조
 *
 * ~/.lvis/ 파일 기반 메모리 시스템.
 * - LVIS.md: 프로젝트·조직 컨텍스트 (관리자 배포 가능)
 * - user-preferences.md: 사용자 개인 선호
 * - memory/: 사용자 축적 메모 ("이거 기억해")
 * - sessions/: 대화 세션 JSONL *
 * 설계 원칙 (§5.1):
 * - 단순함 우선: 별도 기억 엔진·승격·만료 로직 없음
 * - 사용자 제어: 직접 확인·편집·삭제 가능
 * - 세션 독립: 파일은 영속, 인메모리는 휘발
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, unlinkSync, statSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import { homedir } from "node:os";
import { withFileLock } from "../lib/with-file-lock.js";

export interface MemoryManagerOptions {
  /** ~/.lvis 기본, 테스트 시 override */
  lvisDir?: string;
}

export interface NoteEntry {
  filename: string;
  title: string;
  content: string;
  updatedAt?: string;
  excerpt?: string;
}

export interface SessionSearchEntry {
  sessionId: string;
  matchedMessage: string;
  timestamp: string;
}

export interface SessionListEntry {
  id: string;
  modifiedAt: Date;
  title: string;
  preview: string;
  routineId?: string;
  routineTitle?: string;
}

export interface SessionMetadata {
  routineId?: string;
  routineTitle?: string;
}

const MEMORY_MARKER = "<!-- lvis:kind=memory -->";

const DEFAULT_LVIS_MD = `# LVIS 컨텍스트

> 이 파일은 LVIS 에이전트에게 프로젝트·조직·팀 컨텍스트를 전달합니다.
> 관리자가 배포하거나, 사용자가 직접 편집할 수 있습니다.

## 조직 정보

(여기에 팀·부서·프로젝트 정보를 기입하세요)

## 업무 규칙

(반복적으로 지켜야 하는 규칙이나 가이드라인)
`;

const DEFAULT_USER_PREFS = `# 사용자 선호

> LVIS가 참고하는 개인 선호 설정입니다. 자유롭게 편집하세요.

## 커뮤니케이션 스타일

- 한국어로 답변
- 간결한 설명 선호

## 자주 쓰는 도구

(자주 사용하는 플러그인, 도구, 명령어 등)
`;

const MAX_SESSION_FILE_BYTES = 5_000_000;

export class MemoryManager {
  private readonly lvisDir: string;
  private readonly memoryDir: string;
  private readonly sessionsDir: string;
  // 부팅 시 로드되어 캐시되는 영속 기억
  private lvisMd: string = "";
  private userPreferences: string = "";

  constructor(options?: MemoryManagerOptions) {
    this.lvisDir = resolve(options?.lvisDir ?? join(homedir(), ".lvis"));
    this.memoryDir = join(this.lvisDir, "memory");
    this.sessionsDir = join(this.lvisDir, "sessions");
    this.ensureStructure();
  }

  /** 부팅 시 호출 — 영속 기억을 메모리에 로드 */
  load(): void {
    this.lvisMd = this.readFile("LVIS.md");
    this.userPreferences = this.readFile("user-preferences.md");
  }

  // ─── Read API (SystemPromptBuilder에서 사용) ──────

  getLvisMd(): string {
    return this.lvisMd;
  }

  getUserPreferences(): string {
    return this.userPreferences;
  }

  /** memory/ 전체 목록 반환 */
  listMemoryEntries(): NoteEntry[] {
    return this.readMarkdownEntries(this.memoryDir);
  }

  /** memory/ 키워드 검색 — Agent Loop에서 on-demand 참조 (§5 참조 방식). Cap 50. */
  searchMemoryEntries(query: string): NoteEntry[] {
    return this.searchEntries(this.listMemoryEntries(), query);
  }

  /** sessions/ 키워드 검색 — D5 메모리 검색 패널용. Cap 50. */
  searchSessions(query: string): SessionSearchEntry[] {
    // Require at least 2 chars to prevent accidental full-dump via empty/trivial query.
    if (query.trim().length < 2) return [];
    if (!existsSync(this.sessionsDir)) return [];
    const lower = query.toLowerCase();
    const results: SessionSearchEntry[] = [];
    const UUID_RE = /^[0-9a-f-]{8,}$/i;
    const files = readdirSync(this.sessionsDir).filter((f) => f.endsWith(".jsonl"));
    for (const file of files) {
      if (results.length >= 50) break;
      const stem = file.replace(".jsonl", "");
      // Skip files whose stem is not UUID-shaped — prevents path-traversal info leak.
      if (!UUID_RE.test(stem)) continue;
      const filePath = join(this.sessionsDir, file);
      const stat = statSync(filePath);
      // Skip oversized files — unbounded readFileSync is a DoS vector.
        if (stat.size > MAX_SESSION_FILE_BYTES) continue;
      const timestamp = stat.mtime.toISOString();
      try {
        const raw = readFileSync(filePath, "utf-8");
        const lines = raw.trim().split("\n").filter(Boolean);
        for (const line of lines) {
          if (results.length >= 50) break;
          let msg: unknown;
          try { msg = JSON.parse(line); } catch { continue; }
          const content = (msg as Record<string, unknown>)?.content;
          if (typeof content === "string") {
            const idx = content.toLowerCase().indexOf(lower);
            if (idx !== -1) {
              // Excerpt: ±100 chars centred on match, max 200 chars total.
              const start = Math.max(0, idx - 100);
              const end = Math.min(content.length, idx + lower.length + 100);
              const excerpt = content.slice(start, end);
              results.push({ sessionId: stem, matchedMessage: excerpt, timestamp });
              break; // one match per session
            }
          }
        }
      } catch {
        // skip unreadable files
      }
    }
    return results;
  }

  /** memory/ 전체를 하나의 문자열로 — SystemPromptBuilder에서 사용 */
  getMemoryContext(): string {
    return this.buildMarkdownContext(this.listMemoryEntries());
  }

  /** sessions/ 최근 목록 — 검색 전에도 항목을 확인할 수 있도록 최근 세션을 노출한다. */
  listSessionEntries(limit = 50): SessionSearchEntry[] {
    const UUID_RE = /^[0-9a-f-]{8,}$/i;
    return this.listSessions(limit)
      .filter((session) => UUID_RE.test(session.id))
      .map((session) => ({
        sessionId: session.id,
        matchedMessage: session.preview,
        timestamp: session.modifiedAt.toISOString(),
      }));
  }

  // ─── Write API ("이거 기억해" 명령) ───────────────

  /** 메모 저장 — 사용자가 "기억해" 하면 memory/에 저장 */
  async saveMemory(title: string, content: string): Promise<NoteEntry> {
    const filename = this.slugify(title) + ".md";
    const visibleContent = `# ${title}\n\n${content}\n`;
    const storedContent = `${MEMORY_MARKER}\n${visibleContent}`;
    const targetPath = join(this.memoryDir, filename);
    await withFileLock(targetPath, async () => {
      writeFileSync(targetPath, storedContent, "utf-8");
    });
    return { filename, title, content: visibleContent, updatedAt: new Date().toISOString() };
  }

  /** 메모 삭제 */
  deleteMemory(filename: string): void {
    const path = join(this.memoryDir, filename);
    if (existsSync(path)) unlinkSync(path);
  }

  /** LVIS.md 업데이트 */
  async updateLvisMd(content: string): Promise<void> {
    const targetPath = join(this.lvisDir, "LVIS.md");
    await withFileLock(targetPath, async () => {
      writeFileSync(targetPath, content, "utf-8");
    });
    this.lvisMd = content;
  }

  /** user-preferences.md 업데이트 */
  async updateUserPreferences(content: string): Promise<void> {
    const targetPath = join(this.lvisDir, "user-preferences.md");
    await withFileLock(targetPath, async () => {
      writeFileSync(targetPath, content, "utf-8");
    });
    this.userPreferences = content;
  }

  /** ~/.lvis/ 경로 반환 */
  getDir(): string {
    return this.lvisDir;
  }

  // ─── Private ──────────────────────────────────────

  // ─── Session Persistence (§5.2 ~/.lvis/sessions/) ─

  /** 세션 저장 — JSONL 형식 (§4.5.7) */
  async saveSession(sessionId: string, messages: unknown[]): Promise<void> {
    const targetPath = join(this.sessionsDir, `${sessionId}.jsonl`);
    const lines = messages.map((m) => JSON.stringify(m)).join("\n") + "\n";
    await withFileLock(targetPath, async () => {
      writeFileSync(targetPath, lines, "utf-8");
    });
  }

  /** 세션 복원 */
  loadSession(sessionId: string): unknown[] | null {
    const path = join(this.sessionsDir, `${sessionId}.jsonl`);
    if (!existsSync(path)) return null;
    const lines = readFileSync(path, "utf-8").trim().split("\n");
    const messages: unknown[] = [];
    for (const line of lines.filter(Boolean)) {
      try {
        messages.push(JSON.parse(line));
      } catch {
        console.warn("[memory] skipping malformed session line", { sessionId });
      }
    }
    return messages;
  }

  async saveSessionMetadata(sessionId: string, metadata: SessionMetadata): Promise<void> {
    const targetPath = join(this.sessionsDir, `${sessionId}.meta.json`);
    await withFileLock(targetPath, async () => {
      writeFileSync(targetPath, JSON.stringify(metadata, null, 2), "utf-8");
    });
  }

  loadSessionMetadata(sessionId: string): SessionMetadata | null {
    const path = join(this.sessionsDir, `${sessionId}.meta.json`);
    if (!existsSync(path)) return null;
    try {
      const parsed = JSON.parse(readFileSync(path, "utf-8")) as SessionMetadata;
      if (!parsed || typeof parsed !== "object") return null;
      return {
        routineId: typeof parsed.routineId === "string" ? parsed.routineId : undefined,
        routineTitle: typeof parsed.routineTitle === "string" ? parsed.routineTitle : undefined,
      };
    } catch (err) {
      // Round-3 §7: surface metadata parse/IO failures as a warning so a
      // corrupted .meta.json doesn't silently surface as "no metadata".
      // Error semantics are preserved (still returns null) — only the
      // diagnostic surface is added.
      console.warn(`[memory] loadSessionMetadata failed for ${sessionId}:`, (err as Error).message);
      return null;
    }
  }

  /** 세션 목록 */
  listSessions(limit = Number.POSITIVE_INFINITY): SessionListEntry[] {
    if (!existsSync(this.sessionsDir)) return [];
    return readdirSync(this.sessionsDir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => {
        const stat = statSync(join(this.sessionsDir, f));
        return {
          id: f.replace(".jsonl", ""),
          modifiedAt: stat.mtime,
          size: stat.size,
        };
      })
      .sort((a, b) => b.modifiedAt.getTime() - a.modifiedAt.getTime())
      .slice(0, Number.isFinite(limit) ? Math.max(0, limit) : undefined)
      .map((session) => {
        const metadata = this.loadSessionMetadata(session.id);
        const summary = session.size > MAX_SESSION_FILE_BYTES
          ? {
              title: metadata?.routineTitle
                ? `${metadata.routineTitle} 대화`
                : `세션 ${session.id.slice(0, 8)}`,
              preview: "(대화가 커서 미리보기를 생략했습니다)",
            }
          : this.readSessionSummary(session.id);
        return {
          id: session.id,
          modifiedAt: session.modifiedAt,
          title: summary.title || metadata?.routineTitle || `세션 ${session.id.slice(0, 8)}`,
          preview: summary.preview,
          routineId: metadata?.routineId,
          routineTitle: metadata?.routineTitle,
        };
      });
  }

  listSessionsByRoutine(routineId: string, limit = Number.POSITIVE_INFINITY): SessionListEntry[] {
    return this.listSessions()
      .filter((session) => session.routineId === routineId)
      .slice(0, Number.isFinite(limit) ? Math.max(0, limit) : undefined);
  }

  /** 세션 삭제 */
  deleteSession(sessionId: string): void {
    const path = join(this.sessionsDir, `${sessionId}.jsonl`);
    if (existsSync(path)) unlinkSync(path);
  }

  private ensureStructure(): void {
    mkdirSync(this.memoryDir, { recursive: true });
    mkdirSync(this.sessionsDir, { recursive: true });

    const lvisMdPath = join(this.lvisDir, "LVIS.md");
    if (!existsSync(lvisMdPath)) {
      writeFileSync(lvisMdPath, DEFAULT_LVIS_MD, "utf-8");
    }

    const userPrefsPath = join(this.lvisDir, "user-preferences.md");
    if (!existsSync(userPrefsPath)) {
      writeFileSync(userPrefsPath, DEFAULT_USER_PREFS, "utf-8");
    }
  }

  private readFile(name: string): string {
    const path = join(this.lvisDir, name);
    if (!existsSync(path)) return "";
    return readFileSync(path, "utf-8");
  }

  private buildMarkdownContext(entries: NoteEntry[]): string {
    if (entries.length === 0) return "";
    return entries
      .map((n) => `### ${n.title}\n${n.content}`)
      .join("\n\n---\n\n");
  }

  private readMarkdownEntries(dir: string, options?: { excludeMarkedMemory?: boolean }): NoteEntry[] {
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => f.endsWith(".md"))
      .flatMap((filename) => {
        const path = join(dir, filename);
        const stat = statSync(path);
        const rawContent = readFileSync(path, "utf-8");
        if (options?.excludeMarkedMemory && this.hasMemoryMarker(rawContent)) return [];
        const content = this.stripInternalMarkers(rawContent);
        const titleMatch = content.match(/^#\s+(.+)/m);
        return [{
          filename,
          title: titleMatch?.[1] ?? filename.replace(".md", ""),
          content,
          updatedAt: stat.mtime.toISOString(),
        }];
      })
      .sort((a, b) => new Date(b.updatedAt ?? 0).getTime() - new Date(a.updatedAt ?? 0).getTime());
  }

  private searchEntries(entries: NoteEntry[], query: string): NoteEntry[] {
    const lower = query.toLowerCase();
    return entries.filter(
      (note) =>
        note.title.toLowerCase().includes(lower) ||
        note.content.toLowerCase().includes(lower),
    ).slice(0, 50);
  }

  private hasMemoryMarker(content: string): boolean {
    return content.startsWith(`${MEMORY_MARKER}\n`) || content === MEMORY_MARKER;
  }

  private stripInternalMarkers(content: string): string {
    return content.replace(/^<!--\s*lvis:kind=memory\s*-->\r?\n?/, "");
  }

  private readSessionSummary(sessionId: string): { title: string; preview: string } {
    const messages = this.loadSession(sessionId);
    if (!Array.isArray(messages)) {
      return {
        title: `세션 ${sessionId.slice(0, 8)}`,
        preview: "(내용 없음)",
      };
    }

    let lastUser = "";
    let lastContent = "";
    for (const message of messages) {
      const role = (message as Record<string, unknown>)?.role;
      const content = (message as Record<string, unknown>)?.content;
      if (typeof content !== "string" || content.trim().length === 0) continue;
      const normalized = content.replace(/\s+/g, " ").trim();
      lastContent = normalized;
      if (role === "user") lastUser = normalized;
    }

    return {
      title: (lastUser || lastContent || `세션 ${sessionId.slice(0, 8)}`).slice(0, 80),
      preview: (lastContent || lastUser || "(내용 없음)").slice(0, 200),
    };
  }

  private slugify(title: string): string {
    return title
      .toLowerCase()
      .replace(/[^a-z0-9가-힣\s-]/g, "")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .slice(0, 60) || "untitled";
  }
}
