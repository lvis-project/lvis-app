/**
 * Memory Manager — §5 경량 기억 구조
 *
 * ~/.lvis/ 파일 기반 메모리 시스템.
 * - LVIS.md: 프로젝트·조직 컨텍스트 (관리자 배포 가능)
 * - user-preferences.md: 사용자 개인 선호
 * - notes/: 사용자 축적 메모 ("이거 기억해")
 *
 * 설계 원칙 (§5.1):
 * - 단순함 우선: 별도 기억 엔진·승격·만료 로직 없음
 * - 사용자 제어: 직접 확인·편집·삭제 가능
 * - 세션 독립: 파일은 영속, 인메모리는 휘발
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, unlinkSync, statSync } from "node:fs";
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
}

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

export class MemoryManager {
  private readonly lvisDir: string;
  private readonly notesDir: string;
  private readonly sessionsDir: string;

  // 부팅 시 로드되어 캐시되는 영속 기억
  private lvisMd: string = "";
  private userPreferences: string = "";

  constructor(options?: MemoryManagerOptions) {
    this.lvisDir = resolve(options?.lvisDir ?? join(homedir(), ".lvis"));
    this.notesDir = join(this.lvisDir, "notes");
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

  /** notes/ 전체 목록 반환 */
  listNotes(): NoteEntry[] {
    if (!existsSync(this.notesDir)) return [];
    return readdirSync(this.notesDir)
      .filter((f) => f.endsWith(".md"))
      .map((filename) => {
        const content = readFileSync(join(this.notesDir, filename), "utf-8");
        const titleMatch = content.match(/^#\s+(.+)/m);
        return {
          filename,
          title: titleMatch?.[1] ?? filename.replace(".md", ""),
          content,
        };
      });
  }

  /** notes/ 키워드 검색 — Agent Loop에서 on-demand 참조 (§5 참조 방식). Cap 50. */
  searchNotes(query: string): NoteEntry[] {
    const lower = query.toLowerCase();
    return this.listNotes().filter(
      (note) =>
        note.title.toLowerCase().includes(lower) ||
        note.content.toLowerCase().includes(lower),
    ).slice(0, 50);
  }

  /** sessions/ 키워드 검색 — D5 메모리 검색 패널용. Cap 50. */
  searchSessions(query: string): Array<{ sessionId: string; matchedMessage: string; timestamp: string }> {
    // Require at least 2 chars to prevent accidental full-dump via empty/trivial query.
    if (query.trim().length < 2) return [];
    if (!existsSync(this.sessionsDir)) return [];
    const lower = query.toLowerCase();
    const results: Array<{ sessionId: string; matchedMessage: string; timestamp: string }> = [];
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
      if (stat.size > 5_000_000) continue;
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

  /** notes/ 전체를 하나의 문자열로 — SystemPromptBuilder에서 사용 */
  getNotesContext(): string {
    const notes = this.listNotes();
    if (notes.length === 0) return "";
    return notes
      .map((n) => `### ${n.title}\n${n.content}`)
      .join("\n\n---\n\n");
  }

  // ─── Write API ("이거 기억해" 명령) ───────────────

  /** 메모 저장 — 사용자가 "기억해" 하면 notes/에 저장 */
  async saveNote(title: string, content: string): Promise<NoteEntry> {
    const filename = this.slugify(title) + ".md";
    const fullContent = `# ${title}\n\n${content}\n`;
    const targetPath = join(this.notesDir, filename);
    await withFileLock(targetPath, async () => {
      writeFileSync(targetPath, fullContent, "utf-8");
    });
    return { filename, title, content: fullContent };
  }

  /** 메모 삭제 */
  deleteNote(filename: string): void {
    const path = join(this.notesDir, filename);
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

  // ─── Sprint E: Briefing feedback loop (user dissatisfaction → gradual tailoring) ─

  /**
   * 브리핑 dismiss 이유를 briefing-feedback.md 에 append.
   * Sprint E §2 — 사용자 피드백 루프. Proactive Engine 이 최근 5건을 읽어
   * LLM 프롬프트에 "User feedback memory:" 섹션으로 주입한다.
   */
  async appendBriefingFeedback(entry: {
    reason: "inaccurate" | "uninteresting" | "busy" | "other";
    details?: string;
    date?: string;
  }): Promise<void> {
    const date = entry.date ?? new Date().toISOString().slice(0, 10);
    const block =
      `---\n` +
      `date: ${date}\n` +
      `reason: ${entry.reason}\n` +
      `details: ${(entry.details ?? "").replace(/\r?\n/g, " ").trim()}\n` +
      `---\n\n`;
    const targetPath = join(this.notesDir, "briefing-feedback.md");
    await withFileLock(targetPath, async () => {
      if (!existsSync(targetPath)) {
        writeFileSync(
          targetPath,
          "# 브리핑 피드백 로그\n\n> 사용자가 브리핑을 닫을 때 남긴 이유가 기록됩니다. ProactiveEngine이 최근 5건을 LLM 컨텍스트에 주입합니다.\n\n" +
            block,
          "utf-8",
        );
      } else {
        appendFileSync(targetPath, block, "utf-8");
      }
    });
  }

  /** 최근 N건의 브리핑 피드백을 파싱해 반환 (신규가 마지막). */
  readRecentBriefingFeedback(limit = 5): Array<{ date: string; reason: string; details: string }> {
    const path = join(this.notesDir, "briefing-feedback.md");
    if (!existsSync(path)) return [];
    const content = readFileSync(path, "utf-8");
    const blocks = content.split(/^---\s*$/m);
    const out: Array<{ date: string; reason: string; details: string }> = [];
    for (const b of blocks) {
      const date = b.match(/date:\s*(.+)/)?.[1]?.trim();
      const reason = b.match(/reason:\s*(.+)/)?.[1]?.trim();
      if (!date || !reason) continue;
      const details = b.match(/details:\s*(.+)/)?.[1]?.trim() ?? "";
      out.push({ date, reason, details });
    }
    return out.slice(-limit);
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
    return lines.filter(Boolean).map((line) => JSON.parse(line));
  }

  /** 세션 목록 */
  listSessions(): Array<{ id: string; modifiedAt: Date }> {
    if (!existsSync(this.sessionsDir)) return [];
    return readdirSync(this.sessionsDir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => {
        const stat = statSync(join(this.sessionsDir, f));
        return { id: f.replace(".jsonl", ""), modifiedAt: stat.mtime };
      })
      .sort((a, b) => b.modifiedAt.getTime() - a.modifiedAt.getTime());
  }

  /** 세션 삭제 */
  deleteSession(sessionId: string): void {
    const path = join(this.sessionsDir, `${sessionId}.jsonl`);
    if (existsSync(path)) unlinkSync(path);
  }

  private ensureStructure(): void {
    mkdirSync(this.notesDir, { recursive: true });
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

  private slugify(title: string): string {
    return title
      .toLowerCase()
      .replace(/[^a-z0-9가-힣\s-]/g, "")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .slice(0, 60) || "untitled";
  }
}
