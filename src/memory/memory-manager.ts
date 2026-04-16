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
import type { GenericMessage } from "../engine/llm/types.js";

export interface MemoryManagerOptions {
  /** ~/.lvis 기본, 테스트 시 override */
  lvisDir?: string;
}

export interface NoteEntry {
  filename: string;
  title: string;
  content: string;
}

export type SessionCategory = string;

export interface SessionSummary {
  id: string;
  modifiedAt: Date;
  category: SessionCategory;
  title: string;
  preview: string;
  messageCount: number;
}

interface SessionMetaFile {
  category?: SessionCategory;
  title?: string;
  preview?: string;
  messageCount?: number;
}

interface SaveSessionOptions {
  category?: SessionCategory;
}

const TOOL_CATEGORY_BY_PREFIX: Record<string, SessionCategory> = {
  meeting: "meeting",
  email: "email",
  calendar: "calendar",
  index: "pageindex",
};

const TOOL_CATEGORY_BY_NAME: Record<string, SessionCategory> = {
  chat_preview: "pageindex",
  knowledge_search: "pageindex",
  document_list: "pageindex",
  document_structure: "pageindex",
  document_page_content: "pageindex",
};

const _TEXT_CATEGORY_HINTS_UNUSED: Array<{ category: SessionCategory; tokens: string[] }> = [
  { category: "meeting", tokens: ["회의", "회의록", "미팅", "녹취", "meeting"] },
  { category: "email", tokens: ["메일", "이메일", "email", "outlook", "inbox"] },
  { category: "calendar", tokens: ["일정", "캘린더", "calendar", "event", "schedule"] },
  { category: "pageindex", tokens: ["문서", "자료", "검색", "index", "pageindex", "knowledge"] },
];

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
  saveSession(sessionId: string, messages: unknown[], options?: SaveSessionOptions): void {
    const path = join(this.sessionsDir, `${sessionId}.jsonl`);
    const lines = messages.map((m) => JSON.stringify(m)).join("\n") + "\n";
    writeFileSync(path, lines, "utf-8");
    const summary = this.buildSessionSummary(sessionId, messages as GenericMessage[], options);
    writeFileSync(this.getSessionMetaPath(sessionId), JSON.stringify(summary, null, 2), "utf-8");
  }

  /** 세션 복원 */
  loadSession(sessionId: string): unknown[] | null {
    const path = join(this.sessionsDir, `${sessionId}.jsonl`);
    if (!existsSync(path)) return null;
    const lines = readFileSync(path, "utf-8").trim().split("\n");
    return lines.filter(Boolean).map((line) => JSON.parse(line));
  }

  /** 세션 목록 */
  listSessions(): SessionSummary[] {
    if (!existsSync(this.sessionsDir)) return [];
    return readdirSync(this.sessionsDir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => {
        const stat = statSync(join(this.sessionsDir, f));
        const id = f.replace(".jsonl", "");
        const messages = this.loadSession(id) as GenericMessage[] | null;
        const summary = messages
          ? this.readSessionSummary(id, messages, stat.mtime)
          : {
              id,
              modifiedAt: stat.mtime,
              category: "general" as const,
              title: id,
              preview: "",
              messageCount: 0,
            };
        return summary;
      })
      .sort((a, b) => b.modifiedAt.getTime() - a.modifiedAt.getTime());
  }

  /** 세션 삭제 */
  deleteSession(sessionId: string): void {
    const path = join(this.sessionsDir, `${sessionId}.jsonl`);
    if (existsSync(path)) unlinkSync(path);
    const metaPath = this.getSessionMetaPath(sessionId);
    if (existsSync(metaPath)) unlinkSync(metaPath);
  }

  clearSessions(): void {
    if (!existsSync(this.sessionsDir)) return;
    for (const filename of readdirSync(this.sessionsDir)) {
      if (filename.endsWith(".jsonl") || filename.endsWith(".meta.json")) {
        unlinkSync(join(this.sessionsDir, filename));
      }
    }
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

  private getSessionMetaPath(sessionId: string): string {
    return join(this.sessionsDir, `${sessionId}.meta.json`);
  }

  private readSessionSummary(sessionId: string, messages: GenericMessage[], modifiedAt: Date): SessionSummary {
    const metaPath = this.getSessionMetaPath(sessionId);
    let meta: SessionMetaFile | null = null;
    if (existsSync(metaPath)) {
      try {
        meta = JSON.parse(readFileSync(metaPath, "utf-8")) as SessionMetaFile;
      } catch {
        meta = null;
      }
    }

    const inferred = this.inferSessionMeta(messages);
    return {
      id: sessionId,
      modifiedAt,
      category: meta?.category ?? inferred.category,
      title: meta?.title ?? inferred.title,
      preview: meta?.preview ?? inferred.preview,
      messageCount: meta?.messageCount ?? messages.length,
    };
  }

  private buildSessionSummary(
    sessionId: string,
    messages: GenericMessage[],
    options?: SaveSessionOptions,
  ): SessionMetaFile {
    const inferred = this.inferSessionMeta(messages);
    return {
      category: options?.category ?? inferred.category,
      title: inferred.title,
      preview: inferred.preview,
      messageCount: messages.length,
    };
  }

  private inferSessionMeta(messages: GenericMessage[]): Omit<SessionSummary, "id" | "modifiedAt" | "messageCount"> & { category: SessionCategory } {
    const firstUser = messages.find((message): message is Extract<GenericMessage, { role: "user" }> => message.role === "user");
    const firstAssistant = messages.find((message): message is Extract<GenericMessage, { role: "assistant" }> => message.role === "assistant" && !!message.content?.trim());

    const titleSource = firstUser?.content?.trim() || firstAssistant?.content?.trim() || "새 대화";
    const previewSource = firstAssistant?.content?.trim() || firstUser?.content?.trim() || "";

    return {
      category: this.inferCategoryFromMessages(messages),
      title: this.compactText(titleSource, 36),
      preview: this.compactText(previewSource, 80),
    };
  }

  private inferCategoryFromMessages(messages: GenericMessage[]): SessionCategory {
    for (const message of messages) {
      if (message.role === "assistant" && message.toolCalls?.length) {
        for (const toolCall of message.toolCalls) {
          const category = this.inferCategoryFromToolName(toolCall.name);
          if (category) return category;
        }
      }
      if (message.role === "tool_result") {
        const category = this.inferCategoryFromToolName(message.toolName);
        if (category) return category;
      }
    }

    const text = messages
      .filter((message): message is Extract<GenericMessage, { role: "user" | "assistant" }> => message.role !== "tool_result")
      .map((message) => message.content.toLowerCase())
      .join(" ");

    if (["회의", "회의록", "미팅", "녹취", "meeting"].some((token) => text.includes(token))) return "meeting";
    if (["메일", "이메일", "email", "outlook"].some((token) => text.includes(token))) return "email";
    return "general";
  }

  private inferCategoryFromToolName(toolName?: string): SessionCategory | null {
    if (!toolName) return null;
    if (TOOL_CATEGORY_BY_NAME[toolName]) {
      return TOOL_CATEGORY_BY_NAME[toolName];
    }

    const prefix = toolName.split("_")[0] ?? "";
    return TOOL_CATEGORY_BY_PREFIX[prefix] ?? null;
  }

  private compactText(value: string, maxLength: number): string {
    const compacted = value.replace(/\s+/g, " ").trim();
    if (compacted.length <= maxLength) return compacted;
    return `${compacted.slice(0, maxLength - 1)}…`;
  }
}
