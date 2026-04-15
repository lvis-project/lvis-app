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
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, unlinkSync, statSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import { homedir } from "node:os";

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

  /** notes/ 키워드 검색 — Agent Loop에서 on-demand 참조 (§5 참조 방식) */
  searchNotes(query: string): NoteEntry[] {
    const lower = query.toLowerCase();
    return this.listNotes().filter(
      (note) =>
        note.title.toLowerCase().includes(lower) ||
        note.content.toLowerCase().includes(lower),
    );
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
  saveNote(title: string, content: string): NoteEntry {
    const filename = this.slugify(title) + ".md";
    const fullContent = `# ${title}\n\n${content}\n`;
    writeFileSync(join(this.notesDir, filename), fullContent, "utf-8");
    return { filename, title, content: fullContent };
  }

  /** 메모 삭제 */
  deleteNote(filename: string): void {
    const path = join(this.notesDir, filename);
    if (existsSync(path)) unlinkSync(path);
  }

  /** LVIS.md 업데이트 */
  updateLvisMd(content: string): void {
    writeFileSync(join(this.lvisDir, "LVIS.md"), content, "utf-8");
    this.lvisMd = content;
  }

  /** user-preferences.md 업데이트 */
  updateUserPreferences(content: string): void {
    writeFileSync(join(this.lvisDir, "user-preferences.md"), content, "utf-8");
    this.userPreferences = content;
  }

  /** ~/.lvis/ 경로 반환 */
  getDir(): string {
    return this.lvisDir;
  }

  // ─── Private ──────────────────────────────────────

  // ─── Session Persistence (§5.2 ~/.lvis/sessions/) ─

  /** 세션 저장 — JSONL 형식 (§4.5.7) */
  saveSession(sessionId: string, messages: unknown[]): void {
    const path = join(this.sessionsDir, `${sessionId}.jsonl`);
    const lines = messages.map((m) => JSON.stringify(m)).join("\n") + "\n";
    writeFileSync(path, lines, "utf-8");
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
