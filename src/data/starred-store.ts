/**
 * Starred Message Store
 *
 * 사용자가 "즐겨찾기"한 메시지를 ~/.lvis/starred.json 에 영속화.
 * 세션 간 공유되어 사이드바의 "즐겨찾기" 탭에 전체 목록을 노출한다.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createLogger } from "../lib/logger.js";
import { lvisHome } from "../shared/lvis-home.js";
const log = createLogger("starred-store");

export interface StarredMessage {
  /** unique id (uuid) */
  id: string;
  /** owning session id */
  sessionId: string;
  /** 0-based index within that session's message array at star time */
  messageIndex: number;
  /** "user" | "assistant" */
  role: string;
  /** snapshot of message text (may be truncated in UI) */
  text: string;
  /** iso timestamp */
  starredAt: string;
}

export interface StarredStoreOptions {
  /** override path for tests */
  filePath?: string;
}

export class StarredStore {
  private readonly filePath: string;
  private cache: StarredMessage[] = [];

  constructor(options?: StarredStoreOptions) {
    this.filePath = resolve(options?.filePath ?? join(lvisHome(), "starred.json"));
    this.load();
  }

  private load(): void {
    try {
      if (!existsSync(this.filePath)) {
        this.cache = [];
        return;
      }
      const raw = readFileSync(this.filePath, "utf-8").trim();
      if (!raw) {
        this.cache = [];
        return;
      }
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) {
        const valid: StarredMessage[] = [];
        for (const item of parsed) {
          if (
            item &&
            typeof item === "object" &&
            typeof (item as StarredMessage).id === "string" &&
            typeof (item as StarredMessage).sessionId === "string" &&
            typeof (item as StarredMessage).messageIndex === "number" &&
            typeof (item as StarredMessage).role === "string" &&
            typeof (item as StarredMessage).text === "string" &&
            typeof (item as StarredMessage).starredAt === "string"
          ) {
            valid.push(item as StarredMessage);
          } else {
            log.warn({ item }, "skipping invalid entry");
          }
        }
        this.cache = valid;
      } else {
        this.cache = [];
      }
    } catch {
      this.cache = [];
    }
  }

  private persist(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(this.cache, null, 2), "utf-8");
  }

  list(): StarredMessage[] {
    return [...this.cache].sort((a, b) => b.starredAt.localeCompare(a.starredAt));
  }

  listBySession(sessionId: string): StarredMessage[] {
    return this.cache.filter((m) => m.sessionId === sessionId);
  }

  add(entry: Omit<StarredMessage, "id" | "starredAt"> & { id?: string; starredAt?: string }): StarredMessage {
    const id = entry.id ?? crypto.randomUUID();
    const starredAt = entry.starredAt ?? new Date().toISOString();
    const existing = this.cache.find(
      (m) => m.sessionId === entry.sessionId && m.messageIndex === entry.messageIndex,
    );
    if (existing) return existing;
    const record: StarredMessage = {
      id,
      sessionId: entry.sessionId,
      messageIndex: entry.messageIndex,
      role: entry.role,
      text: entry.text,
      starredAt,
    };
    this.cache.push(record);
    this.persist();
    return record;
  }

  remove(id: string): boolean {
    const prev = this.cache.length;
    this.cache = this.cache.filter((m) => m.id !== id);
    if (this.cache.length !== prev) {
      this.persist();
      return true;
    }
    return false;
  }

  removeBySessionAndIndex(sessionId: string, messageIndex: number): boolean {
    const prev = this.cache.length;
    this.cache = this.cache.filter(
      (m) => !(m.sessionId === sessionId && m.messageIndex === messageIndex),
    );
    if (this.cache.length !== prev) {
      this.persist();
      return true;
    }
    return false;
  }

  clear(): void {
    this.cache = [];
    this.persist();
  }
}
